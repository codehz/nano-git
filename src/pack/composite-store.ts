/**
 * 组合对象源/数据库
 *
 * 将多个对象源/数据库组合在一起，按优先级顺序查找对象。
 * 典型用法：loose objects（文件系统）+ packfile 存储。
 *
 * 查找顺序：
 * 1. 先在主数据库中查找（最新写入/摄入的对象）
 * 2. 再在辅助源中查找（已打包的对象）
 *
 * 摄入操作始终写入到主数据库。
 *
 * @example
 * ```ts
 * const db = createCompositeObjectDatabase(fileDb, packSource);
 * const raw = db.read(hash); // 自动在所有存储中查找
 * ```
 */

import { ObjectNotFoundError } from "../errors.ts";

import type { ObjectSource, ObjectDatabase } from "../odb/types.ts";
import type { RawGitObject, SHA1 } from "../types/index.ts";

// ============================================================================
// 组合对象数据库
// ============================================================================

/**
 * 创建组合对象数据库
 *
 * @param primary - 主数据库（用于摄入）
 * @param secondary - 辅助源列表（只读，按顺序查找）
 * @returns 组合对象数据库
 *
 * @example
 * ```ts
 * const looseDb = createFileObjectStore(gitDir);
 * const packSource = createPackObjectStore(gitDir);
 * const db = createCompositeObjectDatabase(looseDb, packSource);
 *
 * // 读取时自动在所有存储中查找
 * const raw = db.read(hash);
 *
 * // 摄入时只写入主数据库
 * db.ingest(raw);
 * ```
 */
export function createCompositeObjectDatabase(
  primary: ObjectDatabase,
  ...secondary: ObjectSource[]
): CompositeObjectDatabase {
  return new CompositeObjectDatabase(primary, secondary);
}

/**
 * 组合对象数据库类
 */
export class CompositeObjectDatabase implements ObjectDatabase {
  private readonly primary: ObjectDatabase;
  private readonly secondary: ObjectSource[];

  constructor(primary: ObjectDatabase, secondary: ObjectSource[]) {
    this.primary = primary;
    this.secondary = secondary;
  }

  /**
   * 摄入原始对象到主数据库
   */
  ingest(raw: RawGitObject): void {
    return this.primary.ingest(raw);
  }

  /**
   * 批量摄入原始对象到主数据库
   */
  ingestMany(objects: Iterable<RawGitObject>): void {
    for (const raw of objects) {
      this.ingest(raw);
    }
  }

  /**
   * 删除对象
   *
   * 委托给主数据库的 delete。
   */
  delete(hash: SHA1): void {
    this.primary.delete(hash);
  }

  /**
   * 尝试读取原始对象，不存在时返回 undefined
   */
  tryRead(hash: SHA1): RawGitObject | undefined {
    const primaryResult = this.tryReadSource(this.primary, hash);
    if (primaryResult !== undefined) {
      return primaryResult;
    }

    for (const source of this.secondary) {
      const result = this.tryReadSource(source, hash);
      if (result !== undefined) {
        return result;
      }
    }

    return undefined;
  }

  /**
   * 尝试从指定源中读取对象，不存在时返回 undefined
   */
  private tryReadSource(source: ObjectSource, hash: SHA1): RawGitObject | undefined {
    try {
      return source.read(hash);
    } catch {
      return undefined;
    }
  }

  /**
   * 读取原始对象
   *
   * 按顺序在所有存储中查找，返回第一个找到的对象。
   * （跳过 exists() 前置检查，直接尝试 read() 以消除 N+1 双重调用）
   *
   * @throws ObjectNotFoundError 如果对象在所有存储中都不存在
   */
  read(hash: SHA1): RawGitObject {
    // 先尝试主数据库
    const primaryResult = this.tryReadSource(this.primary, hash);
    if (primaryResult !== undefined) {
      return primaryResult;
    }

    // 再在辅助源中查找
    for (const source of this.secondary) {
      const result = this.tryReadSource(source, hash);
      if (result !== undefined) {
        return result;
      }
    }

    throw new ObjectNotFoundError(hash);
  }

  /**
   * 检查对象是否存在
   */
  exists(hash: SHA1): boolean {
    if (this.primary.exists(hash)) return true;

    for (const source of this.secondary) {
      if (source.exists(hash)) return true;
    }

    return false;
  }

  /**
   * 列出所有对象哈希
   *
   * 主数据库排在前面，重复哈希自动去重。
   */
  list(): SHA1[] {
    const hashes = new Set<SHA1>();

    for (const hash of this.primary.list()) {
      hashes.add(hash);
    }

    for (const source of this.secondary) {
      for (const hash of source.list()) {
        hashes.add(hash);
      }
    }

    return Array.from(hashes).sort();
  }
}
