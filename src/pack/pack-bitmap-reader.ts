/**
 * Pack / MIDX reachability bitmap 只读解析（Git bitmap v1）
 */

import { createHash } from "node:crypto";

import { PackIndexError } from "../core/errors.ts";
import { decodeEwahBitmap, xorUnpackedBitmaps } from "./ewah-bitmap.ts";

import type { UnpackedBitmap } from "./ewah-bitmap.ts";

const BITMAP_SIGNATURE = Buffer.from("BITM");
const BITMAP_HEADER_SIZE = 32;
const SHA1_OID_LEN = 20;

const BITMAP_OPT_FULL_DAG = 0x0001;
const BITMAP_OPT_HASH_CACHE = 0x0004;
const BITMAP_OPT_LOOKUP_TABLE = 0x0010;

/**
 * 类型位图索引（与 Git 序列化顺序一致）
 */
export type BitmapObjectTypeIndex = 0 | 1 | 2 | 3;

/** 0=commit, 1=tree, 2=blob, 3=tag */
export const BITMAP_TYPE_COMMIT: BitmapObjectTypeIndex = 0;
export const BITMAP_TYPE_TREE: BitmapObjectTypeIndex = 1;
export const BITMAP_TYPE_BLOB: BitmapObjectTypeIndex = 2;
export const BITMAP_TYPE_TAG: BitmapObjectTypeIndex = 3;

interface BitmapCommitEntry {
  commitPosition: number;
  xorOffset: number;
  reuseHint: boolean;
  ewahOffset: number;
  ewahLength: number;
}

/**
 * 已解析的 reachability bitmap 文件
 */
export interface PackBitmapReader {
  /** 关联的 pack/MIDX 校验和（40 hex） */
  readonly checksumHex: string;
  /** 位图条目数（含 commit 位图数） */
  readonly entryCount: number;
  /** pseudo-pack / MIDX 位宽 */
  readonly bitCount: number;
  /** 四张类型 EWAH 解压结果 */
  getTypeBitmap(type: BitmapObjectTypeIndex): UnpackedBitmap;
  /**
   * 按 MIDX 对象位置查找该 commit 的可达性位图（已 XOR 展开）
   *
   * @param commitMidxPosition - commit 在 MIDX 序中的位置
   */
  getReachabilityBitmap(commitMidxPosition: number): UnpackedBitmap | undefined;
}

/**
 * 解析 `.bitmap` 文件
 *
 * @param data - 完整文件内容
 */
export function createPackBitmapReader(data: Buffer): PackBitmapReader {
  if (data.length < BITMAP_HEADER_SIZE + SHA1_OID_LEN) {
    throw new PackIndexError("Bitmap file too small");
  }

  const signature = data.subarray(0, 4);
  if (!signature.equals(BITMAP_SIGNATURE)) {
    throw new PackIndexError(`Invalid bitmap signature: ${signature.toString("hex")}`);
  }

  const version = data.readUInt16BE(4);
  if (version !== 1) {
    throw new PackIndexError(`Unsupported bitmap version: ${version}`);
  }

  const flags = data.readUInt16BE(6);
  if ((flags & BITMAP_OPT_FULL_DAG) === 0) {
    throw new PackIndexError("Bitmap missing required BITMAP_OPT_FULL_DAG flag");
  }

  const entryCount = data.readUInt32BE(8);
  const checksumHex = data.subarray(12, 12 + SHA1_OID_LEN).toString("hex");

  let cursor = BITMAP_HEADER_SIZE;

  const typeBitmaps: UnpackedBitmap[] = [];
  for (let t = 0; t < 4; t++) {
    const { bitmap, bytesRead } = decodeEwahBitmap(data, cursor);
    typeBitmaps.push(bitmap);
    cursor += bytesRead;
  }

  const bitCount = typeBitmaps[0]!.bitCount;
  for (const tb of typeBitmaps) {
    if (tb.bitCount !== bitCount) {
      throw new PackIndexError("Bitmap type planes have inconsistent bit counts");
    }
  }

  const entries: BitmapCommitEntry[] = [];
  const ewahPayloads: UnpackedBitmap[] = [];

  for (let i = 0; i < entryCount; i++) {
    if (cursor + 6 > data.length) {
      throw new PackIndexError("Bitmap commit entry truncated");
    }
    const commitPosition = data.readUInt32BE(cursor);
    const xorOffset = data.readUInt8(cursor + 4);
    const entryFlags = data.readUInt8(cursor + 5);
    cursor += 6;

    const ewahStart = cursor;
    const { bitmap, bytesRead } = decodeEwahBitmap(data, cursor);
    cursor += bytesRead;

    entries.push({
      commitPosition,
      xorOffset,
      reuseHint: (entryFlags & 0x1) !== 0,
      ewahOffset: ewahStart,
      ewahLength: bytesRead,
    });
    ewahPayloads.push(bitmap);
  }

  let tail = cursor;
  if ((flags & BITMAP_OPT_LOOKUP_TABLE) !== 0) {
    tail += entryCount * (4 + 8 + 4);
  }
  if ((flags & BITMAP_OPT_HASH_CACHE) !== 0) {
    tail += bitCount * 4;
  }

  const trailerStart = data.length - SHA1_OID_LEN;
  if (tail > trailerStart) {
    throw new PackIndexError("Bitmap optional sections overflow file");
  }
  const body = data.subarray(0, trailerStart);
  const expectedTrailer = createHash("sha1").update(body).digest();
  const actualTrailer = data.subarray(trailerStart);
  if (!actualTrailer.equals(expectedTrailer)) {
    throw new PackIndexError("Bitmap checksum mismatch");
  }

  const entryByCommitPos = new Map<number, number>();
  for (let i = 0; i < entries.length; i++) {
    entryByCommitPos.set(entries[i]!.commitPosition, i);
  }

  const resolvedCache = new Map<number, UnpackedBitmap>();

  function resolveEntryBitmap(entryIndex: number): UnpackedBitmap {
    const cached = resolvedCache.get(entryIndex);
    if (cached) {
      return cached;
    }

    const entry = entries[entryIndex]!;
    let bitmap = ewahPayloads[entryIndex]!;

    if (entry.xorOffset > 0) {
      const parentIndex = entryIndex - entry.xorOffset;
      if (parentIndex < 0) {
        throw new PackIndexError(`Bitmap XOR offset out of range at entry ${entryIndex}`);
      }
      const parent = resolveEntryBitmap(parentIndex);
      bitmap = xorUnpackedBitmaps(parent, bitmap);
    }

    resolvedCache.set(entryIndex, bitmap);
    return bitmap;
  }

  return {
    checksumHex,
    entryCount,
    bitCount,
    getTypeBitmap(type: BitmapObjectTypeIndex): UnpackedBitmap {
      return typeBitmaps[type]!;
    },
    getReachabilityBitmap(commitMidxPosition: number): UnpackedBitmap | undefined {
      const entryIndex = entryByCommitPos.get(commitMidxPosition);
      if (entryIndex === undefined) {
        return undefined;
      }
      return resolveEntryBitmap(entryIndex);
    },
  };
}
