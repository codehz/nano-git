/**
 * Push 高层行为单元测试
 *
 * 覆盖 push() 服务端响应完整性校验、determinePushRefs 去重、
 * 自定义命名空间推送、ng 响应处理、通配符 refspec 无匹配、
 * delete-refs capability 校验等。
 */

import { describe, test, expect } from "bun:test";

import { sha1, type SHA1 } from "@/core/types.ts";
import { createMemoryObjectStore } from "@/odb/memory.ts";
import { createMemoryRefStore } from "@/refs/memory.ts";
import { PushError } from "@/transport/client/receive-pack/push-error.ts";
import { determinePushRefs } from "@/transport/client/receive-pack/push-ref-plan.ts";
import { push } from "@/transport/client/receive-pack/push.ts";
import { encodePktLine, encodeFlushPkt } from "@/transport/protocol/pkt-line.ts";
import { parseRefSpec } from "@/transport/protocol/refspec.ts";

import type { ReceivePackTransport, RemoteRef } from "@/transport/protocol/types.ts";

function sideBandFrame(channel: number, data: string | Buffer): Buffer {
  const payload = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
  return encodePktLine(Buffer.concat([Buffer.from([channel]), payload]));
}

function okReportStatus(refName: string): Buffer {
  return Buffer.concat([
    encodePktLine("unpack ok\n"),
    encodePktLine(`ok ${refName}\n`),
    encodeFlushPkt(),
  ]);
}

function mockTransport(
  caps: Record<string, string | true>,
  refs: RemoteRef[],
  onRequest: () => Buffer | Promise<Buffer>,
): ReceivePackTransport {
  return {
    advertise: async () => ({ capabilities: caps, refs }),
    request: async () => onRequest(),
  };
}

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
    const transport = mockTransport(
      { "report-status": true },
      [{ name: "refs/heads/main", hash: commitHash }],
      () => {
        postCalled = true;
        return Buffer.concat([
          encodePktLine("unpack ok\n"),
          encodePktLine("ok refs/heads/other\n"),
          encodeFlushPkt(),
        ]);
      },
    );
    const adv = await transport.advertise();
    const pushPromise = push(store, refStore, transport, adv, {
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

    let postCalled = false;
    const transport = mockTransport({ "report-status": true }, [], () => {
      postCalled = true;
      return Buffer.concat([
        encodePktLine("unpack ok\n"),
        encodePktLine("ok refs/heads/feature-a\n"),
        encodeFlushPkt(),
      ]);
    });
    const adv = await transport.advertise();
    const pushPromise = push(store, refStore, transport, adv, {
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

    let requestCalled = false;
    const transport: ReceivePackTransport = {
      advertise: async () => ({
        capabilities: { "side-band-64k": true, "ofs-delta": true },
        refs: [],
      }),
      request: async () => {
        requestCalled = true;
        return Buffer.alloc(0);
      },
    };
    const adv = await transport.advertise();
    const pushPromise = push(store, refStore, transport, adv, {
      refSpecs: ["refs/heads/main:refs/heads/main"],
    });
    expect(pushPromise).rejects.toThrow(PushError);
    expect(pushPromise).rejects.toThrow(/report-status/i);
    expect(requestCalled).toBe(false);
  });
});

