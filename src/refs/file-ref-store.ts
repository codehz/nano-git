/**
 * 基于文件系统的 Refs 存储
 *
 * Git 引用存储在 .git/ 目录下：
 * - refs/heads/main   — 分支引用
 * - refs/tags/v1.0.0  — 标签引用
 * - HEAD              — 当前检出的引用
 *
 * 引用文件内容格式：
 * - 直接引用: "abc123...\n"
 * - 符号引用: "ref: refs/heads/main\n"
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { RefNotFoundError } from "../errors.ts";
import type { RefStore } from "./types.ts";
import { validateRefName, validateRefPrefix, listLooseRefsRecursive } from "./utils.ts";

/**
 * 创建基于文件系统的 Refs 存储
 *
 * @param gitDir - .git 目录的路径
 *
 * @example
 * ```ts
 * const refStore = createFileRefStore("/path/to/repo/.git");
 * const content = refStore.readRaw("refs/heads/main");
 * console.log(content); // => "abc123..." 或 "ref: refs/heads/main"
 * ```
 */
export function createFileRefStore(gitDir: string): RefStore {
  return {
    readRaw(ref: string): string | null {
      validateRefName(ref);
      const refPath = join(gitDir, ref);
      if (!existsSync(refPath)) {
        return null;
      }

      return readFileSync(refPath, "utf-8").trimEnd();
    },

    writeRaw(ref: string, content: string): void {
      validateRefName(ref);
      const refPath = join(gitDir, ref);
      mkdirSync(dirname(refPath), { recursive: true });
      writeFileSync(refPath, `${content.trimEnd()}\n`);
    },

    deleteRaw(ref: string): void {
      validateRefName(ref);
      const refPath = join(gitDir, ref);
      if (!existsSync(refPath)) {
        throw new RefNotFoundError(ref);
      }

      unlinkSync(refPath);
    },

    listRaw(prefix: string): string[] {
      validateRefPrefix(prefix);
      const baseDir = join(gitDir, prefix);
      if (!existsSync(baseDir)) {
        return [];
      }

      return listLooseRefsRecursive(baseDir, prefix).sort();
    },
  };
}
