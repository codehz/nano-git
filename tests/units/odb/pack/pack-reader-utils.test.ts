/**
 * pack/pack-reader-utils.ts 单元测试
 */

import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

import { InvalidPackError } from "@/core/errors.ts";
import { PACK_SIGNATURE, PACK_VERSION } from "@/pack/constants.ts";
import { parsePackHeader, readCompressedData } from "@/pack/pack-reader-utils.ts";

describe("parsePackHeader()", () => {
  function createValidPack(objectCount: number): Buffer {
    const header = Buffer.alloc(12);
    PACK_SIGNATURE.copy(header, 0);
    header.writeUInt32BE(PACK_VERSION, 4);
    header.writeUInt32BE(objectCount, 8);
    const checksum = createHash("sha1").update(header).digest();
    return Buffer.concat([header, checksum]);
  }

  test("解析有效 packfile 头部", () => {
    const data = createValidPack(5);
    const count = parsePackHeader(data);
    expect(count).toBe(5);
  });

  test("对象数量为 0", () => {
    const data = createValidPack(0);
    const count = parsePackHeader(data);
    expect(count).toBe(0);
  });

  test("数据太短抛出异常", () => {
    expect(() => parsePackHeader(Buffer.from([0, 0, 0]))).toThrow(InvalidPackError);
  });

  test("无效签名抛出异常", () => {
    const data = Buffer.alloc(40);
    data[0] = 0xff;
    expect(() => parsePackHeader(data)).toThrow(InvalidPackError);
  });

  test("不支持的版本抛出异常", () => {
    const header = Buffer.alloc(12);
    header.write("PACK", 0, "ascii");
    header.writeUInt32BE(3, 4);
    header.writeUInt32BE(0, 8);
    const data = Buffer.concat([header, createHash("sha1").update(header).digest()]);
    expect(() => parsePackHeader(data)).toThrow(InvalidPackError);
  });
});

describe("readCompressedData()", () => {
  test("解压 zlib 压缩数据", () => {
    const original = Buffer.from("hello world");
    const compressed = deflateSync(original);

    const [result, bytesRead] = readCompressedData(compressed, 0);
    expect(result.toString()).toBe("hello world");
    expect(bytesRead).toBe(compressed.length);
  });

  test("空数据解压", () => {
    const compressed = deflateSync(Buffer.from(""));

    const [result] = readCompressedData(compressed, 0);
    expect(result).toHaveLength(0);
  });
});
