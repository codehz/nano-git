import { describe, expect, test } from "bun:test";

import {
  allocBytes,
  asciiToBytes,
  bytesEqual,
  bytesToBase64,
  bytesToHex,
  bytesToUtf8,
  concatBytes,
  copyBytes,
  hexToBytes,
  readU32BE,
  readU32LE,
  readU64BE,
  utf8ToBytes,
  writeU32BE,
  writeU64BE,
} from "../../src/bytes.ts";

describe("bytes", () => {
  test("utf8 roundtrip", () => {
    const text = "hello 世界";
    expect(bytesToUtf8(utf8ToBytes(text))).toBe(text);
  });

  test("hex roundtrip", () => {
    const hex = "deadbeef0123456789abcdef";
    expect(bytesToHex(hexToBytes(hex))).toBe(hex);
  });

  test("hexToBytes rejects odd length", () => {
    expect(() => hexToBytes("abc")).toThrow("invalid hex string length");
  });

  test("hexToBytes rejects invalid characters", () => {
    expect(() => hexToBytes("gg")).toThrow("invalid hex character");
  });

  test("ascii roundtrip", () => {
    const text = "PACK";
    expect(bytesToUtf8(asciiToBytes(text))).toBe(text);
  });

  test("concatBytes", () => {
    const a = utf8ToBytes("hello");
    const b = utf8ToBytes(" world");
    expect(bytesToUtf8(concatBytes(a, b))).toBe("hello world");
  });

  test("allocBytes", () => {
    const buf = allocBytes(4);
    expect(buf).toEqual(new Uint8Array([0, 0, 0, 0]));
    expect(allocBytes(3, 0xff)).toEqual(new Uint8Array([0xff, 0xff, 0xff]));
  });

  test("bytesEqual", () => {
    expect(bytesEqual(utf8ToBytes("abc"), utf8ToBytes("abc"))).toBe(true);
    expect(bytesEqual(utf8ToBytes("abc"), utf8ToBytes("abd"))).toBe(false);
    expect(bytesEqual(utf8ToBytes("ab"), utf8ToBytes("abc"))).toBe(false);
  });

  test("copyBytes", () => {
    const dest = allocBytes(6);
    const src = utf8ToBytes("hello");
    copyBytes(dest, 1, src);
    expect(bytesToUtf8(dest)).toBe("\0hello\0".slice(0, 6).replace("\0hello", "\0hello"));
    expect(dest[0]).toBe(0);
    expect(dest[1]).toBe("h".charCodeAt(0));
  });

  test("read/write U32BE", () => {
    const buf = allocBytes(4);
    writeU32BE(buf, 0, 0x01020304);
    expect(readU32BE(buf, 0)).toBe(0x01020304);
  });

  test("read U32LE", () => {
    const buf = new Uint8Array([0x04, 0x03, 0x02, 0x01]);
    expect(readU32LE(buf, 0)).toBe(0x01020304);
  });

  test("read/write U64BE", () => {
    const buf = allocBytes(8);
    writeU64BE(buf, 0, 0x0102030405060708n);
    expect(readU64BE(buf, 0)).toBe(0x0102030405060708n);
  });

  test("bytesToBase64", () => {
    expect(bytesToBase64(utf8ToBytes("hello"))).toBe("aGVsbG8=");
  });
});
