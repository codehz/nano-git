/**
 * fetch 编排单元测试
 *
 * 覆盖 refspec 解析、wants 确定和完整 fetch 流程。
 */

import { describe, test, expect } from "bun:test";
import {
  parseRefSpec,
  matchesRefSpec,
  mapRefName,
  determineWants,
  fetch,
} from "../../../src/transport/fetch.ts";
import type { RemoteRef } from "../../../src/transport/types.ts";
import type { RemoteTransport } from "../../../src/transport/types.ts";
import { sha1, type SHA1, type GitBlob } from "../../../src/core/types.ts";
import { createMemoryObjectStore } from "../../../src/odb/memory-store.ts";
import { createMemoryRefStore } from "../../../src/refs/stores/memory.ts";
import { toEncodedPackObject, buildEncodedPack } from "../../../src/odb/pack/pack-encoding.ts";

// ============================================================================
// 辅助函数
// ============================================================================

function makeRef(name: string, hash?: string): RemoteRef {
  return { name, hash: sha1(hash ?? "95d09f2b10159347eece71399a7e2e907ea3df4f") };
}

// ============================================================================
// RefSpec 解析
// ============================================================================

describe("parseRefSpec()", () => {
  test("默认 refspec", () => {
    const spec = parseRefSpec("+refs/heads/*:refs/remotes/origin/*");
    expect(spec.force).toBe(true);
    expect(spec.srcPattern).toBe("refs/heads/");
    expect(spec.dstPattern).toBe("refs/remotes/origin/");
  });

  test("无 force 的 refspec", () => {
    const spec = parseRefSpec("refs/heads/*:refs/remotes/upstream/*");
    expect(spec.force).toBe(false);
    expect(spec.srcPattern).toBe("refs/heads/");
    expect(spec.dstPattern).toBe("refs/remotes/upstream/");
  });

  test("无通配符的 refspec", () => {
    const spec = parseRefSpec("+refs/heads/main:refs/remotes/origin/main");
    expect(spec.force).toBe(true);
    expect(spec.srcPattern).toBe("refs/heads/main");
    expect(spec.dstPattern).toBe("refs/remotes/origin/main");
  });

  test("缺少冒号应抛出错误", () => {
    expect(() => parseRefSpec("refs/heads/main")).toThrow("Invalid refspec");
  });

  test("tag refspec", () => {
    const spec = parseRefSpec("+refs/tags/*:refs/tags/*");
    expect(spec.srcPattern).toBe("refs/tags/");
    expect(spec.dstPattern).toBe("refs/tags/");
    expect(spec.force).toBe(true);
  });
});

// ============================================================================
// 引用匹配
// ============================================================================

describe("matchesRefSpec / mapRefName", () => {
  const defaultSpec = parseRefSpec("+refs/heads/*:refs/remotes/origin/*");

  test("匹配 refs/heads 分支", () => {
    const ref = makeRef("refs/heads/main");
    expect(matchesRefSpec(ref, defaultSpec)).toBe(true);
  });

  test("不匹配 refs/tags", () => {
    const ref = makeRef("refs/tags/v1.0");
    expect(matchesRefSpec(ref, defaultSpec)).toBe(false);
  });

  test("映射 ref 名", () => {
    expect(mapRefName("refs/heads/main", defaultSpec)).toBe("refs/remotes/origin/main");
    expect(mapRefName("refs/heads/feature/xyz", defaultSpec)).toBe(
      "refs/remotes/origin/feature/xyz",
    );
  });
});

// ============================================================================
// Wants 确定
// ============================================================================

describe("determineWants()", () => {
  const hash1 = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
  const hash2 = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const defaultSpec = parseRefSpec("+refs/heads/*:refs/remotes/origin/*");

  test("初始 clone：所有分支都应 want，localHash 为 undefined", () => {
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
      makeRef("refs/heads/develop", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ];
    const wants = determineWants(refs, new Map(), [defaultSpec]);
    expect(wants).toHaveLength(2);
    expect(wants[0]!.localName).toBe("refs/remotes/origin/main");
    expect(wants[0]!.localHash).toBeUndefined();
    expect(wants[1]!.localName).toBe("refs/remotes/origin/develop");
    expect(wants[1]!.localHash).toBeUndefined();
  });

  test("本地已是最新则跳过", () => {
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
      makeRef("refs/heads/develop", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ];
    const localRefs = new Map<string, SHA1>([["refs/remotes/origin/main", hash1]]);
    const wants = determineWants(refs, localRefs, [defaultSpec]);
    // main 已是最新，只有 develop 需要拉取
    expect(wants).toHaveLength(1);
    expect(wants[0]!.localName).toBe("refs/remotes/origin/develop");
    expect(wants[0]!.localHash).toBeUndefined(); // develop 本地不存在
  });

  test("本地 hash 不同则应拉取并包含 localHash", () => {
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
    ];
    const localRefs = new Map<string, SHA1>([
      ["refs/remotes/origin/main", hash2], // 不同的 hash
    ]);
    const wants = determineWants(refs, localRefs, [defaultSpec]);
    expect(wants).toHaveLength(1);
    expect(wants[0]!.localHash).toBe(hash2); // 应返回本地旧 hash
  });

  test("空远程返回空 wants", () => {
    const wants = determineWants([], new Map(), [defaultSpec]);
    expect(wants).toHaveLength(0);
  });
});

