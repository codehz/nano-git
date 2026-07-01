/**
 * transport/client/receive-pack/request.ts 单元测试
 *
 * 覆盖 buildReceivePackRequest 纯函数
 */

import { describe, test, expect } from "bun:test";

import { buildReceivePackRequest } from "@/transport/client/receive-pack/request.ts";
import { parsePktLines } from "@/transport/protocol/pkt-line.ts";
import { sha1 } from "@/types/index.ts";

import type { ReceivePackCommand } from "@/transport/client/receive-pack/request.ts";

const HASH_A = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const HASH_B = sha1("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
const ZERO_HASH = sha1("0000000000000000000000000000000000000000");

function makeCmd(refName: string, oldHash = ZERO_HASH, newHash = HASH_A): ReceivePackCommand {
  return { oldHash, newHash, refName };
}

describe("buildReceivePackRequest()", () => {
  test("单命令带 capabilities", () => {
    const buf = buildReceivePackRequest([makeCmd("refs/heads/main")], Buffer.alloc(0), [
      "report-status",
      "side-band-64k",
    ]);
    const text = buf.toString("utf-8");

    // 首行应包含 capabilities，以 NUL 分隔
    expect(text).toContain("refs/heads/main");
    expect(text).toContain("report-status");
    expect(text).toContain("side-band-64k");
    // 应有 flush
    expect(text).toContain("0000");
  });

  test("多命令仅首行带 capabilities", () => {
    const buf = buildReceivePackRequest(
      [makeCmd("refs/heads/a"), makeCmd("refs/heads/b")],
      Buffer.alloc(0),
      ["report-status"],
    );
    const lines = parsePktLines(buf);

    const dataLines = lines.filter((l) => l.type === "data");
    expect(dataLines).toHaveLength(2);

    const text0 = dataLines[0]!.payload.toString("utf-8");
    const text1 = dataLines[1]!.payload.toString("utf-8");

    // 首行带 capabilities
    expect(text0).toContain("refs/heads/a");
    expect(text0).toContain("report-status");
    // 第二行不带 capabilities
    expect(text1).toContain("refs/heads/b");
    expect(text1).not.toContain("report-status");
  });

  test("packfile 数据追加在 flush 之后", () => {
    const packfile = Buffer.from("PACK\u0000\u0000\u0000\u0002somepackdata");
    const buf = buildReceivePackRequest([makeCmd("refs/heads/main")], packfile, ["report-status"]);

    // 找到最后一个 0000（flush）之后的内容
    const flushMarker = Buffer.from("0000", "utf-8");
    const lastFlushIdx = buf.lastIndexOf(flushMarker);
    expect(lastFlushIdx).not.toBe(-1);

    const afterFlush = buf.subarray(lastFlushIdx + 4);
    expect(afterFlush).toEqual(packfile);
  });

  test("空 packfile 不追加额外数据", () => {
    const buf = buildReceivePackRequest([makeCmd("refs/heads/main")], Buffer.alloc(0), [
      "report-status",
    ]);
    const lines = parsePktLines(buf);

    // 应只有命令行 + flush
    const dataLines = lines.filter((l) => l.type === "data");
    const flushLines = lines.filter((l) => l.type === "flush");

    expect(dataLines).toHaveLength(1);
    expect(flushLines).toHaveLength(1);
    expect(lines).toHaveLength(2);
  });

  test("无 capabilities 时命令行不带 NUL", () => {
    const buf = buildReceivePackRequest([makeCmd("refs/heads/main")], Buffer.alloc(0), []);
    const text = buf.toString("utf-8");

    // 不应包含 NUL
    expect(text).not.toContain("\0");
    expect(text).toContain("refs/heads/main");
  });

  test("删除操作（000...0 newHash）生成正确命令", () => {
    const buf = buildReceivePackRequest(
      [makeCmd("refs/heads/feature", HASH_A, ZERO_HASH)],
      Buffer.alloc(0),
      ["report-status"],
    );
    const text = buf.toString("utf-8");

    expect(text).toContain(`${HASH_A} ${ZERO_HASH} refs/heads/feature`);
  });

  test("空命令列表抛出错误", () => {
    expect(() => buildReceivePackRequest([], Buffer.alloc(0), ["report-status"])).toThrow(
      "At least one command is required",
    );
  });

  test("命令内容按 oldHash newHash refName 顺序排列", () => {
    const buf = buildReceivePackRequest(
      [makeCmd("refs/heads/main", HASH_A, HASH_B)],
      Buffer.alloc(0),
      ["report-status"],
    );
    const lines = parsePktLines(buf);
    const dataLine = lines.find((l) => l.type === "data");
    expect(dataLine).toBeDefined();
    if (dataLine?.type === "data") {
      const payload = dataLine.payload.toString("utf-8");
      // 格式: <old-hash> <new-hash> <ref-name>\0<capabilities>
      const cmdLine = payload.split("\0")[0];
      expect(cmdLine).toBe(`${HASH_A} ${HASH_B} refs/heads/main`);
    }
  });
});
