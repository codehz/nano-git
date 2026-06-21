/**
 * negotiate（请求生成）单元测试
 *
 * 覆盖场景：
 * - 初始 clone：want + capabilities + done
 * - 多个 want
 * - 增量 fetch：want + 批量 have + done
 * - have 分批（每批 ≤ 32 条 flush 分隔）
 * - 空 haves
 * - 空 capabilities
 * - 空 wants 应抛出错误
 */

import { describe, test, expect } from "bun:test";
import {
  buildUploadPackNegotiationRound,
  buildUploadPackRequest,
  collectHaveCommits,
  parseUploadPackNegotiationResponse,
} from "../../../src/transport/negotiate.ts";
import { parsePktLines, encodePktLine } from "../../../src/transport/pkt-line.ts";
import { sha1, type SHA1, type GitCommit } from "../../../src/core/types.ts";
import { createMemoryObjectStore } from "../../../src/odb/memory-store.ts";
import { serialize } from "../../../src/objects/index.ts";

// ============================================================================
// 辅助函数
// ============================================================================

function dataPayload(line: unknown): string {
  if (line && typeof line === "object" && "type" in line) {
    const l = line as { type: string; payload?: Buffer };
    if (l.type === "data" && l.payload) {
      return l.payload.toString("utf-8");
    }
  }
  return "";
}

// ============================================================================
// 辅助函数
// ============================================================================

/** 创建一个提交对象并写入 store，返回哈希 */
function createTestCommit(
  store: ReturnType<typeof createMemoryObjectStore>,
  tree: SHA1,
  parents: SHA1[],
  timestamp: number,
  msg?: string,
): SHA1 {
  const commit: GitCommit = {
    type: "commit",
    tree,
    parents,
    author: { name: "T", email: "t@t", timestamp, timezone: "+0000" },
    committer: { name: "T", email: "t@t", timestamp, timezone: "+0000" },
    message: msg ?? `commit at ${timestamp}`,
  };
  // 直接用 serialize + write raw bytes，避免 hashObject 逻辑干扰
  const data = serialize(commit);
  return store.write(commit);
}

// ============================================================================
// collectHaveCommits
// ============================================================================

describe("collectHaveCommits()", () => {
  const treeHash = sha1("0000000000000000000000000000000000000001");

  test("单链提交：从最新遍历到最旧，按时间升序返回", () => {
    const store = createMemoryObjectStore();

    // 构造提交链：c1(ts=100) ← c2(ts=200) ← c3(ts=300)
    const c1 = createTestCommit(store, treeHash, [], 100);
    const c2 = createTestCommit(store, treeHash, [c1], 200);
    const c3 = createTestCommit(store, treeHash, [c2], 300);

    const result = collectHaveCommits(store, [c3]);

    // 应返回 [c1, c2, c3]（按时间升序）
    expect(result).toEqual([c1, c2, c3]);
  });

  test("多个 tips：合并并去重后返回排序结果", () => {
    const store = createMemoryObjectStore();

    // 分支一：c1(100) ← c2(200)
    const c1 = createTestCommit(store, treeHash, [], 100);
    const c2 = createTestCommit(store, treeHash, [c1], 200);

    // 分支二：c1(100) ← c3(300)（c1 是共同祖先）
    const c3 = createTestCommit(store, treeHash, [c1], 300);

    const result = collectHaveCommits(store, [c2, c3]);

    // 应返回 [c1, c2, c3]，c1 只出现一次
    expect(result).toEqual([c1, c2, c3]);
  });

  test("仅收集 commit 对象，跳过 tree/blob", () => {
    const store = createMemoryObjectStore();

    // 写入一个 tree 和一个 blob，确保它们不被收集
    const blobHash = store.write({ type: "blob", content: Buffer.from("data") });
    const treeEntryHash = store.write({
      type: "tree",
      entries: [{ mode: "100644", name: "f", hash: blobHash }],
    });

    // commit 指向 tree
    const commit = createTestCommit(store, treeEntryHash, [], 100);

    const result = collectHaveCommits(store, [commit]);

    // 只应包含 commit，不应包含 tree 或 blob 的哈希
    expect(result).toEqual([commit]);
    expect(result).not.toContain(treeEntryHash);
    expect(result).not.toContain(blobHash);
  });

  test("空 tips 返回空数组", () => {
    const store = createMemoryObjectStore();
    const result = collectHaveCommits(store, []);
    expect(result).toEqual([]);
  });

  test("不存在的对象被跳过", () => {
    const store = createMemoryObjectStore();
    const unknown = sha1("ffffffffffffffffffffffffffffffffffffffff");
    const result = collectHaveCommits(store, [unknown]);
    expect(result).toEqual([]);
  });

  test("merge commit：两个父节点都被遍历", () => {
    const store = createMemoryObjectStore();

    // c1(100) ─┐
    //           ├─ c3(300)
    // c2(200) ─┘
    const c1 = createTestCommit(store, treeHash, [], 100);
    const c2 = createTestCommit(store, treeHash, [], 200);
    const c3 = createTestCommit(store, treeHash, [c1, c2], 300);

    const result = collectHaveCommits(store, [c3]);

    // 应包含所有 3 个 commit，按时间升序
    expect(result).toEqual([c1, c2, c3]);
  });
});

