/**
 * 文件仓库便捷创建函数
 *
 * 初始化或打开基于文件系统的 Git 仓库。
 * 拉入 `node:fs` 和完整文件后端。
 *
 * @example
 * ```ts
 * import { initRepository, openRepository } from "nano-git/repository/file";
 *
 * const repo = initRepository("/tmp/my-repo");
 * ```
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { createFileRepositoryBackend } from "../backend/index.ts";
import { RepositoryError } from "../core/errors.ts";
import { createRepository } from "./create.ts";

import type { Repository } from "./types.ts";

/**
 * 初始化一个新的 Git 仓库
 *
 * 等价于 `git init`
 *
 * @param path - 仓库根目录路径
 * @returns 仓库实例
 *
 * @example
 * ```ts
 * const repo = initRepository("/tmp/demo");
 * console.log(repo.getCurrentBranch()); // => "main"
 * ```
 */
export function initRepository(path: string): Repository {
  const gitDir = join(path, ".git");

  mkdirSync(join(gitDir, "objects"), { recursive: true });
  mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
  mkdirSync(join(gitDir, "refs", "tags"), { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");

  return createRepository(createFileRepositoryBackend(gitDir));
}

/**
 * 打开一个已有的 Git 仓库
 *
 * @param path - 仓库根目录路径
 * @returns 仓库实例
 *
 * @example
 * ```ts
 * const repo = openRepository("/path/to/repo");
 * console.log(repo.readRef("HEAD"));
 * ```
 */
export function openRepository(path: string): Repository {
  const gitDir = join(path, ".git");

  if (!existsSync(gitDir)) {
    throw new RepositoryError(`Not a git repository: ${path}`);
  }

  return createRepository(createFileRepositoryBackend(gitDir));
}
