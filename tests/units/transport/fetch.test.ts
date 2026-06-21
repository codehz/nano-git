/**
 * fetch 编排单元测试
 *
 * 覆盖 refspec 解析、wants 确定和完整 fetch 流程。
 */

import { describe, test, expect } from "bun:test";

import { sha1, type SHA1, type GitBlob, type GitCommit } from "@/core/types.ts";
import { createMemoryObjectStore } from "@/odb/memory-store.ts";
import { toEncodedPackObject, buildEncodedPack } from "@/odb/pack/pack-encoding.ts";
import { createMemoryRefStore } from "@/refs/stores/memory.ts";
import {
  parseRefSpec,
  matchesRefSpec,
  mapRefName,
  determineWants,
  fetch,
} from "@/transport/fetch.ts";
import { parsePktLines } from "@/transport/pkt-line.ts";

import type { RemoteRef } from "@/transport/types.ts";
import type { RemoteTransport } from "@/transport/types.ts";

// ============================================================================
// 辅助函数
// ============================================================================

function makeRef(name: string, hash?: string): RemoteRef {
  return { name, hash: sha1(hash ?? "95d09f2b10159347eece71399a7e2e907ea3df4f") };
}

const TREE_PLACEHOLDER = sha1("0000000000000000000000000000000000000001");

