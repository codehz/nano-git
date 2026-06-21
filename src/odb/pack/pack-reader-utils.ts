/**
 * Packfile 读取底层辅助函数
 */

import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

import { InvalidPackError } from "../../core/errors.ts";
import { PACK_CHECKSUM_SIZE, PACK_HEADER_SIZE, PACK_SIGNATURE, PACK_VERSION } from "./constants.ts";

/**
 * 解析并校验 packfile 头部
 *
 * @param data - 完整的 packfile 数据
 * @returns 对象数量
 *
 * @example
 * ```ts
 * const objectCount = parsePackHeader(packData);
 * ```
 */
export function parsePackHeader(data: Buffer): number {
  if (data.length < PACK_HEADER_SIZE + PACK_CHECKSUM_SIZE) {
    throw new InvalidPackError("Packfile too small");
  }

  const signature = data.subarray(0, 4);
  if (!signature.equals(PACK_SIGNATURE)) {
    throw new InvalidPackError(`Invalid signature: ${signature.toString("hex")}`);
  }

  const version = data.readUInt32BE(4);
  if (version !== PACK_VERSION) {
    throw new InvalidPackError(`Unsupported version: ${version}`);
  }

  const objectCount = data.readUInt32BE(8);
  const expectedChecksum = data.subarray(data.length - PACK_CHECKSUM_SIZE);
  const actualChecksum = createHash("sha1")
    .update(data.subarray(0, data.length - PACK_CHECKSUM_SIZE))
    .digest();

  if (!expectedChecksum.equals(actualChecksum)) {
    throw new InvalidPackError("Checksum mismatch");
  }

  return objectCount;
}

/**
 * 读取 zlib 压缩的数据
 *
 * 使用 zlib 的 `info` 选项获取实际消耗的输入字节数，
 * 从而精确定位下一个对象的起始偏移量。
 *
 * @param data - 完整的 packfile 数据
 * @param offset - 压缩数据的起始偏移量
 * @returns 解压结果和消耗的字节数
 *
 * @example
 * ```ts
 * const [buffer, bytesRead] = readCompressedData(packData, 12);
 * ```
 */
export function readCompressedData(
  data: Buffer,
  offset: number,
): [buffer: Buffer, bytesRead: number] {
  const remaining = data.subarray(offset);

  try {
    const inflated = inflateSync(remaining, {
      info: true,
    }) as unknown;

    if (
      !inflated ||
      typeof inflated !== "object" ||
      !("buffer" in inflated) ||
      !("engine" in inflated)
    ) {
      throw new InvalidPackError("Unexpected inflate result shape");
    }

    const result = inflated as {
      buffer: Uint8Array;
      engine?: { bytesWritten?: number };
    };
    const consumed = result.engine?.bytesWritten;
    if (typeof consumed !== "number" || consumed <= 0) {
      throw new InvalidPackError("Failed to determine compressed stream length");
    }

    return [Buffer.from(result.buffer), consumed];
  } catch (err) {
    throw new InvalidPackError(`Failed to decompress data at offset ${offset}: ${err}`);
  }
}
