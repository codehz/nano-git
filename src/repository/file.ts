/**
 * 文件仓库便捷创建函数
 *
 * 初始化或打开基于文件系统的 Git 仓库。
 * 拉入 `node:fs` 和完整文件后端。
 *
 * 函数直接接受仓库根路径作为 `gitDir` 参数：
 * - bare 仓库：传入仓库根路径即可
 * - 非 bare 仓库：显式传入 `.git` 子路径
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

import { createFileRepositoryBackend } from "../backend/file.ts";
import { RepositoryError } from "../errors.ts";
import { createRepository } from "./create.ts";
import { createRepositoryFsObjectOperations } from "./ops/fs-object-operations.ts";

import type { FileRepository } from "./types.ts";

/**
 * 初始化一个新的 bare Git 仓库
 *
 * 等价于 `git init --bare`，所有 Git 数据直接存放在传入路径下。
 * 如需创建非 bare 仓库，请自行拼接 `.git` 子路径。
 *
 * @param path - bare 仓库根目录路径（Git 数据直接存放于此）
 * @returns 仓库实例
 *
 * @example
 * ```ts
 * const repo = initRepository("/tmp/demo");
 * console.log(repo.getCurrentBranch()); // => "main"
 * ```
 */
export function initRepository(path: string): FileRepository {
  mkdirSync(join(path, "objects"), { recursive: true });
  mkdirSync(join(path, "refs", "heads"), { recursive: true });
  mkdirSync(join(path, "refs", "tags"), { recursive: true });
  writeFileSync(join(path, "HEAD"), "ref: refs/heads/main\n");

  return createFileRepository(path);
}

/**
 * 打开一个已有的 Git 仓库
 *
 * 传入的路径直接作为 `gitDir` 使用：
 * - bare 仓库：传入仓库根路径
 * - 非 bare 仓库：传入 `.git` 目录的完整路径
 *
 * 通过检测 `HEAD` 文件是否存在来判断是否为有效的 git 目录。
 *
 * @param path - git 目录路径（bare 仓库根路径，或非 bare 仓库的 `.git` 目录）
 * @returns 仓库实例
 *
 * @example
 * ```ts
 * // bare 仓库
 * const bareRepo = openRepository("/path/to/bare-repo");
 *
 * // 非 bare 仓库（需显式传入 .git 路径）
 * const nonBareRepo = openRepository("/path/to/repo/.git");
 * ```
 */
export function openRepository(path: string): FileRepository {
  if (!existsSync(join(path, "HEAD"))) {
    throw new RepositoryError(`Not a git repository: ${path}`);
  }

  return createFileRepository(path);
}

function createFileRepository(path: string): FileRepository {
  const backend = createFileRepositoryBackend(path);
  const repo = createRepository(backend);
  return {
    ...repo,
    ...createRepositoryFsObjectOperations(backend.objects, (data) => repo.writeBlob(data)),
    gitDir: path,
  };
}
