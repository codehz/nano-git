/**
 * 文件系统 Refs 辅助函数
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 递归列出目录下的所有引用文件
 *
 * @example
 * ```ts
 * const refs = listLooseRefsRecursive("/tmp/repo/.git/refs", "refs/");
 * ```
 */
export function listLooseRefsRecursive(baseDir: string, prefix: string): string[] {
  const refs: string[] = [];
  const entries = readdirSync(baseDir).sort();

  for (const entry of entries) {
    const fullPath = join(baseDir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      refs.push(...listLooseRefsRecursive(fullPath, `${prefix}${entry}/`));
      continue;
    }

    if (stat.isFile()) {
      refs.push(`${prefix}${entry}`);
    }
  }

  return refs;
}
