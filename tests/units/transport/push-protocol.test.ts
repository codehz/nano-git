/**
 * Push 高层行为单元测试
 *
 * 覆盖 push() 服务端响应完整性校验、determinePushRefs 去重、
 * 自定义命名空间推送、ng 响应处理、通配符 refspec 无匹配、
 * delete-refs capability 校验等。
 */

import { describe, test, expect } from "bun:test";

import { sha1, type SHA1 } from "@/core/types.ts";
import { createMemoryObjectStore } from "@/odb/memory-store.ts";
import { createMemoryRefStore } from "@/refs/stores/memory.ts";
import { encodePktLine, encodeFlushPkt } from "@/transport/pkt-line.ts";
import { push, PushError, determinePushRefs } from "@/transport/push.ts";
import { parseReceivePackResult } from "@/transport/receive-pack-result.ts";
import { parseRefSpec } from "@/transport/ref-plan.ts";

import type { RemoteTransport } from "@/transport/types.ts";

// ============================================================================
// 常量
// ============================================================================

// ============================================================================
// push() 服务端响应完整性校验测试
// ============================================================================

describe("push() 服务端响应完整性校验", () => {
  test("服务端返回错误 ref 名称时抛出 PushError（协议异常伪装成功）", async () => {
    const store = createMemoryObjectStore();
    const refStore = createMemoryRefStore(new Map());
    const author = { name: "T", email: "t@t", timestamp: 1000, timezone: "+0000" };

    const emptyTree = store.write({ type: "tree", entries: [] });
    const commitHash = store.write({
      type: "commit" as const,
      tree: emptyTree,
      parents: [],
      author,
      committer: author,
      message: "test",
    });
    refStore.write("refs/heads/main", commitHash);

    let postCalled = false;
    const transport: RemoteTransport = {
      getReceivePackRefs: async () => ({
        capabilities: { "report-status": true },
        refs: [{ name: "refs/heads/main", hash: commitHash }],
      }),
      postReceivePack: async () => {
        postCalled = true;
        // 服务端返回错误的 ref 名称（应返回 refs/heads/main）
        const data = Buffer.concat([
          encodePktLine("unpack ok\n"),
          encodePktLine("ok refs/heads/other\n"),
          encodeFlushPkt(),
        ]);
        return { data, refUpdates: parseReceivePackResult(data), progress: [] };
      },
      getRefAdvertisement: async () => {
        throw new Error("not used");
      },
      postUploadPack: async () => {
        throw new Error("not used");
      },
    };

    const pushPromise = push(store, refStore, "dummy", {
      transport,
      refSpecs: ["refs/heads/main:refs/heads/main"],
    });

    expect(pushPromise).rejects.toThrow(PushError);
    expect(pushPromise).rejects.toThrow(/mismatched ref/i);
    expect(postCalled).toBe(true);
  });

  test("服务端返回的 refUpdates 条数少于推送命令数时报错", async () => {
    const store = createMemoryObjectStore();
    const refStore = createMemoryRefStore(new Map());
    const author = { name: "T", email: "t@t", timestamp: 1000, timezone: "+0000" };

    // 创建两个本地分支
    const emptyTree = store.write({ type: "tree", entries: [] });

    const hashA = store.write({
      type: "commit" as const,
      tree: emptyTree,
      parents: [],
      author,
      committer: author,
      message: "a",
    });
    refStore.write("refs/heads/feature-a", hashA);

    const hashB = store.write({
      type: "commit" as const,
      tree: emptyTree,
      parents: [],
      author,
      committer: author,
      message: "b",
    });
    refStore.write("refs/heads/feature-b", hashB);

    // Mock transport：远端无 refs，postReceivePack 只返回 1 条状态（少于 2 条命令）
    let postCalled = false;
    const transport: RemoteTransport = {
      getReceivePackRefs: async () => ({
        capabilities: { "report-status": true },
        refs: [],
      }),
      postReceivePack: async () => {
        postCalled = true;
        const data = Buffer.concat([
          encodePktLine("unpack ok\n"),
          encodePktLine("ok refs/heads/feature-a\n"),
          encodeFlushPkt(),
        ]);
        return { data, refUpdates: parseReceivePackResult(data), progress: [] };
      },
      getRefAdvertisement: async () => {
        throw new Error("not used");
      },
      postUploadPack: async () => {
        throw new Error("not used");
      },
    };

    const pushPromise = push(store, refStore, "dummy", {
      transport,
      refSpecs: [
        "refs/heads/feature-a:refs/heads/feature-a",
        "refs/heads/feature-b:refs/heads/feature-b",
      ],
    });

    expect(pushPromise).rejects.toThrow(PushError);
    expect(pushPromise).rejects.toThrow(/incomplete status/i);
    expect(postCalled).toBe(true);
  });

  test("服务端未报告 report-status capability 时提前报错", async () => {
    const store = createMemoryObjectStore();
    const refStore = createMemoryRefStore(new Map());
    const author = { name: "T", email: "t@t", timestamp: 1000, timezone: "+0000" };

    // 创建本地分支
    const emptyTree = store.write({ type: "tree", entries: [] });
    const hash = store.write({
      type: "commit" as const,
      tree: emptyTree,
      parents: [],
      author,
      committer: author,
      message: "test",
    });
    refStore.write("refs/heads/main", hash);

    // Mock transport：远端不广告 report-status capability
    let postReceivePackCalled = false;
    const transport: RemoteTransport = {
      getReceivePackRefs: async () => ({
        capabilities: { "side-band-64k": true, "ofs-delta": true },
        refs: [],
      }),
      postReceivePack: async () => {
        postReceivePackCalled = true;
        return { data: Buffer.alloc(0), refUpdates: [], progress: [] };
      },
      getRefAdvertisement: async () => {
        throw new Error("not used");
      },
      postUploadPack: async () => {
        throw new Error("not used");
      },
    };

    const pushPromise = push(store, refStore, "dummy", {
      transport,
      refSpecs: ["refs/heads/main:refs/heads/main"],
    });

    // 应因缺少 report-status 提前报错，而非等到发送请求后才失败
    expect(pushPromise).rejects.toThrow(PushError);
    expect(pushPromise).rejects.toThrow(/report-status/i);
    // 不应调用 postReceivePack（提前检测到问题）
    expect(postReceivePackCalled).toBe(false);
  });
});

