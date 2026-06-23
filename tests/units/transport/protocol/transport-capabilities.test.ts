/**
 * transport/protocol/transport-capabilities.ts 单元测试
 *
 * 覆盖 extractCapabilities / PUSH_CAPABILITIES
 */

import { describe, test, expect } from "bun:test";

import {
  extractCapabilities,
  PUSH_CAPABILITIES,
} from "@/transport/protocol/transport-capabilities.ts";

describe("PUSH_CAPABILITIES", () => {
  test("应包含必需的 push 能力", () => {
    expect(PUSH_CAPABILITIES).toContain("report-status");
    expect(PUSH_CAPABILITIES).toContain("side-band-64k");
    expect(PUSH_CAPABILITIES).toContain("ofs-delta");
    expect(PUSH_CAPABILITIES).toContain("no-progress");
    expect(PUSH_CAPABILITIES).toContain("delete-refs");
  });
});

describe("extractCapabilities()", () => {
  test("从服务端能力中提取交集", () => {
    const serverCaps = {
      "report-status": true as true,
      "side-band-64k": true as true,
      "unknown-opt": "v1" as string,
    };
    const result = extractCapabilities(serverCaps, PUSH_CAPABILITIES);
    expect(result).toContain("report-status");
    expect(result).toContain("side-band-64k");
    expect(result).not.toContain("unknown-opt");
  });

  test("不支持任何能力时返回空数组", () => {
    const serverCaps: Record<string, string | true> = { "unknown-opt": "v1" };
    const result = extractCapabilities(serverCaps, PUSH_CAPABILITIES);
    expect(result).toEqual([]);
  });

  test("所有能力都支持时返回完整列表", () => {
    const serverCaps: Record<string, string | true> = {};
    for (const cap of PUSH_CAPABILITIES) {
      serverCaps[cap] = true;
    }
    const result = extractCapabilities(serverCaps, PUSH_CAPABILITIES);
    expect(result.sort()).toEqual([...PUSH_CAPABILITIES].sort());
  });

  test("空服务端能力返回空数组", () => {
    expect(extractCapabilities({}, PUSH_CAPABILITIES)).toEqual([]);
  });

  test("区分大小写", () => {
    const serverCaps: Record<string, string | true> = {
      "Report-Status": true,
      "report-status": true,
    };
    const result = extractCapabilities(serverCaps, ["report-status"]);
    expect(result).toEqual(["report-status"]);
  });

  test("自定义支持列表", () => {
    const serverCaps: Record<string, string | true> = { a: true, b: true, c: true };
    const result = extractCapabilities(serverCaps, ["a", "c"]);
    expect(result).toEqual(["a", "c"]);
  });
});
