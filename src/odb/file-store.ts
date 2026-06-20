/**
 * 基于文件系统的对象存储
 *
 * Git 将对象存储在 .git/objects/ 目录下：
 * - 每个对象以 zlib 压缩格式存储
 * - 路径格式: .git/objects/<前2字符>/<剩余38字符>
 * - 例如: .git/objects/95/d09f2b10159347eece71399a7e2e907ea3df4f
 */

import { join } from "node:path";
import type { GitObject, SHA1 } from "../core/types.ts";
import { hashObject } from "../core/hash.ts";
import { serializeContent } from "../objects/index.ts";
import type { ObjectStore } from "./types.ts";
import {
  hasLooseObject,
  listLooseObjects,
  readLooseObject,
  writeLooseObject,
} from "./file-store-utils.ts";

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
      const hash = hashObject(obj.type, serializeContent(obj));
      if (hasLooseObject(objectsDir, hash)) {
        return hash;
      }

      writeLooseObject(objectsDir, hash, obj);
      return hash;
    },

    read(hash: SHA1): GitObject {
      return readLooseObject(objectsDir, hash);
    },

    exists(hash: SHA1): boolean {
      return hasLooseObject(objectsDir, hash);
    },

    list(): SHA1[] {
      return listLooseObjects(objectsDir);
    },
  };
}
