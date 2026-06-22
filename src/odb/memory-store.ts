/**
 * 基于内存的对象存储（用于测试）
 *
 * 所有对象存储在内存 Map 中，程序退出后丢失。
 * 适用于单元测试和临时操作场景。
 */

import { hashObject } from "../core/hash.ts";
import { serialize, deserialize, serializeContent } from "../objects/index.ts";

import type { GitObject, SHA1 } from "../core/types.ts";
import type { ObjectStore } from "./types.ts";

/**
 * 内存对象存储接口（扩展了 list 方法）
 */
export interface MemoryObjectStore extends ObjectStore {}

/**
 * 创建内存对象存储（用于测试）
 *
 * 所有对象存储在内存中，程序退出后丢失。
 */
export function createMemoryObjectStore(): MemoryObjectStore {
  const store = new Map<SHA1, Buffer>();

  return {
    write(obj: GitObject): SHA1 {
      const hash = hashObject(obj.type, serializeContent(obj));
      const serialized = serialize(obj);
      store.set(hash, serialized);
      return hash;
    },

    read(hash: SHA1): GitObject {
      const data = store.get(hash);
      if (!data) {
        throw new Error(`Object not found: ${hash}`);
      }
      return deserialize(data);
    },

    exists(hash: SHA1): boolean {
      return store.has(hash);
    },

    list(): SHA1[] {
      return Array.from(store.keys());
    },
  };
}
