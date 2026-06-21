/**
 * Git Blob 对象序列化/反序列化测试
 */

import { describe, test, expect } from "bun:test";

import { serialize, deserialize } from "@/objects/index.ts";

import type { GitBlob } from "@/core/types.ts";

describe("Blob 序列化", () => {
  test("序列化 blob 对象", () => {
    const blob: GitBlob = {
      type: "blob",
      content: Buffer.from("hello"),
    };
    const serialized = serialize(blob);
    expect(serialized.toString("utf-8")).toBe("blob 5\0hello");
  });

  test("序列化空 blob", () => {
    const blob: GitBlob = {
      type: "blob",
      content: Buffer.from(""),
    };
    const serialized = serialize(blob);
    expect(serialized.toString("utf-8")).toBe("blob 0\0");
  });

  test("反序列化 blob 对象", () => {
    const blob: GitBlob = {
      type: "blob",
      content: Buffer.from("hello world"),
    };
    const serialized = serialize(blob);
    const deserialized = deserialize(serialized);

    expect(deserialized.type).toBe("blob");
    if (deserialized.type === "blob") {
      expect(deserialized.content.toString("utf-8")).toBe("hello world");
    }
  });

  test("序列化/反序列化往返保持一致", () => {
    const blob: GitBlob = {
      type: "blob",
      content: Buffer.from("测试中文内容"),
    };
    const deserialized = deserialize(serialize(blob));
    expect(deserialized.type).toBe("blob");
    if (deserialized.type === "blob") {
      expect(deserialized.content.toString("utf-8")).toBe("测试中文内容");
    }
  });
});
