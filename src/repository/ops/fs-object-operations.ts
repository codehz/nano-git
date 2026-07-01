/**
 * 仓库文件系统对象操作组装
 */

import { readFileSync } from "node:fs";

import { writeTreeRecursive } from "../tree/tree-writer.ts";

import type { ObjectDatabase } from "../../odb/types.ts";
import type { SHA1 } from "../../types/index.ts";
import type { RepositoryFsObjectOperations } from "./object-types.ts";

/**
 * 创建文件系统对象操作集合
 *
 * @param objects - 对象数据库
 * @param writeBlob - 基础 blob 写入能力
 * @returns 文件系统对象操作集合
 *
 * @example
 * ```ts
 * const fsOps = createRepositoryFsObjectOperations(objects, writeBlob);
 * const hash = fsOps.writeBlobFile("/tmp/file.txt");
 * ```
 */
export function createRepositoryFsObjectOperations(
  objects: ObjectDatabase,
  writeBlob: (data: Buffer) => SHA1,
): RepositoryFsObjectOperations {
  return {
    writeBlobFile(filePath: string): SHA1 {
      return writeBlob(readFileSync(filePath));
    },

    writeTree(dirPath: string): SHA1 {
      return writeTreeRecursive(objects, dirPath);
    },
  };
}
