/**
 * negotiate 请求构造单元测试（新增接口）
 *
 * 覆盖场景：
 * - buildUploadPackRequestPrefix：
 *   - 只包含 want + flush，不包含任何 have
 *   - 包含 deepen 和 shallow
 *   - 空 wants 应抛出错误
 * - buildUploadPackNegotiationRequest：
 *   - 非最终轮：前缀后追加 replayHaves + newHaves + flush
 *   - 最终轮：前缀后追加 replayHaves + newHaves + done
 *   - 不会自动混入历史全部 have
 *   - replayHaves 和 newHaves 可以同时存在
 *   - 空的 replayHaves 和 newHaves（只有前缀 + 结束标记）
 */

import { describe, test, expect } from "bun:test";

import { sha1, type SHA1 } from "@/core/types.ts";
import {
  buildUploadPackRequestPrefix,
  buildUploadPackNegotiationRequest,
  createNegotiationState,
  absorbAckCommon,
  mergeShallowInfo,
  nextHaveChunk,
} from "@/transport/negotiate.ts";
import { parsePktLines } from "@/transport/pkt-line.ts";

import type { UploadPackNegotiationResponse } from "@/transport/negotiate.ts";

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

function countFlush(lines: ReturnType<typeof parsePktLines>): number {
  return lines.filter((l) => l.type === "flush").length;
}

// ============================================================================
// buildUploadPackRequestPrefix
// ============================================================================

describe("buildUploadPackRequestPrefix()", () => {
  const hash1 = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
  const hash2 = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

  test("单 want + capabilities + flush，不包含任何 have", () => {
    const prefix = buildUploadPackRequestPrefix({
      wants: [hash1],
      capabilities: ["multi_ack", "side-band-64k", "ofs-delta"],
    });
    const lines = parsePktLines(prefix);

    // want + flush = 2 帧
    expect(lines).toHaveLength(2);

    // 第 1 帧：want 行带 capabilities
    expect(dataPayload(lines[0]!)).toBe(`want ${hash1} multi_ack side-band-64k ofs-delta\n`);

    // 第 2 帧：flush
    expect(lines[1]!.type).toBe("flush");

    // 不得包含 have 行
    for (const line of lines) {
      if (line.type === "data") {
        expect(line.payload.toString("utf-8")).not.toMatch(/^have /);
      }
    }
  });

  test("多个 want：只有第一条带 capabilities", () => {
    const prefix = buildUploadPackRequestPrefix({
      wants: [hash1, hash2],
      capabilities: ["multi_ack"],
    });
    const lines = parsePktLines(prefix);

    // 2 want + flush = 3
    expect(lines).toHaveLength(3);

    expect(dataPayload(lines[0]!)).toBe(`want ${hash1} multi_ack\n`);
    expect(dataPayload(lines[1]!)).toBe(`want ${hash2}\n`);
    expect(lines[2]!.type).toBe("flush");
  });

  test("包含 deepen 和 shallow", () => {
    const shallowHash = sha1("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    const prefix = buildUploadPackRequestPrefix({
      wants: [hash1],
      capabilities: ["shallow"],
      depth: 3,
      shallow: [shallowHash],
    });
    const lines = parsePktLines(prefix);

    // want + deepen + shallow + flush = 4
    expect(lines).toHaveLength(4);

    expect(dataPayload(lines[0]!)).toBe(`want ${hash1} shallow\n`);
    expect(dataPayload(lines[1]!)).toBe("deepen 3\n");
    expect(dataPayload(lines[2]!)).toBe(`shallow ${shallowHash}\n`);
    expect(lines[3]!.type).toBe("flush");
  });

  test("空 wants 应抛出错误", () => {
    expect(() =>
      buildUploadPackRequestPrefix({
        wants: [],
        capabilities: ["multi_ack"],
      }),
    ).toThrow("At least one want is required");
  });

  test("depth 为 0 应抛出错误", () => {
    expect(() =>
      buildUploadPackRequestPrefix({
        wants: [hash1],
        capabilities: [],
        depth: 0,
      }),
    ).toThrow("Depth must be a positive integer");
  });

  test("prefix 不包含 have 行（即使有 depth 参数）", () => {
    const prefix = buildUploadPackRequestPrefix({
      wants: [hash1],
      capabilities: [],
      depth: 5,
    });
    const lines = parsePktLines(prefix);

    for (const line of lines) {
      if (line.type === "data") {
        expect(line.payload.toString("utf-8")).not.toMatch(/^have /);
      }
    }
    // deepen 后的 flush 是唯一 flush
    expect(countFlush(lines)).toBe(1);
  });
});

// ============================================================================
// buildUploadPackNegotiationRequest
// ============================================================================

