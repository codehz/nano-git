/**
 * 基于内存的对象数据库（raw-first）
 *
 * 所有对象以 RawGitObject 形式存储在内存 Map 中，程序退出后丢失。
 * 适用于单元测试和临时操作场景。
 *
 * ODB 的真实边界是 RawGitObject，不是 GitObject。
 */

import { hashObject } from "../hash/index.ts";

import type { RawGitObject, SHA1 } from "../types/index.ts";
import type { ObjectDatabase } from "./types.ts";

export type { ObjectDatabase } from "./types.ts";

/**
 * 内存对象数据库接口
 */
export type MemoryObjectDatabase = ObjectDatabase;

/**
 * 创建基于内存的对象数据库
 *
 * 所有对象存储在内存中，程序退出后丢失。
 *
 * @example
 * ```ts
 * const db = createMemoryObjectStore();
 * db.ingest(raw);
 * const obj = db.read(hash);
 * ```
 */
export function createMemoryObjectStore(): MemoryObjectDatabase {
  const store = new Map<SHA1, RawGitObject>();

  return {
    ingest(raw: RawGitObject): void {
      const expectedHash = hashObject(raw.type, raw.content);
      if (expectedHash !== raw.hash) {
        throw new Error(`RawGitObject hash mismatch: expected ${expectedHash}, got ${raw.hash}`);
      }
      if (!store.has(raw.hash)) {
        store.set(raw.hash, raw);
      }
    },

    ingestMany(objects: Iterable<RawGitObject>): void {
      for (const raw of objects) {
        this.ingest(raw);
      }
    },

    read(hash: SHA1): RawGitObject {
      const obj = store.get(hash);
      if (!obj) {
        throw new Error(`Object not found: ${hash}`);
      }
      return obj;
    },

    tryRead(hash: SHA1): RawGitObject | undefined {
      return store.get(hash);
    },

    exists(hash: SHA1): boolean {
      return store.has(hash);
    },

    list(): SHA1[] {
      return Array.from(store.keys());
    },

    delete(hash: SHA1): void {
      store.delete(hash);
    },
  };
}
