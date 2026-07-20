/**
 * Git Smart HTTP 认证头构造测试
 */

import { describe, expect, test } from "bun:test";

import { buildGitHttpAuthHeader } from "@/transport/client/http-auth.ts";

describe("buildGitHttpAuthHeader", () => {
  test("使用 Basic 方案而非 Bearer", () => {
    const header = buildGitHttpAuthHeader("ghp_testtoken");
    expect(header.startsWith("Basic ")).toBe(true);
    expect(header.startsWith("Bearer ")).toBe(false);
  });

  test("编码为 x-access-token:<token>", () => {
    const header = buildGitHttpAuthHeader("ghp_testtoken");
    const encoded = header.slice("Basic ".length);
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    expect(decoded).toBe("x-access-token:ghp_testtoken");
  });

  test("token 中的特殊字符也能正确编码", () => {
    const token = "tok:en/with+special=";
    const header = buildGitHttpAuthHeader(token);
    const encoded = header.slice("Basic ".length);
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    expect(decoded).toBe(`x-access-token:${token}`);
  });
});