describe("buildUploadPackNegotiationRequest()", () => {
  const hashW = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
  const hashC = sha1("cccccccccccccccccccccccccccccccccccccccc");
  const hashN1 = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const hashN2 = sha1("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

  const prefix = buildUploadPackRequestPrefix({
    wants: [hashW],
    capabilities: ["multi_ack", "side-band-64k"],
  });

  test("非最终轮：前缀后追加 replayHaves + newHaves + flush", () => {
    const body = buildUploadPackNegotiationRequest(prefix, [hashC], [hashN1, hashN2], false);
    const lines = parsePktLines(body);

    // prefix(2) + 1 replay + 2 new + flush = 6
    expect(lines).toHaveLength(6);

    // 验证前缀部分完好
    expect(dataPayload(lines[0]!)).toBe(`want ${hashW} multi_ack side-band-64k\n`);
    expect(lines[1]!.type).toBe("flush");

    // replayHaves 出现在 newHaves 之前
    expect(dataPayload(lines[2]!)).toBe(`have ${hashC}\n`);
    expect(dataPayload(lines[3]!)).toBe(`have ${hashN1}\n`);
    expect(dataPayload(lines[4]!)).toBe(`have ${hashN2}\n`);

    // 以 flush 结尾
    expect(lines[5]!.type).toBe("flush");

    // flush 计数：前缀一个 + 尾部一个 = 2
    expect(countFlush(lines)).toBe(2);
  });

  test("最终轮：前缀后追加 replayHaves + newHaves + done", () => {
    const body = buildUploadPackNegotiationRequest(prefix, [hashC], [hashN1], true);
    const lines = parsePktLines(body);

    // prefix(2) + 1 replay + 1 new + done = 5
    expect(lines).toHaveLength(5);

    // 验证前缀部分完好
    expect(dataPayload(lines[0]!)).toBe(`want ${hashW} multi_ack side-band-64k\n`);
    expect(lines[1]!.type).toBe("flush");

    expect(dataPayload(lines[2]!)).toBe(`have ${hashC}\n`);
    expect(dataPayload(lines[3]!)).toBe(`have ${hashN1}\n`);

    // 以 done 结尾
    expect(dataPayload(lines[4]!)).toBe("done\n");

    // flush 计数：仅前缀一个
    expect(countFlush(lines)).toBe(1);
  });

  test("不会自动混入历史全部 have", () => {
    // 只发 replayHaves，不发 newHaves
    const body = buildUploadPackNegotiationRequest(prefix, [hashC], [], false);
    const lines = parsePktLines(body);

    // prefix(2) + 1 replay + flush = 4
    expect(lines).toHaveLength(4);

    const haveLines = lines
      .filter((l) => l.type === "data")
      .map((l) => l.payload.toString("utf-8"))
      .filter((s) => s.startsWith("have "));

    // 只有 replayHaves，没有额外 have
    expect(haveLines).toEqual([`have ${hashC}\n`]);
  });

  test("空的 replayHaves 和 newHaves：只有前缀 + 结束标记", () => {
    // 非最终轮
    const body1 = buildUploadPackNegotiationRequest(prefix, [], [], false);
    const lines1 = parsePktLines(body1);
    expect(lines1).toHaveLength(3); // prefix(2) + flush
    expect(lines1[2]!.type).toBe("flush");

    // 最终轮
    const body2 = buildUploadPackNegotiationRequest(prefix, [], [], true);
    const lines2 = parsePktLines(body2);
    expect(lines2).toHaveLength(3); // prefix(2) + done
    expect(dataPayload(lines2[2]!)).toBe("done\n");
  });

  test("replayHaves 和 newHaves 可以同时存在", () => {
    const manyReplay: SHA1[] = [];
    const manyNew: SHA1[] = [];
    for (let i = 0; i < 3; i++) {
      const hex = i.toString(16).padStart(2, "0");
      manyReplay.push(`0000000000000000000000000000000000${hex}0000` as SHA1);
      manyNew.push(`0000000000000000000000000000000000${hex}1111` as SHA1);
    }

    const body = buildUploadPackNegotiationRequest(prefix, manyReplay, manyNew, true);
    const lines = parsePktLines(body);

    // prefix(2) + 3 replay + 3 new + done = 9
    expect(lines).toHaveLength(9);

    // replay 在前，new 在后
    for (let i = 0; i < 3; i++) {
      expect(dataPayload(lines[2 + i]!)).toBe(`have ${manyReplay[i]}\n`);
    }
    for (let i = 0; i < 3; i++) {
      expect(dataPayload(lines[5 + i]!)).toBe(`have ${manyNew[i]}\n`);
    }

    expect(dataPayload(lines[8]!)).toBe("done\n");
  });
});

// ============================================================================
// 协商状态
// ============================================================================

describe("协商状态管理", () => {
  const hash1 = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const hash2 = sha1("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  const hash3 = sha1("cccccccccccccccccccccccccccccccccccccccc");

  describe("createNegotiationState()", () => {
    test("创建空的初始状态", () => {
      const state = createNegotiationState();
      expect(state.commonToReplay).toEqual([]);
      expect(state.commonSet.size).toBe(0);
      expect(state.sentSet.size).toBe(0);
      expect(state.offset).toBe(0);
      expect(state.shallow).toEqual([]);
      expect(state.unshallow).toEqual([]);
    });
  });

  describe("absorbAckCommon()", () => {
    test("ACK common 应加入 commonToReplay", () => {
      const state = createNegotiationState();
      absorbAckCommon(state, { hash: hash1, status: "common" });
      expect(state.commonToReplay).toEqual([hash1]);
      expect(state.commonSet.has(hash1)).toBe(true);
    });

    test("ACK ready 也应加入 commonToReplay", () => {
      const state = createNegotiationState();
      absorbAckCommon(state, { hash: hash1, status: "ready" });
      expect(state.commonToReplay).toEqual([hash1]);
    });

    test("ACK continue 不加入 commonToReplay", () => {
      const state = createNegotiationState();
      absorbAckCommon(state, { hash: hash1, status: "continue" });
      expect(state.commonToReplay).toEqual([]);
      expect(state.commonSet.has(hash1)).toBe(false);
    });

    test("重复的 common 不重复添加", () => {
      const state = createNegotiationState();
      absorbAckCommon(state, { hash: hash1, status: "common" });
      absorbAckCommon(state, { hash: hash1, status: "common" });
      expect(state.commonToReplay).toEqual([hash1]);
      expect(state.commonSet.size).toBe(1);
    });

    test("多个不同的 common 都加入", () => {
      const state = createNegotiationState();
      absorbAckCommon(state, { hash: hash1, status: "common" });
      absorbAckCommon(state, { hash: hash2, status: "ready" });
      absorbAckCommon(state, { hash: hash3, status: "common" });
      expect(state.commonToReplay).toEqual([hash1, hash2, hash3]);
      expect(state.commonSet.size).toBe(3);
    });
  });

  describe("mergeShallowInfo()", () => {
    test("合并 shallow 到状态", () => {
      const state = createNegotiationState();
      const resp: UploadPackNegotiationResponse = {
        acknowledgements: [],
        nak: false,
        hasPackfile: false,
        shallow: [hash1, hash2],
        unshallow: [],
      };
      mergeShallowInfo(state, resp);
      expect(state.shallow).toEqual([hash1, hash2]);
    });

    test("合并 unshallow 到状态", () => {
      const state = createNegotiationState();
      const resp: UploadPackNegotiationResponse = {
        acknowledgements: [],
        nak: false,
        hasPackfile: false,
        shallow: [],
        unshallow: [hash3],
      };
      mergeShallowInfo(state, resp);
      expect(state.unshallow).toEqual([hash3]);
    });

    test("跨轮累计 shallow/unshallow", () => {
      const state = createNegotiationState();
      mergeShallowInfo(state, {
        acknowledgements: [],
        nak: false,
        hasPackfile: false,
        shallow: [hash1],
        unshallow: [],
      });
      mergeShallowInfo(state, {
        acknowledgements: [],
        nak: false,
        hasPackfile: false,
        shallow: [hash2],
        unshallow: [hash3],
      });
      expect(state.shallow).toEqual([hash1, hash2]);
      expect(state.unshallow).toEqual([hash3]);
    });

    test("重复的 shallow 不重复添加", () => {
      const state = createNegotiationState();
      mergeShallowInfo(state, {
        acknowledgements: [],
        nak: false,
        hasPackfile: false,
        shallow: [hash1],
        unshallow: [],
      });
      mergeShallowInfo(state, {
        acknowledgements: [],
        nak: false,
        hasPackfile: false,
        shallow: [hash1],
        unshallow: [],
      });
      expect(state.shallow).toEqual([hash1]);
    });
  });

  describe("nextHaveChunk()", () => {
    test("取出最多 maxPerRound 个未发送过的 commit", () => {
      const state = createNegotiationState();
      const haves = [hash1, hash2, hash3];
      const chunk = nextHaveChunk(haves, state, 2);
      expect(chunk).toEqual([hash1, hash2]);
      expect(state.offset).toBe(2);
      expect(state.sentSet.has(hash1)).toBe(true);
      expect(state.sentSet.has(hash2)).toBe(true);
      expect(state.sentSet.has(hash3)).toBe(false);
    });

    test("已发送过的 hash 自动跳过", () => {
      const state = createNegotiationState();
      state.sentSet.add(hash1);
      state.offset = 1;
      const haves = [hash1, hash2];
      const chunk = nextHaveChunk(haves, state, 2);
      // hash1 已发送，跳过；发送 hash2
      expect(chunk).toEqual([hash2]);
      expect(state.offset).toBe(2);
    });

    test("不足 maxPerRound 时全部取出", () => {
      const state = createNegotiationState();
      const haves = [hash1];
      const chunk = nextHaveChunk(haves, state, 32);
      expect(chunk).toEqual([hash1]);
      expect(state.offset).toBe(1);
    });

    test("空列表返回空数组", () => {
      const state = createNegotiationState();
      const chunk = nextHaveChunk([], state, 32);
      expect(chunk).toEqual([]);
      expect(state.offset).toBe(0);
    });
  });
});