/** 创建一个提交对象并写入 store */
function createTestCommit(
  store: ReturnType<typeof createMemoryObjectStore>,
  parents: SHA1[],
  timestamp: number,
  msg?: string,
): SHA1 {
  const commit: GitCommit = {
    type: "commit",
    tree: TREE_PLACEHOLDER,
    parents,
    author: { name: "T", email: "t@t", timestamp, timezone: "+0000" },
    committer: { name: "T", email: "t@t", timestamp, timezone: "+0000" },
    message: msg ?? `commit at ${timestamp}`,
  };
  return store.write(commit);
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
        return { data: packfile, packfile, progress: [] };
      },
    };
  }

  test("增量 fetch：Consecutive 算法发送完整 commit 链作为 haves", async () => {
    const objectStore = createMemoryObjectStore();

    // 构造本地已有提交链：c1(100) ← c2(200)
    const c1 = createTestCommit(objectStore, [], 100);
    const c2 = createTestCommit(objectStore, [c1], 200);

    // 远程最新 hash（c3，本地还没有）
    const c3 = createTestCommit(objectStore, [c2], 300);

    const refStore = createMemoryRefStore(new Map([["refs/remotes/origin/main", c2]]));
    const { entry, packData } = createBlobPackfile("incremental content");

    let capturedBody: Buffer | null = null;
    const transport = createMockTransport(
      [{ name: "refs/heads/main", hash: c3 }],
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

    // 请求体中必须包含 Consecutive 排序后的完整 commit 链
    expect(capturedBody).not.toBeNull();
    const bodyStr = capturedBody!.toString("utf-8");
    expect(bodyStr).toContain(`have ${c1}`);
    expect(bodyStr).toContain(`have ${c2}`);

    // 验证 ref 已更新
    const updatedRef = refStore.readRaw("refs/remotes/origin/main");
    expect(updatedRef).toBe(c3);

    expect(objectStore.exists(entry.hash)).toBe(true);
    expect(result.objectCount).toBe(1);
    expect(result.fetchedRefs.get("refs/remotes/origin/main")).toBe(c3);
  });

  test("增量 fetch：本地有多个祖先 commit，全部作为 haves 发送", async () => {
    const objectStore = createMemoryObjectStore();

    // 本地提交链：c1(100) ← c2(200) ← c3(300)，c3 是旧 tip
    const c1 = createTestCommit(objectStore, [], 100);
    const c2 = createTestCommit(objectStore, [c1], 200);
    const c3 = createTestCommit(objectStore, [c2], 300);

    // 远程在 c3 基础上新增 c4
    const c4 = createTestCommit(objectStore, [c3], 400);

    const refStore = createMemoryRefStore(new Map([["refs/remotes/origin/main", c3]]));
    const { entry, packData } = createBlobPackfile("more content");

    let capturedBody: Buffer | null = null;
    const transport = createMockTransport(
      [{ name: "refs/heads/main", hash: c4 }],
      { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
      (body) => {
        capturedBody = body;
        return packData;
      },
    );

    await fetch(objectStore, refStore, "dummy", {
      transport,
      refSpecs: ["+refs/heads/*:refs/remotes/origin/*"],
    });

    const bodyStr = capturedBody!.toString("utf-8");
    // 所有祖先都应出现在 haves 中
    expect(bodyStr).toContain(`have ${c1}`);
    expect(bodyStr).toContain(`have ${c2}`);
    expect(bodyStr).toContain(`have ${c3}`);
  });

  test("首次 fetch（clone）：本地无旧 hash，不发送 haves", async () => {
    const objectStore = createMemoryObjectStore();

    // 远程的 commit
    const remoteCommit = createTestCommit(objectStore, [], 100);
    const refStore = createMemoryRefStore(); // 空 refs

    const { entry, packData } = createBlobPackfile("clone content");

    let capturedBody: Buffer | null = null;
    const transport = createMockTransport(
      [{ name: "refs/heads/main", hash: remoteCommit }],
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
    expect(refStore.readRaw("refs/remotes/origin/main")).toBe(remoteCommit);
    expect(objectStore.exists(entry.hash)).toBe(true);
    expect(result.objectCount).toBe(1);
  });

  test("远程无变化：wants 为空，不调用 postUploadPack", async () => {
    const objectStore = createMemoryObjectStore();
    const localCommit = createTestCommit(objectStore, [], 100);
    const refStore = createMemoryRefStore(
      new Map([["refs/remotes/origin/main", localCommit]]), // 与远程相同
    );

    let postUploadPackCalled = false;
    const transport = createMockTransport(
      [{ name: "refs/heads/main", hash: localCommit }],
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

    const remoteCommit = createTestCommit(objectStore, [], 100);
    const { entry, packData } = createBlobPackfile("shallow content");

    let capturedBody: Buffer | null = null;
    const transport = createMockTransport(
      [{ name: "refs/heads/main", hash: remoteCommit }],
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

  test("Consecutive 协商：超过 32 个 haves 时分多轮发送，最后一轮带 done", async () => {
    const objectStore = createMemoryObjectStore();

    let head = createTestCommit(objectStore, [], 100);
    const allHaves: SHA1[] = [head];
    for (let i = 0; i < 35; i++) {
      head = createTestCommit(objectStore, [head], 101 + i);
      allHaves.push(head);
    }

    const remoteHead = createTestCommit(objectStore, [head], 1000);
    const refStore = createMemoryRefStore(new Map([["refs/remotes/origin/main", head]]));
    const { entry, packData } = createBlobPackfile("batched negotiation");

    const bodies: Buffer[] = [];
    let callCount = 0;
    const transport: RemoteTransport = {
      getReceivePackRefs: async () => {
        throw new Error("not used in fetch");
      },
      postReceivePack: async () => {
        throw new Error("not used in fetch");
      },
      getRefAdvertisement: async () => ({
        capabilities: { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
        refs: [{ name: "refs/heads/main", hash: remoteHead }],
      }),
      postUploadPack: async (body: Buffer) => {
        bodies.push(body);
        callCount++;

        if (callCount === 1) {
          return {
            data: Buffer.from(`003aACK ${allHaves[0]} continue\n0008NAK\n`, "utf-8"),
            packfile: Buffer.alloc(0),
            progress: [],
          };
        }

        return {
          data: packData,
          packfile: packData,
          progress: [],
        };
      },
    };

    const result = await fetch(objectStore, refStore, "dummy", {
      transport,
      refSpecs: ["+refs/heads/*:refs/remotes/origin/*"],
    });

    expect(bodies).toHaveLength(2);

    const firstLines = parsePktLines(bodies[0]!);
    const secondLines = parsePktLines(bodies[1]!);

    const firstData = firstLines
      .filter((line) => line.type === "data")
      .map((line) => line.payload.toString("utf-8").trimEnd());
    const secondData = secondLines
      .filter((line) => line.type === "data")
      .map((line) => line.payload.toString("utf-8").trimEnd());

    expect(firstData.filter((line) => line.startsWith("have "))).toHaveLength(32);
    expect(firstData.at(-1)).not.toBe("done");
    expect(firstLines.filter((line) => line.type === "flush")).toHaveLength(2);

    expect(secondData.filter((line) => line.startsWith("have "))).toHaveLength(4);
    expect(secondData.at(-1)).toBe("done");
    expect(secondLines.filter((line) => line.type === "flush")).toHaveLength(1);

    expect(objectStore.exists(entry.hash)).toBe(true);
    expect(result.objectCount).toBe(1);
  });
});
