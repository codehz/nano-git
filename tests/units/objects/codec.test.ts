/**
 * Git 对象编解码错误处理及工具函数测试
 */

import { describe, test, expect } from "bun:test";

import { bytes, bytesToUtf8 } from "../../helpers/bytes.ts";
import { InvalidObjectError } from "@/errors.ts";
import { deserialize, serializeContent, deserializeContent } from "@/objects/index.ts";

import type { GitBlob } from "@/types/index.ts";

describe("反序列化错误处理", () => {
  test("缺少 null 字节应抛出异常", () => {
    const data = bytes("invalid data without null byte");
    expect(() => deserialize(data)).toThrow(InvalidObjectError);
  });

  test("无效的 header 格式应抛出异常", () => {
    const data = bytes("invalid header\0content");
    expect(() => deserialize(data)).toThrow(InvalidObjectError);
  });

  test("大小不匹配应抛出异常", () => {
    const data = bytes("blob 100\0short");
    expect(() => deserialize(data)).toThrow(InvalidObjectError);
  });
});

describe("serializeContent / deserializeContent", () => {
  test("blob 内容序列化", () => {
    const blob: GitBlob = {
      type: "blob",
      content: bytes("test content"),
    };
    const content = serializeContent(blob);
    expect(bytesToUtf8(content)).toBe("test content");
  });

  test("deserializeContent 正确解析 blob", () => {
    const content = bytes("test content");
    const obj = deserializeContent("blob", content);
    expect(obj.type).toBe("blob");
    if (obj.type === "blob") {
      expect(bytesToUtf8(obj.content)).toBe("test content");
    }
  });
});