// ============================================================================
// determinePushRefs 去重测试
// ============================================================================

describe("determinePushRefs() 重叠 refspec 去重", () => {
  test("重叠 refspec 应去重，同一 remoteRef 只生成一个 push item", () => {
    const hashA = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const hashB = sha1("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    const localRefs = new Map<string, SHA1>([
      ["refs/heads/main", hashA],
      ["refs/heads/develop", hashB],
    ]);
    const remoteRefs = new Map<string, SHA1>();

    const wildSpec = parseRefSpec("refs/heads/*:refs/heads/*");
    const exactSpec = parseRefSpec("refs/heads/main:refs/heads/main");

    const items = determinePushRefs(localRefs, remoteRefs, [wildSpec, exactSpec]);
    // main 和 develop 来自通配符，main 另由精确 spec 匹配但应去重
    // => main x1 + develop x1 = 2
    expect(items).toHaveLength(2);
    const mainItems = items.filter((i) => i.remoteRef === "refs/heads/main");
    expect(mainItems).toHaveLength(1);
    const devItems = items.filter((i) => i.remoteRef === "refs/heads/develop");
    expect(devItems).toHaveLength(1);
  });
});

// ============================================================================
// getLocalRefs + determinePushRefs 自定义命名空间集成测试
// ============================================================================

