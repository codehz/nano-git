/**
 * fetch-pack 核心传输协商逻辑单元测试
 *
 * 覆盖 fetchPack() 主入口和 negotiateAndFetchPackfile() 多轮协商循环：
 * - 初始 clone（无 haves → 直接 done）
 * - shallow 能力校验失败
 * - 多轮增量协商（先 NAK 后 ACK + packfile）
 * - ready 响应处理（先 ACK ready 再 done）
 * - 空 wants 错误处理
 * - 服务端返回异常响应时的错误处理
 */

import { describe, test, expect } from "bun:test";

import { sha1, type SHA1 } from "@/core/types.ts";
import { createMemoryObjectStore } from "@/odb/memory-store.ts";
import { createPackWriter } from "@/odb/pack/pack-writer.ts";
import { fetchPack, FetchPackError } from "@/transport/fetch-pack.ts";
import { encodePktLine } from "@/transport/pkt-line.ts";

import type { UploadPackTransport } from "@/transport/types.ts";

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 创建最小有效 packfile（包含一个 blob 对象）
 * fetchPack() 需要 packfile 长度 > 0 且可被 createPackReader 解析。
 */
function buildPackfileWithCommit(tree: SHA1, parents: SHA1[], message: string): Buffer {
  const writer = createPackWriter();
  const author = { name: "T", email: "t@t", timestamp: 1000, timezone: "+0000" };
  writer.addObject({
    type: "commit",
    tree,
    parents,
    author,
    committer: author,
    message,
  });
  return writer.build();
}

/**
 * 创建 UploadPackTransport mock
 *
 * @param caps - 服务端 capabilities
 * @param refs - 服务端广告的引用
 * @param onRequest - request() 回调，返回原始响应 body
 */
function mockTransport(
  caps: Record<string, string | true>,
  refs: { name: string; hash: SHA1 }[],
  onRequest: () => Buffer | Promise<Buffer>,
): UploadPackTransport {
  return {
    advertise: async () => ({ capabilities: caps, refs }),
    request: async () => onRequest(),
  };
}

/**
 * 构造 upload-pack NAK 响应 + packfile（非 side-band）
 *
 * git-upload-pack 非 side-band 响应格式：
 *   0008NAK\n<PACK raw data>
 */
function nakWithPackfile(packfile: Buffer): Buffer {
  return Buffer.concat([encodePktLine("NAK\n"), packfile]);
}

/**
 * 构造 upload-pack ACK + packfile 响应（非 side-band）
 *
 * 格式：
 *   0027ACK <40-hex-hash> continue\n<PACK raw data>
 *   或
 *   002fACK <40-hex-hash> common\n<PACK raw data>
 */
function ackWithPackfile(hash: SHA1, status: "common" | "continue"): Buffer {
  return Buffer.concat([
    encodePktLine(`ACK ${hash} ${status}\n`),
    buildPackfileWithCommit(hash, [], "test commit"),
  ]);
}

// ============================================================================
// 测试数据
// ============================================================================

