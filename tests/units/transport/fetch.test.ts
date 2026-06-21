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
  FetchError,
  selectHaveTips,
  getLocalRefs,
} from "@/transport/fetch.ts";
import { encodeFlushPkt, encodePktLine, parsePktLines } from "@/transport/pkt-line.ts";

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

  // ========================================================================
  // 非法 refspec 校验
  // ========================================================================

  test("单边通配符（src 有 *、dst 无 *）应拒绝", () => {
    expect(() => parseRefSpec("refs/heads/*:refs/remotes/origin/main")).toThrow("Invalid refspec");
  });

  test("单边通配符（src 无 *、dst 有 *）应拒绝", () => {
    expect(() => parseRefSpec("refs/heads/main:refs/remotes/origin/*")).toThrow("Invalid refspec");
  });

  test("带 force 的单边通配符也应拒绝", () => {
    expect(() => parseRefSpec("+refs/heads/*:refs/remotes/origin/main")).toThrow("Invalid refspec");
  });

  test("通配符不在末尾（src 中间带 *）应拒绝", () => {
    expect(() => parseRefSpec("refs/heads/*/abc:refs/heads/*/xyz")).toThrow("Invalid refspec");
  });

  test("通配符不在末尾（src * 后有后缀）应拒绝", () => {
    expect(() => parseRefSpec("refs/heads/*extra:refs/heads/*")).toThrow("Invalid refspec");
  });

  test("通配符不在末尾（dst * 后有后缀）应拒绝", () => {
    expect(() => parseRefSpec("refs/heads/*:refs/heads/*extra")).toThrow("Invalid refspec");
  });

  test("多个通配符应拒绝", () => {
    expect(() => parseRefSpec("refs/heads/*/*:refs/heads/*/*")).toThrow("Invalid refspec");
  });

  test("删除 refspec（:refs/heads/feature）不受影响", () => {
    const spec = parseRefSpec(":refs/heads/feature");
    expect(spec.srcPattern).toBe("");
    expect(spec.dstPattern).toBe("refs/heads/feature");
    expect(spec.isWildcard).toBe(false);
  });

  test("精确 refspec 不受影响", () => {
    const spec = parseRefSpec("+refs/heads/main:refs/remotes/origin/main");
    expect(spec.isWildcard).toBe(false);
    expect(spec.srcPattern).toBe("refs/heads/main");
    expect(spec.dstPattern).toBe("refs/remotes/origin/main");
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

  test("精确 refspec 按字面匹配，不做前缀匹配", () => {
    const exactSpec = parseRefSpec("+refs/heads/main:refs/remotes/origin/main");
    const matchingRef = makeRef("refs/heads/main");
    const nonMatchingRef = makeRef("refs/heads/main-old");
    expect(matchesRefSpec(matchingRef, exactSpec)).toBe(true);
    expect(matchesRefSpec(nonMatchingRef, exactSpec)).toBe(false);
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
    expect(wants[0]!.force).toBe(true);
    expect(wants[1]!.localName).toBe("refs/remotes/origin/develop");
    expect(wants[1]!.localHash).toBeUndefined();
    expect(wants[1]!.force).toBe(true);
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
    expect(wants[0]!.force).toBe(true);
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
    expect(wants[0]!.force).toBe(true);
  });

  test("非强制 refspec 传递 force=false", () => {
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
    ];
    const nonForceSpec = parseRefSpec("refs/heads/*:refs/remotes/origin/*");
    const wants = determineWants(refs, new Map(), [nonForceSpec]);
    expect(wants).toHaveLength(1);
    expect(wants[0]!.force).toBe(false);
  });

  test("空远程返回空 wants", () => {
    const wants = determineWants([], new Map(), [defaultSpec]);
    expect(wants).toHaveLength(0);
  });

  test("精确 refspec 不会因前缀匹配引入多余 wants", () => {
    const exactSpec = parseRefSpec("+refs/heads/main:refs/remotes/origin/main");
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
      makeRef("refs/heads/main-old", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ];
    const wants = determineWants(refs, new Map(), [exactSpec]);
    expect(wants).toHaveLength(1);
    expect(wants[0]!.remote.name).toBe("refs/heads/main");
    expect(wants[0]!.localName).toBe("refs/remotes/origin/main");
  });

  test("重叠 refspec 应去重，同一 remote ref 只生成一个 want", () => {
    const wildSpec = parseRefSpec("+refs/heads/*:refs/remotes/origin/*");
    const exactSpec = parseRefSpec("+refs/heads/main:refs/remotes/origin/main");
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
      makeRef("refs/heads/develop", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ];
    const wants = determineWants(refs, new Map(), [wildSpec, exactSpec]);
    // main 和 develop 来自通配符，main 另由精确 spec 匹配但应去重
    // => main x1 + develop x1 = 2
    expect(wants).toHaveLength(2);
    const mainWants = wants.filter((w) => w.remote.name === "refs/heads/main");
    expect(mainWants).toHaveLength(1);
    const devWants = wants.filter((w) => w.remote.name === "refs/heads/develop");
    expect(devWants).toHaveLength(1);
  });

  describe("对象存在性校验", () => {
    const hash = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");

    test("hash 匹配且对象存在时跳过（不传 store 时保持向后兼容）", () => {
      const refs: RemoteRef[] = [makeRef("refs/heads/main", hash)];
      const localRefs = new Map<string, SHA1>([["refs/remotes/origin/main", hash]]);
      // 不传 store —— 旧行为，hash 匹配即跳过
      const wants = determineWants(refs, localRefs, [defaultSpec]);
      expect(wants).toHaveLength(0);
    });

    test("hash 匹配但对象不存在时仍产生 want", () => {
      const refs: RemoteRef[] = [makeRef("refs/heads/main", hash)];
      const localRefs = new Map<string, SHA1>([["refs/remotes/origin/main", hash]]);
      // 传一个空 store（什么都不存在）
      const wants = determineWants(refs, localRefs, [defaultSpec], createMemoryObjectStore());
      // 对象不存在，应仍产生 want
      expect(wants).toHaveLength(1);
      expect(wants[0]!.localName).toBe("refs/remotes/origin/main");
      expect(wants[0]!.localHash).toBe(hash);
      expect(wants[0]!.force).toBe(true);
    });

    test("hash 匹配且对象存在时跳过（传 store 且对象存在）", () => {
      const refs: RemoteRef[] = [makeRef("refs/heads/main", hash)];
      const localRefs = new Map<string, SHA1>([["refs/remotes/origin/main", hash]]);
      // 在 store 里写入一个假对象让 exists 返回 true
      const store = createMemoryObjectStore();
      const blob: GitBlob = { type: "blob", content: Buffer.from("dummy") };
      store.write(blob);
      // hash 对应的对象不存在于 store 中，所以仍应产生 want
      const wants = determineWants(refs, localRefs, [defaultSpec], store);
      // hash 是个假哈希，store 里没有，所以仍 want
      expect(wants).toHaveLength(1);
    });

    test("hash 匹配且对象确实存在时跳过", () => {
      const store = createMemoryObjectStore();
      // 写入真正的对象使 exists 返回 true
      const realHash = createTestCommit(store, [], 100);
      const realRefs: RemoteRef[] = [makeRef("refs/heads/main", realHash)];
      const realLocalRefs = new Map<string, SHA1>([["refs/remotes/origin/main", realHash]]);
      const wants = determineWants(realRefs, realLocalRefs, [defaultSpec], store);
      // 对象存在，应跳过
      expect(wants).toHaveLength(0);
    });
  });

  describe("store 参数向后兼容", () => {
    const hash = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");

    test("不传 store 时 behavior 不变", () => {
      const refs: RemoteRef[] = [makeRef("refs/heads/main", hash)];
      const localRefs = new Map<string, SHA1>([["refs/remotes/origin/main", hash]]);
      const wants = determineWants(refs, localRefs, [defaultSpec]);
      expect(wants).toHaveLength(0);
    });
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
    const updatedRef = refStore.read("refs/remotes/origin/main");
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
    const { packData } = createBlobPackfile("more content");

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
    expect(refStore.read("refs/remotes/origin/main")).toBe(remoteCommit);
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
      { multi_ack: true, "side-band-64k": true, "ofs-delta": true, shallow: true },
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

  test("shallow fetch：服务端未声明 shallow capability 时拒绝 depth", async () => {
    const objectStore = createMemoryObjectStore();
    const refStore = createMemoryRefStore();

    const remoteCommit = createTestCommit(objectStore, [], 100);
    const { packData } = createBlobPackfile("shallow content");

    const transport = createMockTransport(
      [{ name: "refs/heads/main", hash: remoteCommit }],
      { multi_ack: true, "side-band-64k": true, "ofs-delta": true }, // 不含 shallow
      () => packData,
    );

    const fetchPromise = fetch(objectStore, refStore, "dummy", {
      transport,
      refSpecs: ["+refs/heads/*:refs/remotes/origin/*"],
      depth: 1,
    });

    expect(fetchPromise).rejects.toThrow(FetchError);
    expect(fetchPromise).rejects.toThrow(/does not support shallow fetch/i);
  });

  test("shallow fetch：服务端未声明 shallow capability 时拒绝 shallow 边界", async () => {
    const objectStore = createMemoryObjectStore();
    const refStore = createMemoryRefStore();

    const remoteCommit = createTestCommit(objectStore, [], 100);
    const { packData } = createBlobPackfile("shallow boundary");

    const transport = createMockTransport(
      [{ name: "refs/heads/main", hash: remoteCommit }],
      { multi_ack: true, "side-band-64k": true, "ofs-delta": true }, // 不含 shallow
      () => packData,
    );

    const fetchPromise = fetch(objectStore, refStore, "dummy", {
      transport,
      refSpecs: ["+refs/heads/*:refs/remotes/origin/*"],
      shallow: [remoteCommit],
    });

    expect(fetchPromise).rejects.toThrow(FetchError);
    expect(fetchPromise).rejects.toThrow(/does not support shallow fetch/i);
  });

  test("shallow deepen：tip 无变化时仍发送 deepen 请求并返回 shallow/unshallow 信息", async () => {
    const objectStore = createMemoryObjectStore();

    // 构造本地已有提交链：c1(100) ← c2(200)
    const c1 = createTestCommit(objectStore, [], 100);
    const c2 = createTestCommit(objectStore, [c1], 200);

    // 模拟第一次 depth=1 fetch 后的状态：本地已有 c2（tip），c1 是 shallow 边界
    const refStore = createMemoryRefStore(new Map([["refs/remotes/origin/main", c2]]));

    // packfile 包含一个额外的 blob
    const blob: GitBlob = { type: "blob", content: Buffer.from("deepen content") };
    const entry = toEncodedPackObject(blob);
    const { packData } = buildEncodedPack([entry]);

    let capturedBody: Buffer | null = null;
    let postUploadPackCalled = false;

    const transport: RemoteTransport = {
      getReceivePackRefs: async () => {
        throw new Error("not used in fetch");
      },
      postReceivePack: async () => {
        throw new Error("not used in fetch");
      },
      getRefAdvertisement: async () => ({
        capabilities: {
          multi_ack: true,
          "side-band-64k": true,
          "ofs-delta": true,
          shallow: true,
        },
        // 远程广告的 hash 与本地相同 —— tip 无变化
        refs: [{ name: "refs/heads/main", hash: c2 }],
      }),
      postUploadPack: async (body: Buffer) => {
        postUploadPackCalled = true;
        capturedBody = body;
        // 模拟服务端返回 shallow 信息 + packfile
        const data = Buffer.concat([encodePktLine(`shallow ${c1}\n`), encodeFlushPkt(), packData]);
        return { data, packfile: packData, progress: [] };
      },
    };

    const result = await fetch(objectStore, refStore, "dummy", {
      transport,
      refSpecs: ["+refs/heads/*:refs/remotes/origin/*"],
      depth: 2,
      shallow: [c1],
    });

    // 必须调用了 postUploadPack（关键验证：不能因 wants 为空而提前返回）
    expect(postUploadPackCalled).toBe(true);

    // 请求体必须包含 deepen 和 shallow 行
    const bodyStr = capturedBody!.toString("utf-8");
    expect(bodyStr).toContain("deepen 2");
    expect(bodyStr).toContain(`shallow ${c1}`);

    // 对象被正常写入
    expect(objectStore.exists(entry.hash)).toBe(true);
    expect(result.objectCount).toBe(1);

    // ref 不应被报告为已更新（tip 无变化）
    expect(result.fetchedRefs.size).toBe(0);

    // ref 值不变
    expect(refStore.read("refs/remotes/origin/main")).toBe(c2);

    // 返回了 shallow 信息
    expect(result.shallow).toBeDefined();
    expect(result.shallow).toContain(c1);
  });

  test("shallow deepen：depth+shallow 都不设置时不受 shallow capability 校验影响", async () => {
    const objectStore = createMemoryObjectStore();
    const refStore = createMemoryRefStore();

    // commit 已写入 store（模拟之前已存在），pack 不含该 commit 也不影响
    const remoteCommit = createTestCommit(objectStore, [], 100);
    const blob: GitBlob = { type: "blob", content: Buffer.from("extra blob") };
    const entry = toEncodedPackObject(blob);
    const { packData } = buildEncodedPack([entry]);

    const transport = createMockTransport(
      [{ name: "refs/heads/main", hash: remoteCommit }],
      { multi_ack: true, "side-band-64k": true, "ofs-delta": true }, // 不含 shallow
      () => packData,
    );

    // 不传 depth/shallow，shallow capability 校验不应触发
    const result = await fetch(objectStore, refStore, "dummy", {
      transport,
      refSpecs: ["+refs/heads/*:refs/remotes/origin/*"],
    });

    expect(result.objectCount).toBe(1);
    expect(result.fetchedRefs.get("refs/remotes/origin/main")).toBe(remoteCommit);
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

  describe("fetch 后 ref 指向的目标对象存在性校验", () => {
    test("packfile 不含 tip 对象时整体失败并抛出 FetchError", async () => {
      const objectStore = createMemoryObjectStore();

      // 远程广告的 commit hash——但不把这个对象写入 store
      const fakeCommitHash = sha1("ffffffffffffffffffffffffffffffffffffffff");

      const refStore = createMemoryRefStore(); // 空 refs

      // packfile 只包含一个 blob，不包含 fakeCommitHash
      const blob: GitBlob = { type: "blob", content: Buffer.from("orphan blob") };
      const entry = toEncodedPackObject(blob);
      const { packData } = buildEncodedPack([entry]);

      const transport = createMockTransport(
        [{ name: "refs/heads/main", hash: fakeCommitHash }],
        { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
        () => packData,
      );

      const fetchPromise = fetch(objectStore, refStore, "dummy", {
        transport,
        refSpecs: ["+refs/heads/*:refs/remotes/origin/*"],
      });

      expect(fetchPromise).rejects.toThrow(FetchError);
      expect(fetchPromise).rejects.toThrow(/not received in the packfile/i);

      // blob 仍应被写入（对象写入发生在 ref 更新之前）
      expect(objectStore.exists(entry.hash)).toBe(true);

      // ref 不应被写入
      expect(refStore.read("refs/remotes/origin/main")).toBeNull();
    });

    test("packfile 包含 tip 对象时正常写入 ref", async () => {
      const objectStore = createMemoryObjectStore();

      // 把远程 commit 写入 store
      const remoteCommit = createTestCommit(objectStore, [], 100);

      const refStore = createMemoryRefStore(); // 空 refs

      // packfile 包含一个 blob
      const blob: GitBlob = { type: "blob", content: Buffer.from("some content") };
      const entry = toEncodedPackObject(blob);
      const { packData } = buildEncodedPack([entry]);

      const transport = createMockTransport(
        [{ name: "refs/heads/main", hash: remoteCommit }],
        { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
        () => packData,
      );

      const result = await fetch(objectStore, refStore, "dummy", {
        transport,
        refSpecs: ["+refs/heads/*:refs/remotes/origin/*"],
      });

      // blob 应被写入
      expect(objectStore.exists(entry.hash)).toBe(true);

      // 且远程 commit 存在，ref 应正常写入
      expect(refStore.read("refs/remotes/origin/main")).toBe(remoteCommit);
      expect(result.fetchedRefs.get("refs/remotes/origin/main")).toBe(remoteCommit);
    });

    test("多 ref：部分 tip 缺失时整体失败", async () => {
      const objectStore = createMemoryObjectStore();

      // 两个远程 tip：一个在 store 中（模拟 pack 中收到了），另一个是假的（未收到）
      const receivedCommit = createTestCommit(objectStore, [], 100);
      const missingHash = sha1("ffffffffffffffffffffffffffffffffffffffff");

      const refStore = createMemoryRefStore();

      const blob: GitBlob = { type: "blob", content: Buffer.from("extra data") };
      const entry = toEncodedPackObject(blob);
      const { packData } = buildEncodedPack([entry]);

      const transport = createMockTransport(
        [
          { name: "refs/heads/received", hash: receivedCommit },
          { name: "refs/heads/missing", hash: missingHash },
        ],
        { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
        () => packData,
      );

      const fetchPromise = fetch(objectStore, refStore, "dummy", {
        transport,
        refSpecs: [
          "+refs/heads/received:refs/remotes/origin/received",
          "+refs/heads/missing:refs/remotes/origin/missing",
        ],
      });

      expect(fetchPromise).rejects.toThrow(FetchError);
      expect(fetchPromise).rejects.toThrow(/refs\/heads\/missing/);

      // 已写入的对象不受影响
      expect(objectStore.exists(entry.hash)).toBe(true);

      // 但所有 ref（包括 tip 存在的）都应不更新
      expect(refStore.read("refs/remotes/origin/received")).toBeNull();
      expect(refStore.read("refs/remotes/origin/missing")).toBeNull();
    });

    test("pack 中途出错时已有对象不被写入 store（解析阶段原子性）", async () => {
      const objectStore = createMemoryObjectStore();
      const refStore = createMemoryRefStore();

      const blob1: GitBlob = { type: "blob", content: Buffer.from("first blob") };
      const entry1 = toEncodedPackObject(blob1);
      const blob2: GitBlob = { type: "blob", content: Buffer.from("second blob") };
      const entry2 = toEncodedPackObject(blob2);
      const blob3: GitBlob = { type: "blob", content: Buffer.from("third blob") };
      const entry3 = toEncodedPackObject(blob3);

      const { packData: fullPack } = buildEncodedPack([entry1, entry2, entry3]);

      // 截断 packfile——删除尾部 20 字节校验和+部分数据，使 parseAll 中途失败
      const truncatedPack = fullPack.subarray(0, fullPack.length - 30);

      const fakeCommitHash = sha1("ffffffffffffffffffffffffffffffffffffffff");
      const transport = createMockTransport(
        [{ name: "refs/heads/main", hash: fakeCommitHash }],
        { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
        () => Buffer.from(truncatedPack),
      );

      const fetchPromise = fetch(objectStore, refStore, "dummy", {
        transport,
        refSpecs: ["+refs/heads/*:refs/remotes/origin/*"],
      });

      expect(fetchPromise).rejects.toThrow();

      // 解析阶段原子性保障：pack 解析出错时尚未写入任何对象
      expect(objectStore.exists(entry1.hash)).toBe(false);
      expect(objectStore.exists(entry2.hash)).toBe(false);
      expect(objectStore.exists(entry3.hash)).toBe(false);
    });
  });

  describe("force 语义", () => {
    function createDivergedScenario(targetRefName: string = "refs/remotes/origin/main") {
      const objectStore = createMemoryObjectStore();

      // 本地分支：root ← oldTip
      const root = createTestCommit(objectStore, [], 100);
      const oldTip = createTestCommit(objectStore, [root], 200);

      // 远程分支：root ← remoteTip（与 oldTip 分叉，非快进）
      const remoteTip = createTestCommit(objectStore, [root], 300);

      // 先设置本地 ref 指向 oldTip
      const refStore = createMemoryRefStore(new Map([[targetRefName, oldTip]]));

      // 远程广告 refs/heads/main 指向 remoteTip
      const { packData } = createBlobPackfile("diverged content");

      const transport = createMockTransport(
        [{ name: "refs/heads/main", hash: remoteTip }],
        { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
        () => packData,
      );

      return { objectStore, refStore, transport, oldTip, remoteTip };
    }

    test("非强制 refspec：refs/heads/* 非快进更新被阻止", async () => {
      const { objectStore, refStore, transport, oldTip } =
        createDivergedScenario("refs/heads/main");

      // 使用不带 + 的 refspec，目标在 refs/heads/* 中
      const result = await fetch(objectStore, refStore, "dummy", {
        transport,
        refSpecs: ["refs/heads/*:refs/heads/*"],
      });

      // ref 应保持原值（非快进被拒绝）
      expect(refStore.read("refs/heads/main")).toBe(oldTip);
      expect(result.fetchedRefs.has("refs/heads/main")).toBe(false);
      // 对象仍被写入
      expect(result.objectCount).toBe(1);
    });

    test("非强制 refspec：refs/remotes/* 非快进更新仍被允许", async () => {
      const { objectStore, refStore, transport, remoteTip } = createDivergedScenario(
        "refs/remotes/origin/main",
      );

      // 使用不带 + 的 refspec，目标在 refs/remotes/* 中（Git 不要求 fast-forward）
      const result = await fetch(objectStore, refStore, "dummy", {
        transport,
        refSpecs: ["refs/heads/*:refs/remotes/origin/*"],
      });

      // ref 应更新——refs/remotes/* 不要求 fast-forward
      expect(refStore.read("refs/remotes/origin/main")).toBe(remoteTip);
      expect(result.fetchedRefs.get("refs/remotes/origin/main")).toBe(remoteTip);
      expect(result.objectCount).toBe(1);
    });

    test("非强制 refspec：自定义 namespace（refs/mirrors/*）非快进更新仍被允许", async () => {
      const { objectStore, refStore, transport, remoteTip } =
        createDivergedScenario("refs/mirrors/main");

      const result = await fetch(objectStore, refStore, "dummy", {
        transport,
        refSpecs: ["refs/heads/*:refs/mirrors/*"],
      });

      // ref 应更新——refs/mirrors/* 不要求 fast-forward
      expect(refStore.read("refs/mirrors/main")).toBe(remoteTip);
      expect(result.fetchedRefs.get("refs/mirrors/main")).toBe(remoteTip);
      expect(result.objectCount).toBe(1);
    });

    test("强制 refspec：非快进更新仍被允许", async () => {
      const { objectStore, refStore, transport, remoteTip } = createDivergedScenario();

      // 使用带 + 的 refspec
      const result = await fetch(objectStore, refStore, "dummy", {
        transport,
        refSpecs: ["+refs/heads/*:refs/remotes/origin/*"],
      });

      // ref 应更新为远程值
      expect(refStore.read("refs/remotes/origin/main")).toBe(remoteTip);
      expect(result.fetchedRefs.get("refs/remotes/origin/main")).toBe(remoteTip);
      expect(result.objectCount).toBe(1);
    });

    test("非强制 refspec：快进更新仍被允许", async () => {
      const objectStore = createMemoryObjectStore();

      // 本地分支：root ← oldTip
      const root = createTestCommit(objectStore, [], 100);
      const oldTip = createTestCommit(objectStore, [root], 200);

      // 远程分支：root ← oldTip ← remoteTip（快进）
      const remoteTip = createTestCommit(objectStore, [oldTip], 300);

      const refStore = createMemoryRefStore(new Map([["refs/remotes/origin/main", oldTip]]));
      const { packData } = createBlobPackfile("fast-forward content");

      const transport = createMockTransport(
        [{ name: "refs/heads/main", hash: remoteTip }],
        { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
        () => packData,
      );

      // 使用不带 + 的 refspec
      const result = await fetch(objectStore, refStore, "dummy", {
        transport,
        refSpecs: ["refs/heads/*:refs/remotes/origin/*"],
      });

      // ref 应更新为远程值（快进允许）
      expect(refStore.read("refs/remotes/origin/main")).toBe(remoteTip);
      expect(result.fetchedRefs.get("refs/remotes/origin/main")).toBe(remoteTip);
      expect(result.objectCount).toBe(1);
    });

    test("非强制 refspec：本地 ref 不存在时始终写入", async () => {
      const objectStore = createMemoryObjectStore();
      const remoteTip = createTestCommit(objectStore, [], 100);
      const refStore = createMemoryRefStore(); // 空 refs

      const { entry, packData } = createBlobPackfile("new ref content");

      const transport = createMockTransport(
        [{ name: "refs/heads/main", hash: remoteTip }],
        { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
        () => packData,
      );

      const result = await fetch(objectStore, refStore, "dummy", {
        transport,
        refSpecs: ["refs/heads/*:refs/remotes/origin/*"],
      });

      // 新 ref 应被创建
      expect(refStore.read("refs/remotes/origin/main")).toBe(remoteTip);
      expect(result.objectCount).toBe(1);
      expect(objectStore.exists(entry.hash)).toBe(true);
    });

    test("非强制 refspec：已有 lightweight tag 的 fast-forward update 被拒绝", async () => {
      const objectStore = createMemoryObjectStore();

      const root = createTestCommit(objectStore, [], 100);
      const oldTagHash = root;

      // 远程 tag 指向 root 的后代（fast-forward 关系）
      const remoteTag = createTestCommit(objectStore, [root], 200);

      const refStore = createMemoryRefStore(new Map([["refs/tags/v1", oldTagHash]]));
      const { packData } = createBlobPackfile("tag update content");

      const transport = createMockTransport(
        [{ name: "refs/tags/v1", hash: remoteTag }],
        { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
        () => packData,
      );

      const result = await fetch(objectStore, refStore, "dummy", {
        transport,
        refSpecs: ["refs/tags/*:refs/tags/*"],
      });

      // ref 应保持原值（不允许更新）
      expect(refStore.read("refs/tags/v1")).toBe(oldTagHash);
      expect(result.fetchedRefs.has("refs/tags/v1")).toBe(false);
      expect(result.objectCount).toBe(1);
    });

    test("强制 refspec：已有 lightweight tag 的 update 被允许", async () => {
      const objectStore = createMemoryObjectStore();

      const root = createTestCommit(objectStore, [], 100);
      const oldTagHash = root;
      const remoteTag = createTestCommit(objectStore, [root], 200);

      const refStore = createMemoryRefStore(new Map([["refs/tags/v1", oldTagHash]]));
      const { packData } = createBlobPackfile("force tag content");

      const transport = createMockTransport(
        [{ name: "refs/tags/v1", hash: remoteTag }],
        { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
        () => packData,
      );

      const result = await fetch(objectStore, refStore, "dummy", {
        transport,
        refSpecs: ["+refs/tags/*:refs/tags/*"],
      });

      expect(refStore.read("refs/tags/v1")).toBe(remoteTag);
      expect(result.fetchedRefs.get("refs/tags/v1")).toBe(remoteTag);
      expect(result.objectCount).toBe(1);
    });

    test("非强制 refspec：全新的 lightweight tag 仍可创建", async () => {
      const objectStore = createMemoryObjectStore();
      const remoteTag = createTestCommit(objectStore, [], 100);
      const refStore = createMemoryRefStore();

      const { packData } = createBlobPackfile("new tag content");

      const transport = createMockTransport(
        [{ name: "refs/tags/v2", hash: remoteTag }],
        { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
        () => packData,
      );

      const result = await fetch(objectStore, refStore, "dummy", {
        transport,
        refSpecs: ["refs/tags/*:refs/tags/*"],
      });

      expect(refStore.read("refs/tags/v2")).toBe(remoteTag);
      expect(result.fetchedRefs.get("refs/tags/v2")).toBe(remoteTag);
      expect(result.objectCount).toBe(1);
    });
  });
});

// ============================================================================
// selectHaveTips
// ============================================================================

describe("selectHaveTips()", () => {
  const hashA = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const hashB = sha1("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  const hashC = sha1("cccccccccccccccccccccccccccccccccccccccc");

  test("第一优先：wants 对应的 remote-tracking ref 旧值", () => {
    const localRefs = new Map<string, SHA1>([
      ["refs/remotes/origin/main", hashA],
      ["HEAD", hashB],
    ]);
    const wants = [
      {
        remote: makeRef("refs/heads/main"),
        localName: "refs/remotes/origin/main",
        localHash: hashA,
        force: true,
      },
    ];

    const tips = selectHaveTips(localRefs, wants);
    // hashA 应是第一个（第一优先）
    expect(tips[0]).toBe(hashA);
    // hashB 也会出现（第三优先 HEAD）
    expect(tips).toContain(hashB);
  });

  test("第二优先：同一远端命名空间下的其他 remote-tracking refs", () => {
    const localRefs = new Map<string, SHA1>([
      ["refs/remotes/origin/main", hashA],
      ["refs/remotes/origin/feature", hashB],
      ["refs/remotes/upstream/main", hashC],
    ]);
    const wants = [
      {
        remote: makeRef("refs/heads/main"),
        localName: "refs/remotes/origin/main",
        localHash: hashA,
        force: true,
      },
    ];

    const tips = selectHaveTips(localRefs, wants);
    // hashA 第一优先（wants 的 localHash）
    // hashB 第二优先（同一远端前缀 refs/remotes/origin/）
    // hashC 不应出现（不同远端前缀）
    expect(tips).toContain(hashA);
    expect(tips).toContain(hashB);
    expect(tips).not.toContain(hashC);
  });

  test("第三优先：HEAD", () => {
    const localRefs = new Map<string, SHA1>([
      ["refs/remotes/origin/main", hashA],
      ["HEAD", hashB],
      ["refs/heads/feature", hashC],
    ]);
    const wants = [
      {
        remote: makeRef("refs/heads/main"),
        localName: "refs/remotes/origin/main",
        localHash: hashA,
        force: true,
      },
    ];

    const tips = selectHaveTips(localRefs, wants);
    // hashA（第一优先）, hashB（第三优先 HEAD）, 然后 heads
    expect(tips.indexOf(hashA)).toBeLessThan(tips.indexOf(hashB)!);
    // HEAD 在 heads 之前
    expect(tips.indexOf(hashB)).toBeLessThan(tips.indexOf(hashC)!);
  });

  test("第四优先：本地 heads 兜底", () => {
    const localRefs = new Map<string, SHA1>([
      ["refs/heads/main", hashA],
      ["refs/heads/feature", hashB],
    ]);
    // 无 remote-tracking refs 且无 HEAD
    const wants: Array<{ remote: RemoteRef; localName: string; localHash?: SHA1; force: boolean }> =
      [];

    const tips = selectHaveTips(localRefs, wants);
    expect(tips).toContain(hashA);
    expect(tips).toContain(hashB);
  });

  test("不包含 tags 除非它们被 remote-tracking 覆盖", () => {
    const localRefs = new Map<string, SHA1>([
      ["refs/remotes/origin/main", hashA],
      ["refs/tags/v1.0", hashB],
      ["HEAD", hashC],
    ]);
    const wants = [
      {
        remote: makeRef("refs/heads/main"),
        localName: "refs/remotes/origin/main",
        localHash: hashA,
        force: true,
      },
    ];

    const tips = selectHaveTips(localRefs, wants);
    // hashB（tag）不应出现
    expect(tips).not.toContain(hashB);
  });

  test("wants 无 localHash 时从第二优先开始", () => {
    const localRefs = new Map<string, SHA1>([
      ["refs/remotes/origin/main", hashA],
      ["HEAD", hashB],
    ]);
    const wants = [
      {
        remote: makeRef("refs/heads/main"),
        localName: "refs/remotes/origin/main",
        force: true,
      },
    ];

    const tips = selectHaveTips(localRefs, wants);
    // 没有 localHash，直接跳到远程 tracking refs（第二优先）
    expect(tips).toContain(hashA);
    expect(tips).toContain(hashB);
  });

  test("去重：同一 hash 不会重复出现", () => {
    const localRefs = new Map<string, SHA1>([
      ["refs/remotes/origin/main", hashA],
      ["refs/heads/main", hashA], // 同一 hash
    ]);
    const wants = [
      {
        remote: makeRef("refs/heads/main"),
        localName: "refs/remotes/origin/main",
        localHash: hashA,
        force: true,
      },
    ];

    const tips = selectHaveTips(localRefs, wants);
    // hashA 只出现一次
    expect(tips.filter((h) => h === hashA)).toHaveLength(1);
  });
});

// ============================================================================
// getLocalRefs
// ============================================================================

describe("getLocalRefs()", () => {
  test("符号引用 HEAD 应解析为目标 ref 的哈希", () => {
    const hash = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const store = createMemoryRefStore(
      new Map([
        ["HEAD", "ref: refs/heads/main"],
        ["refs/heads/main", hash],
      ]),
    );

    const refs = getLocalRefs(store);
    expect(refs.get("HEAD")).toBe(hash);
  });

  test("分离头指针（detached HEAD）也应解析", () => {
    const hash = sha1("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    const store = createMemoryRefStore(new Map([["HEAD", hash]]));

    const refs = getLocalRefs(store);
    expect(refs.get("HEAD")).toBe(hash);
  });

  test("自定义命名空间 refs/mirrors/ 也能被 getLocalRefs 检测到", () => {
    const hash = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const store = createMemoryRefStore(
      new Map([
        ["HEAD", "ref: refs/heads/main"],
        ["refs/heads/main", hash],
        ["refs/mirrors/upstream/main", hash],
      ]),
    );

    const refs = getLocalRefs(store);
    expect(refs.get("HEAD")).toBe(hash);
    expect(refs.get("refs/heads/main")).toBe(hash);
    expect(refs.get("refs/mirrors/upstream/main")).toBe(hash);
  });
});

// ============================================================================
// getLocalRefs + determineWants 集成测试
// ============================================================================

describe("getLocalRefs + determineWants 自定义 namespace 集成", () => {
  test("自定义目标命名空间的本地已有 ref 应被检测到，localHash 正确设置", () => {
    const existingHash = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const newHash = sha1("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

    // 模拟本地已有 refs/mirrors/upstream/main
    const refs = createMemoryRefStore(
      new Map([
        ["refs/heads/main", existingHash],
        ["refs/mirrors/upstream/main", existingHash],
      ]),
    );

    const localRefs = getLocalRefs(refs);

    // refspec: refs/heads/main:refs/mirrors/upstream/main
    // 远程有更新的 hash，本地已有旧值 → localHash 应为 existingHash
    const spec = parseRefSpec("refs/heads/main:refs/mirrors/upstream/main");
    const remoteRef: RemoteRef[] = [{ name: "refs/heads/main", hash: newHash }];

    const wants = determineWants(remoteRef, localRefs, [spec]);

    expect(wants).toHaveLength(1);
    expect(wants[0]!.localName).toBe("refs/mirrors/upstream/main");
    // 这才是关键断言：localHash 应为 existingHash 而非 undefined
    expect(wants[0]!.localHash).toBe(existingHash);
  });
});

// ============================================================================
// fetch() refspec 未匹配远端引用时报错
// ============================================================================

describe("fetch() refspec 未匹配远端引用", () => {
  function createEmptyMockTransport(): RemoteTransport {
    return {
      getReceivePackRefs: async () => {
        throw new Error("not used in fetch");
      },
      postReceivePack: async () => {
        throw new Error("not used in fetch");
      },
      getRefAdvertisement: async () => ({
        capabilities: { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
        refs: [], // 空远端
      }),
      postUploadPack: async () => {
        throw new Error("should not be called");
      },
    };
  }

  test("显式非通配符 refspec 未匹配远端引用时抛出 FetchError", async () => {
    const objectStore = createMemoryObjectStore();
    const refStore = createMemoryRefStore();

    const fetchPromise = fetch(objectStore, refStore, "dummy", {
      transport: createEmptyMockTransport(),
      refSpecs: ["refs/heads/missing:refs/remotes/origin/missing"],
    });

    expect(fetchPromise).rejects.toThrow(/Couldn't find remote ref/i);
    expect(fetchPromise).rejects.toThrow(/refs\/heads\/missing/);
  });

  test("通配符 refspec 未匹配远端引用时静默通过（与默认行为一致）", async () => {
    const objectStore = createMemoryObjectStore();
    const refStore = createMemoryRefStore();

    const result = await fetch(objectStore, refStore, "dummy", {
      transport: createEmptyMockTransport(),
      refSpecs: ["+refs/heads/*:refs/remotes/origin/*"],
    });

    expect(result.objectCount).toBe(0);
    expect(result.fetchedRefs.size).toBe(0);
  });

  test("多个非通配符 refspec 中有一个未匹配也应报错", async () => {
    const objectStore = createMemoryObjectStore();
    const refStore = createMemoryRefStore();

    const fetchPromise = fetch(objectStore, refStore, "dummy", {
      transport: {
        getReceivePackRefs: async () => {
          throw new Error("not used in fetch");
        },
        postReceivePack: async () => {
          throw new Error("not used in fetch");
        },
        getRefAdvertisement: async () => ({
          capabilities: { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
          refs: [
            { name: "refs/heads/exists", hash: sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") },
          ],
        }),
        postUploadPack: async () => {
          return { data: Buffer.alloc(0), packfile: Buffer.alloc(0), progress: [] };
        },
      },
      refSpecs: [
        "refs/heads/exists:refs/remotes/origin/exists",
        "refs/heads/missing:refs/remotes/origin/missing",
      ],
    });

    expect(fetchPromise).rejects.toThrow(/Couldn't find remote ref/i);
    expect(fetchPromise).rejects.toThrow(/refs\/heads\/missing/);
  });

  test("显式非通配符 refspec 匹配到远端引用时不报错", async () => {
    const objectStore = createMemoryObjectStore();
    const refStore = createMemoryRefStore();

    // 创建远程 commit 和 packfile
    const remoteCommit = createTestCommit(objectStore, [], 100);

    const blob: GitBlob = { type: "blob", content: Buffer.from("test content") };
    const entry = toEncodedPackObject(blob);
    const { packData } = buildEncodedPack([entry]);

    const transport: RemoteTransport = {
      getReceivePackRefs: async () => {
        throw new Error("not used in fetch");
      },
      postReceivePack: async () => {
        throw new Error("not used in fetch");
      },
      getRefAdvertisement: async () => ({
        capabilities: { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
        refs: [{ name: "refs/heads/main", hash: remoteCommit }],
      }),
      postUploadPack: async () => {
        return { data: packData, packfile: packData, progress: [] };
      },
    };

    const result = await fetch(objectStore, refStore, "dummy", {
      transport,
      refSpecs: ["refs/heads/main:refs/remotes/origin/main"],
    });

    expect(result.objectCount).toBe(1);
    expect(result.fetchedRefs.get("refs/remotes/origin/main")).toBe(remoteCommit);
  });

  test("不传 refSpecs（使用默认 refspec）时远端为空不报错", async () => {
    const objectStore = createMemoryObjectStore();
    const refStore = createMemoryRefStore();

    const result = await fetch(objectStore, refStore, "dummy", {
      transport: createEmptyMockTransport(),
      // 不传 refSpecs，使用默认值
    });

    expect(result.objectCount).toBe(0);
    expect(result.fetchedRefs.size).toBe(0);
  });
});