describe("push 非 heads/tags 来源 ref 推送", () => {
  test("refs/remotes/origin/main:refs/heads/backup 应正确推送", async () => {
    const store = createMemoryObjectStore();
    const author = { name: "T", email: "t@t", timestamp: 1000, timezone: "+0000" };
    const emptyTree = store.write({ type: "tree", entries: [] });

    const commitHash = store.write({
      type: "commit" as const,
      tree: emptyTree,
      parents: [],
      author,
      committer: author,
      message: "test",
    });

    // 模拟本地 refs：refs/remotes/origin/main 存在
    const refStore = createMemoryRefStore(
      new Map([
        ["refs/remotes/origin/main", commitHash],
        ["HEAD", "ref: refs/heads/main"],
      ]),
    );

    const transport: RemoteTransport = {
      getReceivePackRefs: async () => ({
        capabilities: { "report-status": true, "side-band-64k": true },
        refs: [],
      }),
      postReceivePack: async () => {
        const data = Buffer.concat([
          encodePktLine("unpack ok\n"),
          encodePktLine("ok refs/heads/backup\n"),
          encodeFlushPkt(),
        ]);
        return { data, refUpdates: parseReceivePackResult(data), progress: [] };
      },
      getRefAdvertisement: async () => {
        throw new Error("not used");
      },
      postUploadPack: async () => {
        throw new Error("not used");
      },
    };

    const result = await push(store, refStore, "dummy", {
      transport,
      refSpecs: ["refs/remotes/origin/main:refs/heads/backup"],
    });

    expect(result.refUpdates).toHaveLength(1);
    expect(result.refUpdates[0]!.success).toBe(true);
  });

  test("循环 HEAD 不应阻塞其他 ref 的推送", async () => {
    const store = createMemoryObjectStore();
    const author = { name: "T", email: "t@t", timestamp: 1000, timezone: "+0000" };
    const emptyTree = store.write({ type: "tree", entries: [] });

    const commitHash = store.write({
      type: "commit" as const,
      tree: emptyTree,
      parents: [],
      author,
      committer: author,
      message: "test",
    });

    // HEAD 指向的分支自身循环（但 refs/heads/main 是独立且正常的）
    const refStore = createMemoryRefStore(
      new Map([
        ["HEAD", "ref: refs/heads/stuck"],
        ["refs/heads/stuck", "ref: HEAD"], // 循环！resolveRefHash(HEAD) 会抛错
        ["refs/heads/main", commitHash], // 正常的独立分支
      ]),
    );

    const transport: RemoteTransport = {
      getReceivePackRefs: async () => ({
        capabilities: { "report-status": true, "side-band-64k": true },
        refs: [],
      }),
      postReceivePack: async () => {
        const data = Buffer.concat([
          encodePktLine("unpack ok\n"),
          encodePktLine("ok refs/heads/main\n"),
          encodeFlushPkt(),
        ]);
        return { data, refUpdates: parseReceivePackResult(data), progress: [] };
      },
      getRefAdvertisement: async () => {
        throw new Error("not used");
      },
      postUploadPack: async () => {
        throw new Error("not used");
      },
    };

    const result = await push(store, refStore, "dummy", {
      transport,
      refSpecs: ["refs/heads/main:refs/heads/main"],
    });

    expect(result.refUpdates).toHaveLength(1);
    expect(result.refUpdates[0]!.success).toBe(true);
  });

  test("远端旧 tip 对象不在本地时，合法 fast-forward push 不应被本地预检拦截", async () => {
    const store = createMemoryObjectStore();
    const refStore = createMemoryRefStore(new Map());
    const author = { name: "T", email: "t@t", timestamp: 1000, timezone: "+0000" };

    const emptyTree = store.write({ type: "tree", entries: [] });
    const remoteTip = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const localCommit = store.write({
      type: "commit" as const,
      tree: emptyTree,
      parents: [remoteTip],
      author,
      committer: author,
      message: "child of remote tip",
    });
    refStore.write("refs/heads/main", localCommit);

    let postCalled = false;
    const transport: RemoteTransport = {
      getReceivePackRefs: async () => ({
        capabilities: { "report-status": true },
        refs: [{ name: "refs/heads/main", hash: remoteTip }],
      }),
      postReceivePack: async () => {
        postCalled = true;
        const data = Buffer.concat([
          encodePktLine("unpack ok\n"),
          encodePktLine("ok refs/heads/main\n"),
          encodeFlushPkt(),
        ]);
        return { data, refUpdates: parseReceivePackResult(data), progress: [] };
      },
      getRefAdvertisement: async () => {
        throw new Error("not used");
      },
      postUploadPack: async () => {
        throw new Error("not used");
      },
    };

    const result = await push(store, refStore, "dummy", {
      transport,
      refSpecs: ["refs/heads/main:refs/heads/main"],
    });

    expect(postCalled).toBe(true);
    expect(result.refUpdates).toHaveLength(1);
    expect(result.refUpdates[0]!.success).toBe(true);
  });
});

// ============================================================================
// push() 服务端 ng 响应行为契约测试
// ============================================================================

