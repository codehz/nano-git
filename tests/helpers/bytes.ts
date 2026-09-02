/**
 * 测试用字节辅助函数
 */

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
  toUint8Array,
  utf8ToBytes,
  writeU16BE,
  writeU32BE,
  writeU64BE,
  writeU8,
} from "../../src/bytes.ts";

export {
  allocBytes,
  asciiToBytes,
  bytesEqual,
  bytesToBase64,
  bytesToHex,
  bytesToUtf8,
  concatBytes,
  copyBytes,
  hexToBytes,
  toUint8Array,
  utf8ToBytes,
  writeU16BE,
  writeU32BE,
  writeU64BE,
  writeU8,
};

/** UTF-8 字符串快捷编码 */
export function bytes(text: string): Uint8Array {
  return utf8ToBytes(text);
}
