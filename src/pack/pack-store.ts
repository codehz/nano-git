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
   * 保留此方法作为更明确的命名别名。
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
  let loaded = false;

  /**
   * 扫描 pack 目录并加载索引
   */
  function ensureLoaded(): void {
    if (loaded) return;
    loaded = true;
    pairs.push(...loadPackPairs(packDir));
  }

  function read(hash: SHA1): RawGitObject {
    ensureLoaded();

    for (const pair of pairs) {
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

    for (const pair of pairs) {
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

    for (const pair of pairs) {
      if (pair.index.has(hash)) return true;
    }

    return false;
  }

  function list(): SHA1[] {
    ensureLoaded();

    const hashes: SHA1[] = [];
    for (const pair of pairs) {
      hashes.push(...pair.index.listHashes());
    }
    return hashes;
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
      let count = 0;
      for (const pair of pairs) {
        count += pair.index.objectCount;
      }
      return count;
    },
  };
}