describe("push() 服务端 ng 响应处理", () => {
  test("服务端返回 ng <ref> 时 push() 应抛出 PushError，包含被拒 ref 和原因", async () => {
    const store = createMemoryObjectStore();
    const refStore = createMemoryRefStore(new Map());
    const author = { name: "T", email: "t@t", timestamp: 1000, timezone: "+0000" };
    const emptyTree = store.write({ type: "tree", entries: [] });

    const commitHash = store.write({
      type: "commit" as const,
      tree: emptyTree,
      parents: [],
      author,
      committer: author,
      message: "test",
    });
    refStore.write("refs/heads/main", commitHash);

    // 模拟服务端：ok 一条、ng 一条
    let postCalled = false;
    const transport: RemoteTransport = {
      getReceivePackRefs: async () => ({
        capabilities: { "report-status": true },
        refs: [],
      }),
      postReceivePack: async () => {
        postCalled = true;
        const data = Buffer.concat([
          encodePktLine("unpack ok\n"),
          encodePktLine("ok refs/heads/main\n"),
          encodePktLine("ng refs/heads/feature non-fast-forward\n"),
          encodeFlushPkt(),
        ]);
        return { data, refUpdates: parseReceivePackResult(data), progress: [] };
      },
      getRefAdvertisement: async () => {
        throw new Error("not used");
      },
      postUploadPack: async () => {
        throw new Error("not used");
      },
    };

    const pushPromise = push(store, refStore, "dummy", {
      transport,
      refSpecs: ["refs/heads/main:refs/heads/main", "refs/heads/main:refs/heads/feature"],
    });

    expect(pushPromise).rejects.toThrow(PushError);
    expect(pushPromise).rejects.toThrow(/refs\/heads\/feature/);
    expect(pushPromise).rejects.toThrow(/non-fast-forward/);
    expect(postCalled).toBe(true);
  });

  test("所有 ref 都被 ng 时 push() 应抛出 PushError，包含所有被拒 ref", async () => {
    const store = createMemoryObjectStore();
    const refStore = createMemoryRefStore(new Map());
    const author = { name: "T", email: "t@t", timestamp: 1000, timezone: "+0000" };
    const emptyTree = store.write({ type: "tree", entries: [] });

    const commitHash = store.write({
      type: "commit" as const,
      tree: emptyTree,
      parents: [],
      author,
      committer: author,
      message: "test",
    });
    refStore.write("refs/heads/main", commitHash);

    const transport: RemoteTransport = {
      getReceivePackRefs: async () => ({
        capabilities: { "report-status": true },
        refs: [],
      }),
      postReceivePack: async () => {
        const data = Buffer.concat([
          encodePktLine("unpack ok\n"),
          encodePktLine("ng refs/heads/main hook declined\n"),
          encodeFlushPkt(),
        ]);
        return { data, refUpdates: parseReceivePackResult(data), progress: [] };
      },
      getRefAdvertisement: async () => {
        throw new Error("not used");
      },
      postUploadPack: async () => {
        throw new Error("not used");
      },
    };

    const pushPromise = push(store, refStore, "dummy", {
      transport,
      refSpecs: ["refs/heads/main:refs/heads/main"],
    });

    expect(pushPromise).rejects.toThrow(PushError);
    expect(pushPromise).rejects.toThrow(/hook declined/);
  });

  test("部分成功时仍应抛错，但错误对象必须保留完整 refUpdates", async () => {
    const store = createMemoryObjectStore();
    const refStore = createMemoryRefStore(new Map());
    const author = { name: "T", email: "t@t", timestamp: 1000, timezone: "+0000" };
    const emptyTree = store.write({ type: "tree", entries: [] });

    const commitHash = store.write({
      type: "commit" as const,
      tree: emptyTree,
      parents: [],
      author,
      committer: author,
      message: "test",
    });
    refStore.write("refs/heads/main", commitHash);

    const transport: RemoteTransport = {
      getReceivePackRefs: async () => ({
        capabilities: { "report-status": true },
        refs: [],
      }),
      postReceivePack: async () => {
        const data = Buffer.concat([
          encodePktLine("unpack ok\n"),
          encodePktLine("ok refs/heads/main\n"),
          encodePktLine("ng refs/heads/feature non-fast-forward\n"),
          encodeFlushPkt(),
        ]);
        return { data, refUpdates: parseReceivePackResult(data), progress: ["remote: progress"] };
      },
      getRefAdvertisement: async () => {
        throw new Error("not used");
      },
      postUploadPack: async () => {
        throw new Error("not used");
      },
    };

    const pushPromise = push(store, refStore, "dummy", {
      transport,
      refSpecs: ["refs/heads/main:refs/heads/main", "refs/heads/main:refs/heads/feature"],
    });

    expect(pushPromise).rejects.toBeInstanceOf(PushError);

    try {
      await pushPromise;
      throw new Error("Expected push() to reject on partial failure");
    } catch (err) {
      expect(err).toBeInstanceOf(PushError);

      const details = err as PushError;

      expect(details.refUpdates).toBeDefined();
      expect(details.refUpdates).toHaveLength(2);
      expect(details.refUpdates?.find((u) => u.refName === "refs/heads/main")?.success).toBe(true);
      expect(details.refUpdates?.find((u) => u.refName === "refs/heads/feature")?.success).toBe(
        false,
      );
      expect(details.refUpdates?.find((u) => u.refName === "refs/heads/feature")?.error).toBe(
        "non-fast-forward",
      );
      expect(details.progress).toEqual(["remote: progress"]);
    }
  });
});

