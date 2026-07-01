/**
 * 基于文件系统的对象数据库（raw-first）
 *
 * Git 将对象存储在 .git/objects/ 目录下：
 * - 每个对象以 zlib 压缩格式存储
 * - 路径格式: .git/objects/<前2字符>/<剩余38字符>
 * - 例如: .git/objects/95/d09f2b10159347eece71399a7e2e907ea3df4f
 *
 * ODB 的真实边界是 RawGitObject，不是 GitObject。
 * 写入路径直接接收 RawGitObject，不再经过语义序列化。
 */

import { join } from "node:path";

import { hashObject } from "../hash/index.ts";
import {
  deleteLooseObject,
  hasLooseObject,
  listLooseObjects,
  writeRawLooseObject,
  readRawLooseObject,
} from "./file-utils.ts";

import type { RawGitObject, SHA1 } from "../types/index.ts";
import type { ObjectDatabase } from "./types.ts";

/**
 * 创建基于文件系统的对象数据库
 *
 * @param gitDir - .git 目录的路径
 *
 * @example
 * ```ts
 * const db = createFileObjectStore("/path/to/repo/.git");
 *
 * // 摄入一个原始对象
 * db.ingest(raw);
 *
 * // 读取回来
 * const obj = db.read(hash);
 * ```
 */
export function createFileObjectStore(gitDir: string): ObjectDatabase {
  const objectsDir = join(gitDir, "objects");

  return {
    ingest(raw: RawGitObject): void {
      const expectedHash = hashObject(raw.type, raw.content);
      if (expectedHash !== raw.hash) {
        throw new Error(`RawGitObject hash mismatch: expected ${expectedHash}, got ${raw.hash}`);
      }
      if (hasLooseObject(objectsDir, raw.hash)) {
        return;
      }
      writeRawLooseObject(objectsDir, raw);
    },

    ingestMany(objects: Iterable<RawGitObject>): void {
      for (const raw of objects) {
        this.ingest(raw);
      }
    },

    read(hash: SHA1): RawGitObject {
      return readRawLooseObject(objectsDir, hash);
    },

    tryRead(hash: SHA1): RawGitObject | undefined {
      try {
        return readRawLooseObject(objectsDir, hash);
      } catch {
        return undefined;
      }
    },

    exists(hash: SHA1): boolean {
      return hasLooseObject(objectsDir, hash);
    },

    list(): SHA1[] {
      return listLooseObjects(objectsDir);
    },

    delete(hash: SHA1): void {
      deleteLooseObject(objectsDir, hash);
    },
  };
}
