/**
 * Git 对象存储
 *
 * Git 将对象存储在 .git/objects/ 目录下：
 * - 每个对象以 zlib 压缩格式存储
 * - 路径格式: .git/objects/<前2字符>/<剩余38字符>
 * - 例如: .git/objects/95/d09f2b10159347eece71399a7e2e907ea3df4f
 *
 * 本模块提供对象的读写操作（同步版本）。
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import type { GitObject, SHA1 } from "./types.ts";
import { hashObject, hashToPath } from "./hash.ts";
import { serialize, deserialize, serializeContent } from "./objects.ts";

/**
 * 对象存储接口
 *
 * 提供 Git 对象的持久化存储能力。
 * 默认实现基于文件系统（.git/objects/）。
 */
export interface ObjectStore {
  /**
   * 写入对象并返回其 SHA-1 哈希
   *
   * 如果对象已存在，则跳过写入（Git 的内容寻址特性）。
   */
  write(obj: GitObject): SHA1;

  /**
   * 读取对象
   *
   * @throws 如果对象不存在
   */
  read(hash: SHA1): GitObject;

  /**
   * 检查对象是否存在
   */
  exists(hash: SHA1): boolean;
}

/**
 * 创建基于文件系统的对象存储
 *
 * @param gitDir - .git 目录的路径
 *
 * @example
 * ```ts
 * const store = createFileObjectStore("/path/to/repo/.git");
 *
 * // 写入一个 blob
 * const blob: GitBlob = { type: "blob", content: Buffer.from("hello") };
 * const hash = store.write(blob);
 *
 * // 读取回来
 * const obj = store.read(hash);
 * ```
 */
export function createFileObjectStore(gitDir: string): ObjectStore {
  const objectsDir = join(gitDir, "objects");

  return {
    write(obj: GitObject): SHA1 {
      // 计算哈希
      const content = serialize(obj).subarray(
        // 跳过 header，只取 content 部分用于哈希计算
        // 但 hashObject 需要原始 content，所以重新计算
        0
      );
      const hash = hashObject(obj.type, getContentBuffer(obj));

      // 检查是否已存在
      const objectPath = join(objectsDir, hashToPath(hash));
      if (existsSync(objectPath)) {
        return hash;
      }

      // 序列化完整对象（含 header）
      const serialized = serialize(obj);

      // zlib 压缩
      const compressed = deflateSync(serialized);

      // 创建目录并写入
      const dir = join(objectsDir, hash.slice(0, 2));
      mkdirSync(dir, { recursive: true });
      writeFileSync(objectPath, compressed);

      return hash;
    },

    read(hash: SHA1): GitObject {
      const objectPath = join(objectsDir, hashToPath(hash));

      if (!existsSync(objectPath)) {
        throw new Error(`Object not found: ${hash}`);
      }

      // 读取并解压
      const compressed = readFileSync(objectPath);
      const decompressed = inflateSync(compressed);

      // 反序列化
      return deserialize(decompressed);
    },

    exists(hash: SHA1): boolean {
      const objectPath = join(objectsDir, hashToPath(hash));
      return existsSync(objectPath);
    },
  };
}

/**
 * 创建内存对象存储（用于测试）
 *
 * 所有对象存储在内存中，程序退出后丢失。
 */
export function createMemoryObjectStore(): ObjectStore & {
  /** 获取所有存储的对象哈希 */
  list(): SHA1[];
} {
  const store = new Map<string, Buffer>();

  return {
    write(obj: GitObject): SHA1 {
      const hash = hashObject(obj.type, getContentBuffer(obj));
      const serialized = serialize(obj);
      store.set(hash, serialized);
      return hash as SHA1;
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
      return Array.from(store.keys()) as SHA1[];
    },
  };
}

/**
 * 从 GitObject 中提取原始内容缓冲区（用于哈希计算）
 */
function getContentBuffer(obj: GitObject): Buffer {
  return serializeContent(obj);
}