// ============================================================================
// push() 通配符 refspec 无匹配行为
// ============================================================================

describe("push() 通配符 refspec 无匹配本地引用", () => {
  test("通配符 refspec 单独使用且无匹配时抛出 PushError", async () => {
    const store = createMemoryObjectStore();
    const refStore = createMemoryRefStore();

    let postCalled = false;
    const transport: RemoteTransport = {
      getReceivePackRefs: async () => ({
        capabilities: { "report-status": true, "side-band-64k": true },
        refs: [],
      }),
      postReceivePack: async () => {
        postCalled = true;
        throw new Error("should not be called");
      },
      getRefAdvertisement: async () => {
        throw new Error("not used");
      },
      postUploadPack: async () => {
        throw new Error("not used");
      },
    };

    const pushPromise = push(store, refStore, "dummy", {
      transport,
      refSpecs: ["refs/heads/nope/*:refs/heads/*"],
    });

    expect(pushPromise).rejects.toThrow(PushError);
    expect(pushPromise).rejects.toThrow(/does not match any local ref/);
    expect(postCalled).toBe(false);
  });

  test("通配符 refspec 匹配到本地引用时正常通过", async () => {
    const store = createMemoryObjectStore();
    const author = { name: "T", email: "t@t", timestamp: 1000, timezone: "+0000" };
    const emptyTree = store.write({ type: "tree", entries: [] });
    const commitHash = store.write({
      type: "commit" as const,
      tree: emptyTree,
      parents: [],
      author,
      committer: author,
      message: "test",
    });

    const refStore = createMemoryRefStore(new Map([["refs/heads/main", commitHash]]));

    const transport: RemoteTransport = {
      getReceivePackRefs: async () => ({
        capabilities: { "report-status": true, "side-band-64k": true },
        refs: [],
      }),
      postReceivePack: async () => {
        const data = Buffer.concat([
          encodePktLine("unpack ok\n"),
          encodePktLine("ok refs/heads/main\n"),
          encodeFlushPkt(),
        ]);
        return { data, refUpdates: parseReceivePackResult(data), progress: [] };
      },
      getRefAdvertisement: async () => {
        throw new Error("not used");
      },
      postUploadPack: async () => {
        throw new Error("not used");
      },
    };

    const result = await push(store, refStore, "dummy", {
      transport,
      refSpecs: ["refs/heads/*:refs/heads/*"],
    });

    expect(result.refUpdates).toHaveLength(1);
    expect(result.refUpdates[0]!.success).toBe(true);
  });
});

// ============================================================================
// push() delete-refs capability 校验
// ============================================================================