// ============================================================================
// Fetch 函数（通过 mock transport 验证 haves）
// ============================================================================

describe("fetch() 增量 fetch 行为", () => {
  const oldHash = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
  const newHash = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

  function createBlobPackfile(content: string) {
    const blob: GitBlob = { type: "blob", content: Buffer.from(content) };
    const entry = toEncodedPackObject(blob);
    const packResult = buildEncodedPack([entry]);
    return { entry, packData: packResult.packData };
  }

  function createMockTransport(
    refs: RemoteRef[],
    caps: Record<string, string | true>,
    onUploadPack?: (body: Buffer) => Buffer,
  ): RemoteTransport {
    return {
      getReceivePackRefs: async () => {
        throw new Error("not used in fetch");
      },
      postReceivePack: async () => {
        throw new Error("not used in fetch");
      },
      getRefAdvertisement: async () => ({
        capabilities: caps,
        refs,
      }),
      postUploadPack: async (body: Buffer) => {
        const packfile = onUploadPack?.(body) ?? Buffer.alloc(0);
        return { packfile, progress: [] };
      },
    };
  }

  test("增量 fetch：当本地有旧 hash 时发送 have 行", async () => {
    const objectStore = createMemoryObjectStore();
    const refStore = createMemoryRefStore(new Map([["refs/remotes/origin/main", oldHash]]));

    const { entry, packData } = createBlobPackfile("incremental content");

    let capturedBody: Buffer | null = null;
    const transport = createMockTransport(
      [{ name: "refs/heads/main", hash: newHash }],
      { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
      (body) => {
        capturedBody = body;
        return packData;
      },
    );

    const result = await fetch(objectStore, refStore, "dummy", {
      transport,
      refSpecs: ["+refs/heads/*:refs/remotes/origin/*"],
    });

    // 请求体中必须包含 have 行，值为本地旧 hash
    expect(capturedBody).not.toBeNull();
    const bodyStr = capturedBody!.toString("utf-8");
    expect(bodyStr).toContain(`have ${oldHash}`);

    // 验证 ref 已更新
    const updatedRef = refStore.readRaw("refs/remotes/origin/main");
    expect(updatedRef).toBe(newHash);

    // 验证对象已写入（使用 packfile 中对象的哈希）
    expect(objectStore.exists(entry.hash)).toBe(true);

    // 验证 fetch result
    expect(result.objectCount).toBe(1);
    expect(result.fetchedRefs.get("refs/remotes/origin/main")).toBe(newHash);
  });

  test("首次 fetch（clone）：本地无旧 hash，不发送 haves", async () => {
    const objectStore = createMemoryObjectStore();
    const refStore = createMemoryRefStore(); // 空 refs

    const { entry, packData } = createBlobPackfile("clone content");

    let capturedBody: Buffer | null = null;
    const transport = createMockTransport(
      [{ name: "refs/heads/main", hash: newHash }],
      { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
      (body) => {
        capturedBody = body;
        return packData;
      },
    );

    const result = await fetch(objectStore, refStore, "dummy", {
      transport,
      refSpecs: ["+refs/heads/*:refs/remotes/origin/*"],
    });

    // 首次 clone 不应包含 have 行
    const bodyStr = capturedBody!.toString("utf-8");
    expect(bodyStr).not.toContain("have ");

    // 验证 ref 已创建
    expect(refStore.readRaw("refs/remotes/origin/main")).toBe(newHash);
    expect(objectStore.exists(entry.hash)).toBe(true);
    expect(result.objectCount).toBe(1);
  });

  test("远程无变化：wants 为空，不调用 postUploadPack", async () => {
    const objectStore = createMemoryObjectStore();
    const refStore = createMemoryRefStore(
      new Map([["refs/remotes/origin/main", newHash]]), // 与远程相同
    );

    let postUploadPackCalled = false;
    const transport = createMockTransport(
      [{ name: "refs/heads/main", hash: newHash }],
      { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
      (_body) => {
        postUploadPackCalled = true;
        return Buffer.alloc(0);
      },
    );

    const result = await fetch(objectStore, refStore, "dummy", {
      transport,
      refSpecs: ["+refs/heads/*:refs/remotes/origin/*"],
    });

    expect(postUploadPackCalled).toBe(false);
    expect(result.objectCount).toBe(0);
    expect(result.fetchedRefs.size).toBe(0);
  });

  test("shallow fetch：depth 传递到请求体中", async () => {
    const objectStore = createMemoryObjectStore();
    const refStore = createMemoryRefStore();

    const { entry, packData } = createBlobPackfile("shallow content");

    let capturedBody: Buffer | null = null;
    const transport = createMockTransport(
      [{ name: "refs/heads/main", hash: newHash }],
      { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
      (body) => {
        capturedBody = body;
        return packData;
      },
    );

    const result = await fetch(objectStore, refStore, "dummy", {
      transport,
      refSpecs: ["+refs/heads/*:refs/remotes/origin/*"],
      depth: 3,
    });

    // 请求体必须包含 deepen 命令
    const bodyStr = capturedBody!.toString("utf-8");
    expect(bodyStr).toContain("deepen 3\n");

    // 对象仍能正确写入
    expect(objectStore.exists(entry.hash)).toBe(true);
    expect(result.objectCount).toBe(1);
  });
});
