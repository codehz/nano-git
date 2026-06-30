/**
 * Virtual Worktree 多后端合同测试基础设施
 *
 * 提供后端矩阵与共享工厂类型，
 * 具体合同测试按主题拆分到独立 test 文件。
 */
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openFileVirtualWorktree } from "@/worktree/file.ts";
import { createVirtualWorktree } from "@/worktree/memory.ts";
import { openSqliteVirtualWorktree } from "@/worktree/sqlite.ts";

import type { Repository } from "@/repository/types.ts";
import type { CreateVirtualWorktreeOptions, VirtualWorktree } from "@/worktree/core.ts";

export interface VirtualWorktreeBackend {
  readonly name: string;
  readonly createWorktree: VirtualWorktreeFactory;
}

export type VirtualWorktreeFactory = (
  repo: Repository,
  options: CreateVirtualWorktreeOptions,
) => VirtualWorktree;

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * VirtualWorktree 后端矩阵
 *
 * @example
 * ```ts
 * describe.each(virtualWorktreeBackends)("$name", ({ createWorktree }) => {
 *   registerVirtualWorktreeContract(createWorktree);
 * });
 * ```
 */
export const virtualWorktreeBackends = [
  {
    name: "memory",
    createWorktree: (repo, options) => createVirtualWorktree(repo.objects, options),
  },
  {
    name: "file",
    createWorktree: (repo, options) => {
      const root = mkdtempSync(join(tmpdir(), "nano-git-worktree-contract-file-"));
      tempRoots.push(root);
      return openFileVirtualWorktree(repo.objects, root, {
        ...options,
        create: true,
      });
    },
  },
  {
    name: "sqlite",
    createWorktree: (repo, options) =>
      openSqliteVirtualWorktree(repo.objects, ":memory:", "demo", {
        ...options,
        create: true,
      }),
  },
] satisfies VirtualWorktreeBackend[];
