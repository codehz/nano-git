/**
 * 基于 Packfile 的对象存储
 *
 * 从 .git/objects/pack/ 目录中读取 packfile 和索引文件，
 * 提供只读的对象读取接口。
 *
 * Git 的 pack 目录结构：
 * - pack-<checksum>.pack  — 打包的对象数据
 * - pack-<checksum>.idx   — 对应的索引文件
 *
 * 写入操作不支持（packfile 是只读的），
 * 新对象应写入 loose objects 或创建新的 packfile。
 *
 * @example
 * ```ts
 * const store = createPackObjectStore("/path/to/.git");
 * const obj = store.read(hash);
 * ```
 */

import { join } from "node:path";

import { ObjectNotFoundError } from "../../core/errors.ts";
import { getPackReader, loadPackPairs, toPackFileInfo } from "./pack-store-loader.ts";

import type { GitObject, SHA1 } from "../../core/types.ts";
import type { ObjectSource } from "../types.ts";
import type { PackFileInfo, PackPair } from "./pack-store-types.ts";

export type { PackFileInfo } from "./pack-store-types.ts";

// ============================================================================
// Pack 对象存储
// ============================================================================

/**
 * 创建基于 Packfile 的对象存储
 *
 * 扫描 .git/objects/pack/ 目录，加载所有 .idx 文件。
 * packfile 数据按需加载（首次读取时才加载）。
 *
 * @param gitDir - .git 目录的路径
 * @returns 基于 Packfile 的对象存储
 *
 * @example
 * ```ts
 * const store = createPackObjectStore("/path/to/.git");
 *
 * // 读取对象
 * const obj = store.read(hash);
 *
 * // 检查对象是否存在
 * if (store.exists(hash)) {
 *   console.log("对象在 packfile 中");
 * }
 * ```
 */
export function createPackObjectStore(gitDir: string): PackObjectStore {
  return new PackObjectStore(gitDir);
}

/**
 * 基于 Packfile 的对象存储类
 */
export class PackObjectStore implements ObjectSource {
  private readonly packDir: string;
  private readonly pairs: PackPair[] = [];
  private loaded = false;

  constructor(gitDir: string) {
    this.packDir = join(gitDir, "objects", "pack");
  }

  /**
   * 刷新 pack 目录缓存
   *
   * 当外部新增或删除 packfile 后，需要调用此方法重新扫描。
   */
  refresh(): void {
    this.loaded = false;
    this.pairs.length = 0;
  }

  /**
   * 扫描 pack 目录并加载索引
   */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.pairs.push(...loadPackPairs(this.packDir));
  }

  /**
   * 读取对象
   *
   * @throws ObjectNotFoundError 如果对象不存在
   */
  read(hash: SHA1): GitObject {
    this.ensureLoaded();

    for (const pair of this.pairs) {
      const entry = pair.index.lookup(hash);
      if (entry) {
        const reader = getPackReader(this.packDir, pair);
        const obj = reader.readObject(hash);
        if (obj) return obj;
      }
    }

    throw new ObjectNotFoundError(hash);
  }

  /**
   * 检查对象是否存在
   */
  exists(hash: SHA1): boolean {
    this.ensureLoaded();

    for (const pair of this.pairs) {
      if (pair.index.has(hash)) return true;
    }

    return false;
  }

  /**
   * 获取所有 packfile 中的对象哈希列表
   */
  list(): SHA1[] {
    this.ensureLoaded();

    const hashes: SHA1[] = [];
    for (const pair of this.pairs) {
      hashes.push(...pair.index.listHashes());
    }
    return hashes;
  }

  /**
   * 获取所有 packfile 中的对象哈希列表
   *
   * 保留此方法作为更明确的命名别名。
   */
  listHashes(): SHA1[] {
    return this.list();
  }

  /**
   * 列出当前可见的 pack 文件对
   */
  listPacks(): PackFileInfo[] {
    this.ensureLoaded();
    return this.pairs.map((pair) => toPackFileInfo(this.packDir, pair));
  }

  /**
   * 获取 packfile 数量
   */
  get packCount(): number {
    this.ensureLoaded();
    return this.pairs.length;
  }

  /**
   * 获取所有对象数量
   */
  get objectCount(): number {
    this.ensureLoaded();
    let count = 0;
    for (const pair of this.pairs) {
      count += pair.index.objectCount;
    }
    return count;
  }
}
