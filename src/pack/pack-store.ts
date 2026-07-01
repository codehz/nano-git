/**
 * 基于 Packfile 的对象源（raw-first）
 *
 * 从 .git/objects/pack/ 目录中读取 packfile 和索引文件，
 * 提供只读的原始对象读取接口。
 *
 * Git 的 pack 目录结构：
 * - pack-<checksum>.pack  — 打包的对象数据
 * - pack-<checksum>.idx   — 对应的索引文件
 *
 * @example
 * ```ts
 * const store = createPackObjectStore("/path/to/.git");
 * const raw = store.read(hash);
 * ```
 */

import { join } from "node:path";

import { ObjectNotFoundError } from "../core/errors.ts";
import { packObjectToRaw } from "./pack-reader-types.ts";
import { getPackReader, loadPackPairs, toPackFileInfo } from "./pack-store-loader.ts";

import type { RawGitObject, SHA1 } from "../core/types.ts";
import type { ObjectSource } from "../odb/types.ts";
import type { MidxReader } from "./midx-types.ts";
import type { PackFileInfo, PackPair } from "./pack-store-types.ts";

export type { PackFileInfo } from "./pack-store-types.ts";

// ============================================================================
// 接口
// ============================================================================

/**
 * 基于 Packfile 的对象源接口
 */
export interface PackObjectStore extends ObjectSource {
  /**
   * 刷新 pack 目录缓存
   *
   * 当外部新增或删除 packfile 后，需要调用此方法重新扫描。
   */
  refresh(): void;

  /**
   * 列出当前可见的 pack 文件对
   */
  listPacks(): PackFileInfo[];

  /**
   * 获取所有 packfile 中的对象哈希列表
   *
   * 有 MIDX 时返回去重后的全局 OID 列表；
   * 无 MIDX 时返回各 pack idx 的 OID 并集（可能重复）。
   */
  listHashes(): SHA1[];

  /** 获取 packfile 数量 */
  readonly packCount: number;

  /** 获取所有对象数量 */
  readonly objectCount: number;
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建基于 Packfile 的对象源
 *
 * 扫描 .git/objects/pack/ 目录，加载所有 .idx 文件。
 * 若存在 `multi-pack-index`，会优先使用 MIDX 进行全局 OID 查找。
 * packfile 数据按需加载（首次读取时才加载）。
 *
 * @param gitDir - .git 目录的路径
 * @returns 基于 Packfile 的对象源
 *
 * @example
 * ```ts
 * const store = createPackObjectStore("/path/to/.git");
 *
 * // 读取原始对象
 * const raw = store.read(hash);
 *
 * // 检查对象是否存在
 * if (store.exists(hash)) {
 *   console.log("对象在 packfile 中");
 * }
 * ```
 */
export function createPackObjectStore(gitDir: string): PackObjectStore {
  const packDir = join(gitDir, "objects", "pack");
  const pairs: PackPair[] = [];
  let midx: MidxReader | null = null;
  let loaded = false;

  /**
   * 扫描 pack 目录并加载索引
   */
  function ensureLoaded(): void {
    if (loaded) return;
    loaded = true;
    const result = loadPackPairs(packDir);
    pairs.push(...result.pairs);
    midx = result.midx;
  }

  /**
   * 根据 MIDX 条目读取对象
   */
  function readFromMidx(entry: import("./midx-types.ts").MidxEntry): RawGitObject | undefined {
    const packName = midx!.getPackName(entry.packId);
    const checksumMatch = packName.match(/^pack-([0-9a-f]{40})\.(?:pack|idx)$/);
    if (!checksumMatch) {
      return undefined;
    }

    const checksum = checksumMatch[1]!;
    const pair = pairs.find((p) => p.checksum === checksum);
    if (!pair) {
      return undefined;
    }

    const reader = getPackReader(packDir, pair);
    const obj = reader.getByOffset(entry.offset);
    if (obj) {
      return packObjectToRaw(obj);
    }

    return undefined;
  }

  /**
   * 获取 MIDX 已覆盖的 pack 文件名集合
   */
  function getMidxCoveredPackNames(): Set<string> {
    if (!midx) return new Set();

    const covered = new Set<string>();
    for (let i = 0; i < midx.header.packCount; i++) {
      covered.add(midx.getPackName(i));
    }
    return covered;
  }

  /**
   * 获取未纳入 MIDX 的 pack 对（回退用）
   */
  function getFallbackPairs(): PackPair[] {
    if (!midx) return pairs;

    const covered = getMidxCoveredPackNames();
    return pairs.filter(
      (p) => !covered.has(`pack-${p.checksum}.pack`) && !covered.has(`pack-${p.checksum}.idx`),
    );
  }

  function read(hash: SHA1): RawGitObject {
    ensureLoaded();

    if (midx) {
      const entry = midx.lookup(hash);
      if (entry) {
        const obj = readFromMidx(entry);
        if (obj) return obj;
      }
    }

    for (const pair of getFallbackPairs()) {
      const entry = pair.index.lookup(hash);
      if (entry) {
        const reader = getPackReader(packDir, pair);
        const obj = reader.getByHash(hash);
        if (obj) return packObjectToRaw(obj);
      }
    }

    throw new ObjectNotFoundError(hash);
  }

  function tryRead(hash: SHA1): RawGitObject | undefined {
    ensureLoaded();

    if (midx) {
      const entry = midx.lookup(hash);
      if (entry) {
        const obj = readFromMidx(entry);
        if (obj) return obj;
      }
    }

    for (const pair of getFallbackPairs()) {
      const entry = pair.index.lookup(hash);
      if (entry) {
        const reader = getPackReader(packDir, pair);
        const obj = reader.getByHash(hash);
        if (obj) return packObjectToRaw(obj);
      }
    }

    return undefined;
  }

  function exists(hash: SHA1): boolean {
    ensureLoaded();

    if (midx) {
      if (midx.has(hash)) return true;
    }

    for (const pair of getFallbackPairs()) {
      if (pair.index.has(hash)) return true;
    }

    return false;
  }

  function list(): SHA1[] {
    ensureLoaded();

    const hashes = new Set<SHA1>();
    if (midx) {
      for (const hash of midx.listHashes()) {
        hashes.add(hash);
      }
    }
    for (const pair of getFallbackPairs()) {
      for (const hash of pair.index.listHashes()) {
        hashes.add(hash);
      }
    }
    return Array.from(hashes);
  }

  function listHashes(): SHA1[] {
    return list();
  }

  function listPacks(): PackFileInfo[] {
    ensureLoaded();
    return pairs.map((pair) => toPackFileInfo(packDir, pair));
  }

  function refresh(): void {
    loaded = false;
    pairs.length = 0;
    midx = null;
  }

  return {
    refresh,
    read,
    tryRead,
    exists,
    list,
    listHashes,
    listPacks,
    get packCount(): number {
      ensureLoaded();
      return pairs.length;
    },
    get objectCount(): number {
      ensureLoaded();
      return list().length;
    },
  };
}