describe("push() delete-refs capability 校验", () => {
  test("服务端未广告 delete-refs 时删除操作抛出 PushError", async () => {
    const store = createMemoryObjectStore();
    const refStore = createMemoryRefStore();
    const remoteRefHash = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    let postCalled = false;
    const transport: RemoteTransport = {
      getReceivePackRefs: async () => ({
        capabilities: { "report-status": true, "side-band-64k": true },
        refs: [{ name: "refs/heads/feature", hash: remoteRefHash }],
      }),
      postReceivePack: async () => {
        postCalled = true;
        throw new Error("should not be called");
      },
      getRefAdvertisement: async () => {
        throw new Error("not used");
      },
      postUploadPack: async () => {
        throw new Error("not used");
      },
    };

    const pushPromise = push(store, refStore, "dummy", {
      transport,
      refSpecs: [":refs/heads/feature"],
    });

    expect(pushPromise).rejects.toThrow(PushError);
    expect(pushPromise).rejects.toThrow(/delete-refs/);
    expect(postCalled).toBe(false);
  });

  test("服务端广告 delete-refs 时删除操作正常通过", async () => {
    const store = createMemoryObjectStore();
    const refStore = createMemoryRefStore();
    const remoteRefHash = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    const transport: RemoteTransport = {
      getReceivePackRefs: async () => ({
        capabilities: { "report-status": true, "side-band-64k": true, "delete-refs": true },
        refs: [{ name: "refs/heads/feature", hash: remoteRefHash }],
      }),
      postReceivePack: async () => {
        const data = Buffer.concat([
          encodePktLine("unpack ok\n"),
          encodePktLine("ok refs/heads/feature\n"),
          encodeFlushPkt(),
        ]);
        return { data, refUpdates: parseReceivePackResult(data), progress: [] };
      },
      getRefAdvertisement: async () => {
        throw new Error("not used");
      },
      postUploadPack: async () => {
        throw new Error("not used");
      },
    };

    const result = await push(store, refStore, "dummy", {
      transport,
      refSpecs: [":refs/heads/feature"],
    });

    expect(result.refUpdates).toHaveLength(1);
    expect(result.refUpdates[0]!.success).toBe(true);
  });

  test("服务端未广告 delete-refs 但 push 不含删除操作时正常通过", async () => {
    const store = createMemoryObjectStore();
    const author = { name: "T", email: "t@t", timestamp: 1000, timezone: "+0000" };
    const emptyTree = store.write({ type: "tree", entries: [] });
    const commitHash = store.write({
      type: "commit" as const,
      tree: emptyTree,
      parents: [],
      author,
      committer: author,
      message: "test",
    });

    const refStore = createMemoryRefStore(new Map([["refs/heads/main", commitHash]]));

    const transport: RemoteTransport = {
      getReceivePackRefs: async () => ({
        capabilities: { "report-status": true, "side-band-64k": true },
        refs: [],
      }),
      postReceivePack: async () => {
        const data = Buffer.concat([
          encodePktLine("unpack ok\n"),
          encodePktLine("ok refs/heads/main\n"),
          encodeFlushPkt(),
        ]);
        return { data, refUpdates: parseReceivePackResult(data), progress: [] };
      },
      getRefAdvertisement: async () => {
        throw new Error("not used");
      },
      postUploadPack: async () => {
        throw new Error("not used");
      },
    };

    const result = await push(store, refStore, "dummy", {
      transport,
      refSpecs: ["refs/heads/main:refs/heads/main"],
    });

    expect(result.refUpdates).toHaveLength(1);
    expect(result.refUpdates[0]!.success).toBe(true);
  });
});

// ============================================================================
// push() 对缺失 unpack 的非法响应处理
// ============================================================================

describe("push() 对缺失 unpack 的非法响应处理", () => {
  test("receive-pack 响应缺少 unpack 行时 push() 应抛出 PushError", async () => {
    const store = createMemoryObjectStore();
    const refStore = createMemoryRefStore(new Map());
    const author = { name: "T", email: "t@t", timestamp: 1000, timezone: "+0000" };
    const emptyTree = store.write({ type: "tree", entries: [] });
    const hash = store.write({
      type: "commit" as const,
      tree: emptyTree,
      parents: [],
      author,
      committer: author,
      message: "test",
    });
    refStore.write("refs/heads/main", hash);

    const transport: RemoteTransport = {
      getReceivePackRefs: async () => ({
        capabilities: { "report-status": true },
        refs: [],
      }),
      postReceivePack: async () => {
        // 非法响应：缺少 unpack ok，直接以 ok 开头
        const data = Buffer.concat([encodePktLine("ok refs/heads/main\n"), encodeFlushPkt()]);
        const refUpdates = parseReceivePackResult(data);
        return { data, refUpdates, progress: [] };
      },
      getRefAdvertisement: async () => {
        throw new Error("not used");
      },
      postUploadPack: async () => {
        throw new Error("not used");
      },
    };

    const pushPromise = push(store, refStore, "dummy", {
      transport,
      refSpecs: ["refs/heads/main:refs/heads/main"],
    });

    // parseReceivePackResult 会抛出 ReceivePackResultError，
    // push() 应将其转换为 PushError 传播给调用方
    expect(pushPromise).rejects.toThrow(PushError);
    expect(pushPromise).rejects.toThrow(/missing unpack/i);
  });
});