const HASH_A = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const HASH_B = sha1("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

// ============================================================================
// 测试用例
// ============================================================================

describe("fetchPack() 初始 clone", () => {
  test("无 haves 时发送 wants + done 并接收 packfile", async () => {
    const store = createMemoryObjectStore();
    const transport = mockTransport(
      { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
      [{ name: "refs/heads/main", hash: HASH_A }],
      () => {
        // 初始 clone：无 haves，直接发 done
        // 服务端返回 ACK + packfile
        return ackWithPackfile(HASH_A, "common");
      },
    );
    const adv = await transport.advertise();

    const result = await fetchPack(store, transport, adv, {
      wants: [HASH_A],
    });

    expect(result.objectCount).toBeGreaterThan(0);
  });

  test("服务端返回空 packfile 时抛出 FetchPackError", async () => {
    const store = createMemoryObjectStore();
    const transport = mockTransport(
      { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
      [{ name: "refs/heads/main", hash: HASH_A }],
      () => {
        // 服务端返回 NAK 但无 packfile（空响应）
        return encodePktLine("NAK\n");
      },
    );
    const adv = await transport.advertise();

    const promise = fetchPack(store, transport, adv, {
      wants: [HASH_A],
    });

    expect(promise).rejects.toThrow(FetchPackError);
    expect(promise).rejects.toThrow(/empty packfile/i);
  });
});

describe("fetchPack() shallow 能力校验", () => {
  test("服务端不支持 shallow 但指定 depth 时抛出 FetchPackError", async () => {
    const store = createMemoryObjectStore();
    const transport = mockTransport(
      { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
      [{ name: "refs/heads/main", hash: HASH_A }],
      () => Buffer.alloc(0),
    );
    const adv = await transport.advertise();

    const promise = fetchPack(store, transport, adv, {
      wants: [HASH_A],
      depth: 3,
    });

    expect(promise).rejects.toThrow(FetchPackError);
    expect(promise).rejects.toThrow(/does not support shallow fetch/i);
  });

  test("服务端不支持 shallow 但指定 shallow 列表时抛出 FetchPackError", async () => {
    const store = createMemoryObjectStore();
    const transport = mockTransport(
      { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
      [{ name: "refs/heads/main", hash: HASH_A }],
      () => Buffer.alloc(0),
    );
    const adv = await transport.advertise();

    const promise = fetchPack(store, transport, adv, {
      wants: [HASH_A],
      shallow: [HASH_B],
    });

    expect(promise).rejects.toThrow(FetchPackError);
    expect(promise).rejects.toThrow(/does not support shallow fetch/i);
  });

  test("服务端广告 shallow 能力时 depth 请求正常进行", async () => {
    const store = createMemoryObjectStore();
    const packfile = buildPackfileWithCommit(HASH_A, [], "shallow commit");
    const transport = mockTransport(
      {
        multi_ack: true,
        "side-band-64k": true,
        "ofs-delta": true,
        shallow: true,
      },
      [{ name: "refs/heads/main", hash: HASH_A }],
      () => nakWithPackfile(packfile),
    );
    const adv = await transport.advertise();

    const result = await fetchPack(store, transport, adv, {
      wants: [HASH_A],
      depth: 2,
    });

    expect(result.objectCount).toBeGreaterThan(0);
  });
});

describe("fetchPack() 多轮增量协商", () => {
  test("服务端先返回 NAK 再返回 ACK + packfile（两轮协商）", async () => {
    const store = createMemoryObjectStore();
    const author = { name: "T", email: "t@t", timestamp: 500, timezone: "+0000" };
    const emptyTree = store.write({ type: "tree", entries: [] });

    // 创建 35 个 commit 链（超过 MAX_HAVES_PER_ROUND=32，确保至少两轮协商）
    let parent: SHA1 | null = null;
    const tips: SHA1[] = [];
    for (let i = 0; i < 35; i++) {
      const c: SHA1 = store.write({
        type: "commit" as const,
        tree: emptyTree,
        parents: parent ? [parent] : [],
        author,
        committer: author,
        message: `commit ${i}`,
      });
      parent = c;
      tips.push(c);
    }

    // tip 是最新的 commit
    const tipCommit = tips[tips.length - 1]!;

    let round = 0;
    const transport = mockTransport(
      { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
      [{ name: "refs/heads/main", hash: HASH_A }],
      () => {
        round++;
        if (round === 1) {
          // 第一轮：返回 NAK（haves 不足，服务端尚未确认公共点）
          return encodePktLine("NAK\n");
        }
        // 第二轮：返回 ACK + packfile
        return ackWithPackfile(tipCommit, "common");
      },
    );
    const adv = await transport.advertise();

    const result = await fetchPack(store, transport, adv, {
      wants: [HASH_A],
      haves: [tipCommit],
    });

    expect(round).toBe(2);
    expect(result.objectCount).toBeGreaterThan(0);
  });
});

describe("fetchPack() ready 响应处理", () => {
  test("服务端返回 ACK ready 后立即发送 done 并接收 packfile", async () => {
    const store = createMemoryObjectStore();
    // 先在 store 中写入一个 commit 作为 have 候选
    const author = { name: "T", email: "t@t", timestamp: 500, timezone: "+0000" };
    const emptyTree = store.write({ type: "tree", entries: [] });
    const haveCommit = store.write({
      type: "commit" as const,
      tree: emptyTree,
      parents: [],
      author,
      committer: author,
      message: "local commit",
    });

    let round = 0;
    const transport = mockTransport(
      { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
      [{ name: "refs/heads/main", hash: HASH_A }],
      () => {
        round++;
        if (round === 1) {
          // 第一轮：返回 ACK ready（服务端准备好发送 packfile，但需要 done 信号）
          return encodePktLine(`ACK ${haveCommit} ready\n`);
        }
        // 第二轮（done 信号后）：返回 packfile
        return ackWithPackfile(HASH_A, "common");
      },
    );
    const adv = await transport.advertise();

    const result = await fetchPack(store, transport, adv, {
      wants: [HASH_A],
      haves: [haveCommit],
    });

    // ready 触发了额外一轮 done 请求
    expect(round).toBe(2);
    expect(result.objectCount).toBeGreaterThan(0);
  });
});

describe("fetchPack() 错误处理", () => {
  test("空 wants 列表时应抛出错误", async () => {
    const store = createMemoryObjectStore();
    const transport = mockTransport(
      { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
      [],
      () => Buffer.alloc(0),
    );
    const adv = await transport.advertise();

    // buildUploadPackRequestPrefix 在 wants 为空时抛出 Error
    expect(fetchPack(store, transport, adv, { wants: [] })).rejects.toThrow(
      "At least one want is required",
    );
  });

  test("服务端返回不完整 pkt-line 响应（无 packfile）时抛出 FetchPackError", async () => {
    const store = createMemoryObjectStore();
    const transport = mockTransport(
      { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
      [{ name: "refs/heads/main", hash: HASH_A }],
      () => {
        // 返回无 packfile 也不包含有效 pkt-line 的响应
        // 这会导致 parseUploadPackNegotiationResponse 抛出 NegotiationError
        return Buffer.from([0x01, 0x02, 0x03, 0x04]);
      },
    );
    const adv = await transport.advertise();

    const promise = fetchPack(store, transport, adv, {
      wants: [HASH_A],
    });

    // negotiateAndFetchPackfile 内部 sendRound 会抛出错误
    // 该错误会传播到 fetchPack
    expect(promise).rejects.toThrow();
  });
});
