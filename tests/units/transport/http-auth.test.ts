/**
 * Git Smart HTTP 认证头构造测试
 */

import { describe, expect, test } from "bun:test";

import { bytesToUtf8 } from "../../helpers/bytes.ts";
import { buildGitHttpAuthHeader } from "@/transport/client/http-auth.ts";

function decodeBasicAuth(encoded: string): string {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)!;
  }
  return bytesToUtf8(bytes);
}

describe("buildGitHttpAuthHeader", () => {
  test("使用 Basic 方案而非 Bearer", () => {
    const header = buildGitHttpAuthHeader("user", "pass");
    expect(header.startsWith("Basic ")).toBe(true);
    expect(header.startsWith("Bearer ")).toBe(false);
  });

  test("编码为 username:password", () => {
    const header = buildGitHttpAuthHeader("x-access-token", "ghp_testtoken");
    const encoded = header.slice("Basic ".length);
    expect(decodeBasicAuth(encoded)).toBe("x-access-token:ghp_testtoken");
  });

  test("password 中的特殊字符也能正确编码", () => {
    const password = "tok:en/with+special=";
    const header = buildGitHttpAuthHeader("user", password);
    const encoded = header.slice("Basic ".length);
    expect(decodeBasicAuth(encoded)).toBe(`user:${password}`);
  });
});
