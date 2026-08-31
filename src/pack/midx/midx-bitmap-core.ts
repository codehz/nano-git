/**
 * MIDX bitmap 纯算法
 *
 * 只处理已加载的 MIDX 与 bitmap，不读取文件系统。
 */

import type { SHA1 } from "../../types/index.ts";
import type { ReachabilityAccelerator } from "../../types/reachability.ts";
import type { PackBitmapReader } from "../bitmap/pack-bitmap-reader.ts";
import type { MidxReader } from "./midx-types.ts";

/** 在 MIDX 全局 OID 序中查找对象位置 */
export function findMidxObjectPosition(midx: MidxReader, hash: SHA1): number | undefined {
  const index = midx.listHashes().indexOf(hash);
  return index >= 0 ? index : undefined;
}

/**
 * 将某 commit 的 reachability bitmap 中置位的对象加入集合
 *
 * @returns 是否成功使用了 bitmap
 */
export function addReachableFromCommitBitmap(
  midx: MidxReader,
  bitmap: PackBitmapReader,
  commitHash: SHA1,
  reachable: Set<SHA1>,
): boolean {
  const pos = findMidxObjectPosition(midx, commitHash);
  if (pos === undefined) {
    return false;
  }

  const bits = bitmap.getReachabilityBitmap(pos);
  if (!bits) {
    return false;
  }

  const hashes = midx.listHashes();
  const revindex = midx.getRevindexPseudoPackOrder?.();

  if (revindex && revindex.length > 0) {
    for (let pseudo = 0; pseudo < bits.bitCount; pseudo++) {
      if (!bits.get(pseudo) || pseudo >= revindex.length) {
        continue;
      }
      const globalPos = revindex[pseudo]!;
      if (globalPos < hashes.length) {
        reachable.add(hashes[globalPos]!);
      }
    }
    return true;
  }

  const limit = Math.min(bits.bitCount, hashes.length);
  for (let index = 0; index < limit; index++) {
    if (bits.get(index)) {
      reachable.add(hashes[index]!);
    }
  }
  return true;
}

/**
 * 创建基于 MIDX bitmap 的通用可达性加速器
 *
 * @param midx - 已加载的 MIDX 读取器
 * @param bitmap - 已加载的 bitmap 读取器
 * @returns 可注入核心图算法的加速器
 *
 * @example
 * ```ts
 * const accelerator = createMidxReachabilityAccelerator(midx, bitmap);
 * const reachable = collectReachable(source, roots, "skip", undefined, accelerator);
 * ```
 */
export function createMidxReachabilityAccelerator(
  midx: MidxReader,
  bitmap: PackBitmapReader,
): ReachabilityAccelerator {
  return {
    addReachableFromCommit(commitHash, reachable) {
      return addReachableFromCommitBitmap(midx, bitmap, commitHash, reachable);
    },
  };
}

/** MIDX bitmap 加速器使用的已加载数据 */
export interface MidxBitmapAssist {
  readonly midx: MidxReader;
  readonly bitmap: PackBitmapReader;
}
