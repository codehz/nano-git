/**
 * Virtual Workdir 多后端合同测试基础设施
 *
 * 提供后端矩阵与共享工厂类型，
 * 具体合同测试按主题拆分到独立 test 文件。
 */
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openFileVirtualWorkdir } from "@/workdir/file.ts";
import { createVirtualWorkdir } from "@/workdir/memory.ts";
import { openSqliteVirtualWorkdir } from "@/workdir/sqlite.ts";

import type { Repository } from "@/repository/types.ts";
import type { CreateVirtualWorkdirOptions, VirtualWorkdir } from "@/workdir/core.ts";

export interface VirtualWorkdirBackend {
  readonly name: string;
  readonly createWorkdir: VirtualWorkdirFactory;
}

export type VirtualWorkdirFactory = (
  repo: Repository,
  options: CreateVirtualWorkdirOptions,
) => VirtualWorkdir;

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * VirtualWorkdir 后端矩阵
 *
 * @example
 * ```ts
 * describe.each(virtualWorkdirBackends)("$name", ({ createWorkdir }) => {
 *   registerVirtualWorkdirContract(createWorkdir);
 * });
 * ```
 */
export const virtualWorkdirBackends = [
  {
    name: "memory",
    createWorkdir: (repo, options) => createVirtualWorkdir(repo.objects, options),
  },
  {
    name: "file",
    createWorkdir: (repo, options) => {
      const root = mkdtempSync(join(tmpdir(), "nano-git-workdir-contract-file-"));
      tempRoots.push(root);
      return openFileVirtualWorkdir(repo.objects, root, {
        ...options,
        create: true,
      });
    },
  },
  {
    name: "sqlite",
    createWorkdir: (repo, options) =>
      openSqliteVirtualWorkdir(repo.objects, ":memory:", "demo", {
        ...options,
        create: true,
      }),
  },
] satisfies VirtualWorkdirBackend[];
