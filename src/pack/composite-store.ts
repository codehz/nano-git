/**
 * 组合对象存储
 *
 * 将多个对象存储后端组合在一起，按优先级顺序查找对象。
 * 典型用法：loose objects（文件系统）+ packfile 存储。
 *
 * 查找顺序：
 * 1. 先在 loose objects 中查找（最新写入的对象）
 * 2. 再在 packfile 中查找（已打包的对象）
 *
 * 写入操作始终写入到主存储（通常是 loose objects）。
 *
 * @example
 * ```ts
 * const store = createCompositeObjectStore(fileStore, packStore);
 * const obj = store.read(hash); // 自动在所有存储中查找
 * ```
 */

import type { GitObject, SHA1 } from "../core/types.ts";
import { ObjectNotFoundError } from "../core/errors.ts";
import type { ObjectSource, ObjectStore } from "../store/types.ts";

// ============================================================================
// 组合对象存储
// ============================================================================

/**
 * 创建组合对象存储
 *
 * @param primary - 主存储（用于写入）
 * @param secondary - 辅助存储列表（只读，按顺序查找）
 * @returns 组合对象存储
 *
 * @example
 * ```ts
 * const fileStore = createFileObjectStore(gitDir);
 * const packStore = createPackObjectStore(gitDir);
 * const store = createCompositeObjectStore(fileStore, packStore);
 *
 * // 读取时自动在所有存储中查找
 * const obj = store.read(hash);
 *
 * // 写入时只写入主存储
 * store.write(blob);
 * ```
 */
export function createCompositeObjectStore(
  primary: ObjectStore,
  ...secondary: ObjectSource[]
): CompositeObjectStore {
  return new CompositeObjectStore(primary, secondary);
}

/**
 * 组合对象存储类
 */
export class CompositeObjectStore implements ObjectStore {
  private readonly primary: ObjectStore;
  private readonly secondary: ObjectSource[];

  constructor(primary: ObjectStore, secondary: ObjectSource[]) {
    this.primary = primary;
    this.secondary = secondary;
  }

  /**
   * 写入对象到主存储
   *
   * @param obj - Git 对象
   * @returns 对象的 SHA-1 哈希
   */
  write(obj: GitObject): SHA1 {
    return this.primary.write(obj);
  }

  /**
   * 读取对象
   *
   * 按顺序在所有存储中查找，返回第一个找到的对象。
   *
   * @throws ObjectNotFoundError 如果对象在所有存储中都不存在
   */
  read(hash: SHA1): GitObject {
    // 先在主存储中查找
    if (this.primary.exists(hash)) {
      return this.primary.read(hash);
    }

    // 再在辅助存储中查找
    for (const store of this.secondary) {
      if (store.exists(hash)) {
        return store.read(hash);
      }
    }

    throw new ObjectNotFoundError(hash);
  }

  /**
   * 检查对象是否存在
   */
  exists(hash: SHA1): boolean {
    if (this.primary.exists(hash)) return true;

    for (const store of this.secondary) {
      if (store.exists(hash)) return true;
    }

    return false;
  }

  /**
   * 列出所有对象哈希
   *
   * 主存储排在前面，重复哈希自动去重。
   */
  list(): SHA1[] {
    const hashes = new Set<SHA1>();

    for (const hash of this.primary.list()) {
      hashes.add(hash);
    }

    for (const store of this.secondary) {
      for (const hash of store.list()) {
        hashes.add(hash);
      }
    }

    return Array.from(hashes).sort();
  }

  /**
   * 获取主存储
   */
  getPrimary(): ObjectStore {
    return this.primary;
  }

  /**
   * 获取所有辅助存储
   */
  getSecondary(): ObjectSource[] {
    return [...this.secondary];
  }
}