describe("determinePushRefs() 重叠 refspec 冲突检测", () => {
  test("重叠 refspec 映射到同一 remoteRef 时抛 PushError", () => {
    const hashA = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const hashB = sha1("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    const localRefs = new Map<string, SHA1>([
      ["refs/heads/main", hashA],
      ["refs/heads/develop", hashB],
    ]);
    const remoteRefs = new Map<string, SHA1>();
    const wildSpec = parseRefSpec("refs/heads/*:refs/heads/*");
    const exactSpec = parseRefSpec("refs/heads/main:refs/heads/main");
    expect(() => {
      determinePushRefs(localRefs, remoteRefs, [wildSpec, exactSpec]);
    }).toThrow(PushError);
  });
});

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
    const refStore = createMemoryRefStore(
      new Map([
        ["refs/remotes/origin/main", commitHash],
        ["HEAD", "ref: refs/heads/main"],
      ]),
    );
    const transport = mockTransport({ "report-status": true, "side-band-64k": true }, [], () =>
      okReportStatus("refs/heads/backup"),
    );
    const adv = await transport.advertise();
    const result = await push(store, refStore, transport, adv, {
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
    const refStore = createMemoryRefStore(
      new Map([
        ["HEAD", "ref: refs/heads/stuck"],
        ["refs/heads/stuck", "ref: HEAD"],
        ["refs/heads/main", commitHash],
      ]),
    );
    const transport = mockTransport({ "report-status": true, "side-band-64k": true }, [], () =>
      okReportStatus("refs/heads/main"),
    );
    const adv = await transport.advertise();
    const result = await push(store, refStore, transport, adv, {
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
    const transport = mockTransport(
      { "report-status": true },
      [{ name: "refs/heads/main", hash: remoteTip }],
      () => {
        postCalled = true;
        return okReportStatus("refs/heads/main");
      },
    );
    const adv = await transport.advertise();
    const result = await push(store, refStore, transport, adv, {
      refSpecs: ["refs/heads/main:refs/heads/main"],
    });
    expect(postCalled).toBe(true);
    expect(result.refUpdates).toHaveLength(1);
    expect(result.refUpdates[0]!.success).toBe(true);
  });
});

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

    let postCalled = false;
    const transport = mockTransport({ "report-status": true }, [], () => {
      postCalled = true;
      return Buffer.concat([
        encodePktLine("unpack ok\n"),
        encodePktLine("ok refs/heads/main\n"),
        encodePktLine("ng refs/heads/feature non-fast-forward\n"),
        encodeFlushPkt(),
      ]);
    });
    const adv = await transport.advertise();
    const pushPromise = push(store, refStore, transport, adv, {
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

    const transport = mockTransport({ "report-status": true }, [], () =>
      Buffer.concat([
        encodePktLine("unpack ok\n"),
        encodePktLine("ng refs/heads/main hook declined\n"),
        encodeFlushPkt(),
      ]),
    );
    const adv = await transport.advertise();
    const pushPromise = push(store, refStore, transport, adv, {
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

    const transport: ReceivePackTransport = {
      advertise: async () => ({
        capabilities: { "report-status": true, "side-band-64k": true },
        refs: [],
      }),
      request: async () => {
        const reportInner = Buffer.concat([
          encodePktLine("unpack ok\n"),
          encodePktLine("ok refs/heads/main\n"),
          encodePktLine("ng refs/heads/feature non-fast-forward\n"),
          encodeFlushPkt(),
        ]);
        return Buffer.concat([sideBandFrame(2, "remote: progress"), sideBandFrame(1, reportInner)]);
      },
    };
    const adv = await transport.advertise();
    const pushPromise = push(store, refStore, transport, adv, {
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

describe("push() 通配符 refspec 无匹配本地引用", () => {
  test("通配符 refspec 单独使用且无匹配时抛出 PushError", async () => {
    const store = createMemoryObjectStore();
    const refStore = createMemoryRefStore();
    let postCalled = false;
    const transport: ReceivePackTransport = {
      advertise: async () => ({
        capabilities: { "report-status": true, "side-band-64k": true },
        refs: [],
      }),
      request: async () => {
        postCalled = true;
        throw new Error("should not be called");
      },
    };
    const adv = await transport.advertise();
    const pushPromise = push(store, refStore, transport, adv, {
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
    const transport = mockTransport({ "report-status": true, "side-band-64k": true }, [], () =>
      okReportStatus("refs/heads/main"),
    );
    const adv = await transport.advertise();
    const result = await push(store, refStore, transport, adv, {
      refSpecs: ["refs/heads/*:refs/heads/*"],
    });
    expect(result.refUpdates).toHaveLength(1);
    expect(result.refUpdates[0]!.success).toBe(true);
  });
});

describe("push() delete-refs capability 校验", () => {
  test("服务端未广告 delete-refs 时删除操作抛出 PushError", async () => {
    const store = createMemoryObjectStore();
    const refStore = createMemoryRefStore();
    const remoteRefHash = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    let postCalled = false;
    const transport: ReceivePackTransport = {
      advertise: async () => ({
        capabilities: { "report-status": true, "side-band-64k": true },
        refs: [{ name: "refs/heads/feature", hash: remoteRefHash }],
      }),
      request: async () => {
        postCalled = true;
        throw new Error("should not be called");
      },
    };
    const adv = await transport.advertise();
    const pushPromise = push(store, refStore, transport, adv, {
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
    const transport = mockTransport(
      { "report-status": true, "side-band-64k": true, "delete-refs": true },
      [{ name: "refs/heads/feature", hash: remoteRefHash }],
      () => okReportStatus("refs/heads/feature"),
    );
    const adv = await transport.advertise();
    const result = await push(store, refStore, transport, adv, {
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
    const transport = mockTransport({ "report-status": true, "side-band-64k": true }, [], () =>
      okReportStatus("refs/heads/main"),
    );
    const adv = await transport.advertise();
    const result = await push(store, refStore, transport, adv, {
      refSpecs: ["refs/heads/main:refs/heads/main"],
    });
    expect(result.refUpdates).toHaveLength(1);
    expect(result.refUpdates[0]!.success).toBe(true);
  });
});

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

    const transport = mockTransport({ "report-status": true }, [], () =>
      Buffer.concat([encodePktLine("ok refs/heads/main\n"), encodeFlushPkt()]),
    );
    const adv = await transport.advertise();
    const pushPromise = push(store, refStore, transport, adv, {
      refSpecs: ["refs/heads/main:refs/heads/main"],
    });
    expect(pushPromise).rejects.toThrow(PushError);
    expect(pushPromise).rejects.toThrow(/missing unpack/i);
  });
});
