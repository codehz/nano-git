/**
 * Push 协议层单元测试
 *
 * 不依赖 CGI，测试请求构建（buildReceivePackRequest）和
 * 响应解析（parseReceivePackResult）的编解码正确性。
 */

import { describe, test, expect } from "bun:test";

import { sha1, type SHA1 } from "@/core/types.ts";
import { createMemoryObjectStore } from "@/odb/memory-store.ts";
import { createMemoryRefStore } from "@/refs/stores/memory.ts";
import { parseRefSpec } from "@/transport/fetch.ts";
import { parsePktLines, encodePktLine, encodeFlushPkt } from "@/transport/pkt-line.ts";
import { push, PushError, determinePushRefs } from "@/transport/push.ts";
import {
  buildReceivePackRequest,
  type ReceivePackCommand,
} from "@/transport/receive-pack-request.ts";
import { parseReceivePackResult, ReceivePackResultError } from "@/transport/receive-pack-result.ts";

import type { PktLineData } from "@/transport/pkt-line.ts";
import type { RemoteTransport } from "@/transport/types.ts";

// ============================================================================
// 常量
// ============================================================================

const HASH_A = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const HASH_B = sha1("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
const ZERO_HASH = sha1("0000000000000000000000000000000000000000");
const MAIN_REF = "refs/heads/main";
const FEATURE_REF = "refs/heads/feature";

// ============================================================================
// buildReceivePackRequest 测试
// ============================================================================

describe("buildReceivePackRequest", () => {
  test("基本格式：单条命令 + packfile", () => {
    const commands: ReceivePackCommand[] = [
      { oldHash: ZERO_HASH, newHash: HASH_A, refName: MAIN_REF },
    ];
    const packfile = Buffer.from("PACKDATA");
    const caps: string[] = [];

    const result = buildReceivePackRequest(commands, packfile, caps);

    // 结果尾部应为 packfile 数据
    expect(result.subarray(result.length - 8).toString()).toBe("PACKDATA");

    // 解析 pkt-line 部分（截掉 packfile 后）
    const pktLinePortion = result.subarray(0, result.length - 8);
    const lines = parsePktLines(pktLinePortion);

    expect(lines.length).toBe(2);
    expect(lines[0]!.type).toBe("data");
    expect(lines[1]!.type).toBe("flush");

    const cmdLine = (lines[0] as PktLineData).payload.toString("utf-8");
    expect(cmdLine).toBe(`${ZERO_HASH} ${HASH_A} ${MAIN_REF}\n`);
  });

  test("首行带 capabilities", () => {
    const commands: ReceivePackCommand[] = [
      { oldHash: ZERO_HASH, newHash: HASH_A, refName: MAIN_REF },
    ];
    const packfile = Buffer.alloc(0);
    const caps = ["report-status", "side-band-64k"];

    const result = buildReceivePackRequest(commands, packfile, caps);
    const lines = parsePktLines(result);

    expect(lines.length).toBe(2);
    expect(lines[0]!.type).toBe("data");

    const cmdLine = (lines[0] as PktLineData).payload.toString("utf-8");
    // capabilities 应跟在 NUL 之后
    expect(cmdLine).toBe(`${ZERO_HASH} ${HASH_A} ${MAIN_REF}\0report-status side-band-64k\n`);
  });

  test("多条命令", () => {
    const commands: ReceivePackCommand[] = [
      { oldHash: ZERO_HASH, newHash: HASH_A, refName: MAIN_REF },
      { oldHash: HASH_A, newHash: HASH_B, refName: FEATURE_REF },
    ];
    const packfile = Buffer.alloc(0);
    const caps: string[] = [];

    const result = buildReceivePackRequest(commands, packfile, caps);
    const lines = parsePktLines(result);

    expect(lines.length).toBe(3); // 2 命令 + 1 flush
    expect(lines[0]!.type).toBe("data");
    expect(lines[1]!.type).toBe("data");
    expect(lines[2]!.type).toBe("flush");

    const line0 = (lines[0] as PktLineData).payload.toString("utf-8");
    const line1 = (lines[1] as PktLineData).payload.toString("utf-8");
    expect(line0).toBe(`${ZERO_HASH} ${HASH_A} ${MAIN_REF}\n`);
    expect(line1).toBe(`${HASH_A} ${HASH_B} ${FEATURE_REF}\n`);
  });

  test("空 packfile（删除分支场景）", () => {
    const commands: ReceivePackCommand[] = [
      { oldHash: HASH_A, newHash: ZERO_HASH, refName: MAIN_REF },
    ];
    const packfile = Buffer.alloc(0);
    const caps: string[] = [];

    const result = buildReceivePackRequest(commands, packfile, caps);

    // 解析 pkt-line，不应有多余数据
    const lines = parsePktLines(result);
    expect(lines.length).toBe(2);
    expect(lines[0]!.type).toBe("data");
    expect(lines[1]!.type).toBe("flush");

    const cmdLine = (lines[0] as PktLineData).payload.toString("utf-8");
    expect(cmdLine).toBe(`${HASH_A} ${ZERO_HASH} ${MAIN_REF}\n`);
  });

  test("至少一条命令（空命令列表抛错）", () => {
    expect(() => {
      buildReceivePackRequest([], Buffer.alloc(0), []);
    }).toThrow("At least one command is required");
  });
});

// ============================================================================
// parseReceivePackResult 测试
// ============================================================================

describe("parseReceivePackResult", () => {
  test("解析 ok 行", () => {
    const data = Buffer.concat([encodePktLine("ok refs/heads/main\n"), encodeFlushPkt()]);

    const result = parseReceivePackResult(data);
    expect(result).toHaveLength(1);
    expect(result[0]!.refName).toBe("refs/heads/main");
    expect(result[0]!.success).toBe(true);
    expect(result[0]!.error).toBeUndefined();
  });

  test("解析 ng 行", () => {
    const data = Buffer.concat([
      encodePktLine("ng refs/heads/main non-fast-forward\n"),
      encodeFlushPkt(),
    ]);

    const result = parseReceivePackResult(data);
    expect(result).toHaveLength(1);
    expect(result[0]!.refName).toBe("refs/heads/main");
    expect(result[0]!.success).toBe(false);
    expect(result[0]!.error).toBe("non-fast-forward");
  });

  test("unpack ok 行被跳过", () => {
    const data = Buffer.concat([
      encodePktLine("unpack ok\n"),
      encodePktLine("ok refs/heads/main\n"),
      encodeFlushPkt(),
    ]);

    const result = parseReceivePackResult(data);
    expect(result).toHaveLength(1);
    expect(result[0]!.refName).toBe("refs/heads/main");
    expect(result[0]!.success).toBe(true);
  });

  test("unpack error 行导致报错", () => {
    const data = Buffer.concat([encodePktLine("unpack index error\n"), encodeFlushPkt()]);

    expect(() => parseReceivePackResult(data)).toThrow(ReceivePackResultError);
    expect(() => parseReceivePackResult(data)).toThrow("index error");
  });

  test("unpack error 后跟随 ng 行仍应先报 unpack 错误", () => {
    const data = Buffer.concat([
      encodePktLine("unpack index error\n"),
      encodePktLine("ng refs/heads/main unpack fail\n"),
      encodeFlushPkt(),
    ]);

    expect(() => parseReceivePackResult(data)).toThrow(ReceivePackResultError);
  });

  test("多行混合", () => {
    const data = Buffer.concat([
      encodePktLine("unpack ok\n"),
      encodePktLine("ok refs/heads/main\n"),
      encodePktLine("ok refs/heads/feature\n"),
      encodePktLine("ng refs/heads/broken some error\n"),
      encodeFlushPkt(),
    ]);

    const result = parseReceivePackResult(data);
    expect(result).toHaveLength(3);

    expect(result[0]!.refName).toBe("refs/heads/main");
    expect(result[0]!.success).toBe(true);

    expect(result[1]!.refName).toBe("refs/heads/feature");
    expect(result[1]!.success).toBe(true);

    expect(result[2]!.refName).toBe("refs/heads/broken");
    expect(result[2]!.success).toBe(false);
    expect(result[2]!.error).toBe("some error");
  });

  test("空数据返回空列表", () => {
    const result = parseReceivePackResult(Buffer.alloc(0));
    expect(result).toHaveLength(0);
  });

  test("仅 flush-pkt 返回空列表", () => {
    const result = parseReceivePackResult(encodeFlushPkt());
    expect(result).toHaveLength(0);
  });

  test("ng 行缺少错误消息时抛错", () => {
    const data = Buffer.concat([encodePktLine("ng refs/heads/main\n"), encodeFlushPkt()]);

    expect(() => parseReceivePackResult(data)).toThrow(ReceivePackResultError);
  });

  test("未知状态行抛错", () => {
    const data = Buffer.concat([encodePktLine("unknown data\n"), encodeFlushPkt()]);

    expect(() => parseReceivePackResult(data)).toThrow(ReceivePackResultError);
  });
});

// ============================================================================
// push() 服务端响应完整性校验测试
// ============================================================================

describe("push() 服务端响应完整性校验", () => {
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
    refStore.writeRaw("refs/heads/feature-a", hashA);

    const hashB = store.write({
      type: "commit" as const,
      tree: emptyTree,
      parents: [],
      author,
      committer: author,
      message: "b",
    });
    refStore.writeRaw("refs/heads/feature-b", hashB);

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
    refStore.writeRaw("refs/heads/main", hash);

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
