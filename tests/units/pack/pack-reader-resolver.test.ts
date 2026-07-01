/**
 * pack/pack-reader-resolver.ts 单元测试
 */

import { describe, test, expect } from "bun:test";
import { deflateSync } from "node:zlib";

import { resolvePlainPackObject } from "@/pack/pack-reader-resolver.ts";
import { sha1 } from "@/types/index.ts";

describe("resolvePlainPackObject()", () => {
  test("解析普通 blob 对象", () => {
    const content = Buffer.from("hello world");
    const compressed = deflateSync(content);
    // Construct full pack-like data: object header + compressed content
    const data = Buffer.concat([Buffer.from([0x00]), compressed]);

    const result = resolvePlainPackObject(data, 1, 0, 3); // type 3 = blob
    expect(result.object.type).toBe("blob");
    expect(result.object.hash).toBe(sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"));
    expect(result.object.offset).toBe(0);
    expect(result.nextOffset).toBe(1 + compressed.length);
  });

  test("nextOffset 精确定位", () => {
    const content = Buffer.from("hello world");
    const compressed = deflateSync(content);
    // Simulate packed data: first object compressed data only
    const data = Buffer.concat([Buffer.from([0x00, 0x00]), compressed, Buffer.from("trailing")]);

    const result1 = resolvePlainPackObject(data, 2, 0, 3);
    expect(result1.nextOffset).toBe(2 + compressed.length);

    // nextOffset should be less than total length
    expect(result1.nextOffset).toBeLessThan(data.length);
  });
});
