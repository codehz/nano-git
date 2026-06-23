/**
 * objects/author.ts 单元测试
 *
 * 覆盖 formatAuthor / parseAuthor
 */

import { describe, test, expect } from "bun:test";

import { InvalidObjectError } from "@/core/errors.ts";
import { formatAuthor, parseAuthor } from "@/objects/author.ts";

import type { GitAuthor } from "@/core/types.ts";

describe("formatAuthor()", () => {
  test("基本作者信息格式化", () => {
    const author: GitAuthor = {
      name: "John Doe",
      email: "john@example.com",
      timestamp: 1234567890,
      timezone: "+0800",
    };
    expect(formatAuthor(author)).toBe("John Doe <john@example.com> 1234567890 +0800");
  });

  test("带特殊字符的名称", () => {
    const author: GitAuthor = {
      name: "张三",
      email: "zhangsan@example.com",
      timestamp: 1700000000,
      timezone: "+0000",
    };
    const result = formatAuthor(author);
    expect(result).toContain("张三 <zhangsan@example.com>");
    expect(result).toContain("1700000000 +0000");
  });

  test("负数时区", () => {
    const author: GitAuthor = {
      name: "Test",
      email: "t@t.com",
      timestamp: 0,
      timezone: "-0530",
    };
    expect(formatAuthor(author)).toBe("Test <t@t.com> 0 -0530");
  });
});

describe("parseAuthor()", () => {
  test("标准格式解析", () => {
    const result = parseAuthor("John Doe <john@example.com> 1234567890 +0800");
    expect(result).toEqual({
      name: "John Doe",
      email: "john@example.com",
      timestamp: 1234567890,
      timezone: "+0800",
    });
  });

  test("带点号的 email", () => {
    const result = parseAuthor("Alice <alice.bob@company.co.uk> 998877665 +0100");
    expect(result.name).toBe("Alice");
    expect(result.email).toBe("alice.bob@company.co.uk");
    expect(result.timestamp).toBe(998877665);
    expect(result.timezone).toBe("+0100");
  });

  test("根时区 +0000", () => {
    const result = parseAuthor("root <root@localhost> 1000000000 +0000");
    expect(result.timezone).toBe("+0000");
  });

  test("无效格式抛出 InvalidObjectError", () => {
    expect(() => parseAuthor("no angle brackets 123 +0000")).toThrow(InvalidObjectError);
  });

  test("缺少时区抛出异常", () => {
    expect(() => parseAuthor("Name <email@e.com> 123")).toThrow(InvalidObjectError);
  });

  test("空字符串抛出异常", () => {
    expect(() => parseAuthor("")).toThrow(InvalidObjectError);
  });

  test("formatAuthor 与 parseAuthor 往返一致", () => {
    const original: GitAuthor = {
      name: "Committer",
      email: "commit@example.com",
      timestamp: 987654321,
      timezone: "-1200",
    };
    const formatted = formatAuthor(original);
    const parsed = parseAuthor(formatted);
    expect(parsed).toEqual(original);
  });
});
