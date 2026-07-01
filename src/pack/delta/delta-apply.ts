/**
 * Delta 应用（解码）
 */

import { DeltaError } from "../../errors.ts";
import { decodeVarint } from "../utils/utils.ts";

/**
 * 将 delta 数据应用到 base object，生成目标对象
 *
 * @param base - base object 的原始数据
 * @param delta - delta 数据
 * @returns 目标对象的原始数据
 *
 * @example
 * ```ts
 * const base = Buffer.from("hello world");
 * const delta = createDelta(base, Buffer.from("hello git"));
 * const result = applyDelta(base, delta);
 * ```
 */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;

  const [_srcSize, srcBytes] = decodeVarint(delta, offset);
  offset += srcBytes;

  const [destSize, destBytes] = decodeVarint(delta, offset);
  offset += destBytes;

  const result = Buffer.alloc(destSize);
  let destOffset = 0;

  while (offset < delta.length) {
    const cmd = delta[offset]!;
    offset++;

    if (cmd & 0x80) {
      const copy = decodeCopyInstruction(delta, offset, cmd);
      offset += copy.bytesRead;

      if (copy.offset + copy.size > base.length) {
        throw new DeltaError(
          `Copy out of bounds: offset=${copy.offset}, size=${copy.size}, base.length=${base.length}`,
        );
      }

      base.copy(result, destOffset, copy.offset, copy.offset + copy.size);
      destOffset += copy.size;
      continue;
    }

    if (cmd > 0) {
      if (offset + cmd > delta.length) {
        throw new DeltaError("Insert out of bounds");
      }

      delta.copy(result, destOffset, offset, offset + cmd);
      destOffset += cmd;
      offset += cmd;
      continue;
    }

    throw new DeltaError("Unexpected delta command: 0");
  }

  if (destOffset !== destSize) {
    throw new DeltaError(`Delta size mismatch: expected ${destSize}, got ${destOffset}`);
  }

  return result;
}

function decodeCopyInstruction(
  delta: Buffer,
  offset: number,
  cmd: number,
): { offset: number; size: number; bytesRead: number } {
  const start = offset;
  let copyOffset = 0;
  let copySize = 0;

  if (cmd & 0x01) copyOffset = delta[offset++]!;
  if (cmd & 0x02) copyOffset |= delta[offset++]! << 8;
  if (cmd & 0x04) copyOffset |= delta[offset++]! << 16;
  if (cmd & 0x08) copyOffset |= delta[offset++]! << 24;

  if (cmd & 0x10) copySize = delta[offset++]!;
  if (cmd & 0x20) copySize |= delta[offset++]! << 8;
  if (cmd & 0x40) copySize |= delta[offset++]! << 16;

  if (copySize === 0) {
    copySize = 0x10000;
  }

  return {
    offset: copyOffset,
    size: copySize,
    bytesRead: offset - start,
  };
}