// ============================================================================
// buildUploadPackRequest
// ============================================================================

describe("buildUploadPackRequest()", () => {
  const hash1 = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
  const hash2 = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const hash3 = sha1("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

  test("初始 clone：单 want + capabilities + done", () => {
    const body = buildUploadPackRequest([hash1], [], ["multi_ack", "side-band-64k", "ofs-delta"]);
    const lines = parsePktLines(body);

    // want + flush + done = 3 帧
    expect(lines).toHaveLength(3);

    // 第 1 帧：want 行带 capabilities
    const wantLine = dataPayload(lines[0]!);
    expect(wantLine).toBe(`want ${hash1} multi_ack side-band-64k ofs-delta\n`);

    // 第 2 帧：flush
    expect(lines[1]!.type).toBe("flush");

    // 第 3 帧：done
    const doneLine = dataPayload(lines[2]!);
    expect(doneLine).toBe("done\n");
  });

  test("初始 clone：单 want + 空 capabilities + done", () => {
    const body = buildUploadPackRequest([hash1], [], []);
    const lines = parsePktLines(body);

    expect(lines).toHaveLength(3);
    const wantLine = dataPayload(lines[0]!);
    expect(wantLine).toBe(`want ${hash1}\n`);
  });

  test("多个 want：只有第一条带 capabilities", () => {
    const body = buildUploadPackRequest([hash1, hash2], [], ["multi_ack"]);
    const lines = parsePktLines(body);

    // 2 want + flush + done = 4
    expect(lines).toHaveLength(4);

    const want1 = dataPayload(lines[0]!);
    expect(want1).toBe(`want ${hash1} multi_ack\n`);

    const want2 = dataPayload(lines[1]!);
    expect(want2).toBe(`want ${hash2}\n`);
  });

  test("增量 fetch：want + have + done", () => {
    const body = buildUploadPackRequest([hash1], [hash2, hash3], ["multi_ack", "side-band-64k"]);
    const lines = parsePktLines(body);

    // want + flush + 2 have + done = 5
    expect(lines).toHaveLength(5);

    expect(lines[0]!.type).toBe("data");
    const wantLine = dataPayload(lines[0]!);
    expect(wantLine).toBe(`want ${hash1} multi_ack side-band-64k\n`);

    expect(lines[1]!.type).toBe("flush");

    expect(dataPayload(lines[2]!)).toBe(`have ${hash2}\n`);
    expect(dataPayload(lines[3]!)).toBe(`have ${hash3}\n`);

    expect(lines[4]!.type).toBe("data");
    expect(dataPayload(lines[4]!)).toBe("done\n");
  });

  test("大量 have：最终请求中不插入中间 flush", () => {
    // 创建 35 个 have 哈希（每个都是合法的 40 位十六进制）
    const manyHaves: string[] = [];
    for (let i = 0; i < 35; i++) {
      const idx = i.toString(16).padStart(2, "0");
      manyHaves.push(`0000000000000000000000000000000000${idx}0000`);
    }
    const haves = manyHaves.map((h) => sha1(h));

    const body = buildUploadPackRequest([hash1], haves, ["multi_ack"]);
    const lines = parsePktLines(body);

    // want + flush + 35 have + done
    let dataCount = 0;
    let flushCount = 0;
    for (const line of lines) {
      if (line.type === "data") dataCount++;
      if (line.type === "flush") flushCount++;
    }

    // 35 have + 1 want + 1 done = 37 data 帧
    expect(dataCount).toBe(37);
    // 仅保留 want 后的 flush
    expect(flushCount).toBe(1);
  });

  test("刚好 32 个 have：仍然只保留 want 后的 flush", () => {
    const manyHaves: string[] = [];
    for (let i = 0; i < 32; i++) {
      const idx = i.toString(16).padStart(2, "0");
      manyHaves.push(`0000000000000000000000000000000000${idx}0000`);
    }
    const haves = manyHaves.map((h) => sha1(h));

    const body = buildUploadPackRequest([hash1], haves, ["multi_ack"]);
    const lines = parsePktLines(body);

    // want(0) + flush(1) + 32 have(2-33) + done(34)
    const flushPositions: number[] = [];
    lines.forEach((line, idx) => {
      if (line.type === "flush") flushPositions.push(idx);
    });

    // flush 应该仅在 want 后
    expect(flushPositions).toEqual([1]);
  });

  test("协商轮次请求：have 后以 flush 结束且不带 done", () => {
    const body = buildUploadPackNegotiationRound([hash1], [hash2, hash3], ["multi_ack"]);
    const lines = parsePktLines(body);

    expect(lines).toHaveLength(5);
    expect(dataPayload(lines[0]!)).toBe(`want ${hash1} multi_ack\n`);
    expect(lines[1]!.type).toBe("flush");
    expect(dataPayload(lines[2]!)).toBe(`have ${hash2}\n`);
    expect(dataPayload(lines[3]!)).toBe(`have ${hash3}\n`);
    expect(lines[4]!.type).toBe("flush");
  });

  test("空 wants 应抛出错误", () => {
    expect(() => buildUploadPackRequest([], [], ["multi_ack"])).toThrow(
      "At least one want is required",
    );
  });

  // ============================================================================
  // Shallow fetch (deepen)
  // ============================================================================

  describe("shallow fetch (deepen)", () => {
    test("shallow clone：want + flush + deepen + flush + done", () => {
      const body = buildUploadPackRequest([hash1], [], ["multi_ack"], 3);
      const lines = parsePktLines(body);

      // want + flush + deepen + flush + done = 5
      expect(lines).toHaveLength(5);

      expect(lines[0]!.type).toBe("data");
      expect(dataPayload(lines[0]!)).toBe(`want ${hash1} multi_ack\n`);

      expect(lines[1]!.type).toBe("flush");

      expect(lines[2]!.type).toBe("data");
      expect(dataPayload(lines[2]!)).toBe("deepen 3\n");

      expect(lines[3]!.type).toBe("flush");

      expect(lines[4]!.type).toBe("data");
      expect(dataPayload(lines[4]!)).toBe("done\n");
    });

    test("shallow + incremental：deepen 出现在 haves 之前", () => {
      const body = buildUploadPackRequest([hash1], [hash2], [], 5);
      const lines = parsePktLines(body);

      // want + flush + deepen + flush + 1 have + done = 6
      expect(lines).toHaveLength(6);

      expect(dataPayload(lines[0]!)).toBe(`want ${hash1}\n`);
      expect(lines[1]!.type).toBe("flush");
      expect(dataPayload(lines[2]!)).toBe("deepen 5\n");
      expect(lines[3]!.type).toBe("flush");
      expect(dataPayload(lines[4]!)).toBe(`have ${hash2}\n`);
      expect(dataPayload(lines[5]!)).toBe("done\n");
    });

    test("depth 为 0 应抛出错误", () => {
      expect(() => buildUploadPackRequest([hash1], [], [], 0)).toThrow(
        "Depth must be a positive integer",
      );
    });

    test("depth 为负数应抛出错误", () => {
      expect(() => buildUploadPackRequest([hash1], [], [], -1)).toThrow(
        "Depth must be a positive integer",
      );
    });
  });
});

describe("parseUploadPackNegotiationResponse()", () => {
  test("解析 ACK continue 与 NAK", () => {
    const hash = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
    const data = Buffer.concat([encodePktLine(`ACK ${hash} continue\n`), encodePktLine("NAK\n")]);

    const result = parseUploadPackNegotiationResponse(data);
    expect(result.nak).toBe(true);
    expect(result.hasPackfile).toBe(false);
    expect(result.acknowledgements).toEqual([{ hash, status: "continue" }]);
  });

  test("识别带 side-band packfile 的响应", () => {
    const data = Buffer.concat([
      encodePktLine(Buffer.concat([Buffer.from([0x01]), Buffer.from("PACK")])),
    ]);
    const result = parseUploadPackNegotiationResponse(data);
    expect(result.hasPackfile).toBe(true);
  });
});
