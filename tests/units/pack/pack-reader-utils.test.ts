/**
 * pack/pack-reader-utils.ts 单元测试
 */

import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

import {
  allocBytes,
  asciiToBytes,
  bytes,
  bytesToUtf8,
  concatBytes,
  copyBytes,
  writeU32BE,
} from "../../helpers/bytes.ts";
import { InvalidPackError } from "@/errors.ts";
import { PACK_SIGNATURE, PACK_VERSION } from "@/pack/constants.ts";
import { parsePackHeader, readCompressedData } from "@/pack/reader/pack-reader-utils.ts";

describe("parsePackHeader()", () => {
  function createValidPack(objectCount: number): Uint8Array {
    const header = allocBytes(12);
    copyBytes(header, 0, PACK_SIGNATURE);
    writeU32BE(header, 4, PACK_VERSION);
    writeU32BE(header, 8, objectCount);
    const checksum = createHash("sha1").update(header).digest();
    return concatBytes(header, checksum);
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
    expect(() => parsePackHeader(Uint8Array.from([0, 0, 0]))).toThrow(InvalidPackError);
  });

  test("无效签名抛出异常", () => {
    const data = allocBytes(40);
    data[0] = 0xff;
    expect(() => parsePackHeader(data)).toThrow(InvalidPackError);
  });

  test("不支持的版本抛出异常", () => {
    const header = allocBytes(12);
    copyBytes(header, 0, asciiToBytes("PACK"));
    writeU32BE(header, 4, 3);
    writeU32BE(header, 8, 0);
    const data = concatBytes(header, createHash("sha1").update(header).digest());
    expect(() => parsePackHeader(data)).toThrow(InvalidPackError);
  });
});

describe("readCompressedData()", () => {
  test("解压 zlib 压缩数据", () => {
    const original = bytes("hello world");
    const compressed = deflateSync(original);

    const [result, bytesRead] = readCompressedData(compressed, 0);
    expect(bytesToUtf8(result)).toBe("hello world");
    expect(bytesRead).toBe(compressed.length);
  });

  test("空数据解压", () => {
    const compressed = deflateSync(bytes(""));

    const [result] = readCompressedData(compressed, 0);
    expect(result).toHaveLength(0);
  });
});
