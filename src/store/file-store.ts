/**
 * 基于文件系统的对象存储
 *
 * Git 将对象存储在 .git/objects/ 目录下：
 * - 每个对象以 zlib 压缩格式存储
 * - 路径格式: .git/objects/<前2字符>/<剩余38字符>
 * - 例如: .git/objects/95/d09f2b10159347eece71399a7e2e907ea3df4f
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import type { GitObject, SHA1 } from "../core/types.ts";
import { sha1 } from "../core/types.ts";
import { hashObject, hashToPath } from "../core/hash.ts";
import { serialize, deserialize, serializeContent } from "../objects/index.ts";
import type { ObjectStore } from "./types.ts";

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
      const hash = hashObject(obj.type, serializeContent(obj));

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

    list(): SHA1[] {
      if (!existsSync(objectsDir)) {
        return [];
      }

      const hashes: SHA1[] = [];
      const dirs = readdirSync(objectsDir).sort();

      for (const dirName of dirs) {
        if (dirName === "info" || dirName === "pack" || dirName.length !== 2) {
          continue;
        }

        const dirPath = join(objectsDir, dirName);
        if (!statSync(dirPath).isDirectory()) {
          continue;
        }

        const files = readdirSync(dirPath).sort();
        for (const fileName of files) {
          if (fileName.length !== 38) {
            continue;
          }
          hashes.push(sha1(`${dirName}${fileName}`));
        }
      }

      return hashes;
    },
  };
}
