/**
 * Virtual Workdir 多后端合同测试
 *
 * 由共享行为断言 + 后端矩阵组成，
 * 便于测试按“语义目标”组织，再由 describe.each 覆盖多个后端。
 */
import { afterAll, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VirtualOriginUnavailableError, VirtualPathNotFoundError } from "@/core/errors.ts";
import { createMemoryRepository } from "@/repository/memory.ts";
import { openFileVirtualWorkdir } from "@/workdir/file.ts";
import { createVirtualWorkdir } from "@/workdir/memory.ts";
import { openSqliteVirtualWorkdir } from "@/workdir/sqlite.ts";

import type { SHA1 } from "@/core/types.ts";
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

/**
 * 注册 VirtualWorkdir 的共享合同测试
 *
 * @example
 * ```ts
 * describe.each(virtualWorkdirBackends)("$name", ({ createWorkdir }) => {
 *   registerVirtualWorkdirContract(createWorkdir);
 * });
 * ```
 */
export function registerVirtualWorkdirContract(createWorkdir: VirtualWorkdirFactory): void {
  test("从空 tree 打开并写入文件/目录/符号链接", () => {
    const repo = createMemoryRepository();
    const session = createWorkdir(repo, { baseTree: repo.createTree([]) });

    expect(session.readdir()).toEqual([]);
    session.mkdir("dir");
    session.writeFile("dir/file.txt", Buffer.from("hello"));
    session.writeLink("link", "target");

    expect(session.readFile("dir/file.txt").toString()).toBe("hello");
    expect(session.readLink("link")).toBe("target");
    expect(session.readdir().map((entry) => entry.name)).toEqual(["dir", "link"]);
  });

  test("从非空 tree 打开并读取 repo-backed 文件、目录、符号链接", () => {
    const repo = createMemoryRepository();
    const fileHash = repo.writeBlob(Buffer.from("hello"));
    const linkHash = repo.writeBlob(Buffer.from("target"));
    const dirHash = repo.createTree([{ mode: "100644", name: "nested.txt", hash: fileHash }]);
    const baseTree = repo.createTree([
      { mode: "100644", name: "file.txt", hash: fileHash },
      { mode: "040000", name: "dir", hash: dirHash },
      { mode: "120000", name: "link", hash: linkHash },
    ]);
    const session = createWorkdir(repo, { baseTree });

    expect(session.readFile("file.txt").toString()).toBe("hello");
    expect(session.readFile("dir/nested.txt").toString()).toBe("hello");
    expect(session.readLink("link")).toBe("target");
  });

  test("删除路径后不可见", () => {
    const repo = createMemoryRepository();
    const fileHash = repo.writeBlob(Buffer.from("gone"));
    const session = createWorkdir(repo, {
      baseTree: repo.createTree([{ mode: "100644", name: "file.txt", hash: fileHash }]),
    });

    session.delete("file.txt");
    expect(session.exists("file.txt")).toBe(false);
    expect(() => session.readFile("file.txt")).toThrow(VirtualPathNotFoundError);
  });

  test("restore 可恢复到基线内容", () => {
    const repo = createMemoryRepository();
    const fileHash = repo.writeBlob(Buffer.from("base"));
    const baseTree = repo.createTree([{ mode: "100644", name: "file.txt", hash: fileHash }]);
    const session = createWorkdir(repo, { baseTree });

    session.writeFile("file.txt", Buffer.from("edited"));
    session.restore("file.txt");

    expect(session.readFile("file.txt").toString()).toBe("base");
    expect(session.diff()).toEqual([]);
  });

  test("目录 restore 默认不递归恢复子树修改", () => {
    const repo = createMemoryRepository();
    const fileHash = repo.writeBlob(Buffer.from("base"));
    const dirTree = repo.createTree([{ mode: "100644", name: "nested.txt", hash: fileHash }]);
    const baseTree = repo.createTree([{ mode: "040000", name: "dir", hash: dirTree }]);
    const session = createWorkdir(repo, { baseTree });

    session.writeFile("dir/nested.txt", Buffer.from("edited"));
    session.restore("dir");

    expect(session.readFile("dir/nested.txt").toString()).toBe("edited");
  });

  test("重复 writeTree 结果稳定", () => {
    const repo = createMemoryRepository();
    const session = createWorkdir(repo, { baseTree: repo.createTree([]) });

    session.writeFile("file.txt", Buffer.from("stable"));
    const hash1 = session.writeTree();
    const hash2 = session.writeTree();

    expect(hash1).toBe(hash2);
  });

  test("重复 diff 结果稳定", () => {
    const repo = createMemoryRepository();
    const fileHash = repo.writeBlob(Buffer.from("base"));
    const baseTree = repo.createTree([{ mode: "100644", name: "file.txt", hash: fileHash }]);
    const session = createWorkdir(repo, { baseTree });

    session.writeFile("file.txt", Buffer.from("edited"));
    session.writeFile("fresh.txt", Buffer.from("new"));

    const diff1 = session.diff();
    const diff2 = session.diff();

    expect(diff2).toEqual(diff1);
  });

  test("move 文件与目录保持可读", () => {
    const repo = createMemoryRepository();
    const session = createWorkdir(repo, { baseTree: repo.createTree([]) });

    session.mkdir("src");
    session.writeFile("src/main.ts", Buffer.from("code"));
    session.move("src/main.ts", "src/index.ts");
    session.move("src", "lib");

    expect(session.exists("src")).toBe(false);
    expect(session.readFile("lib/index.ts").toString()).toBe("code");
  });

  test("copy 文件与目录后可独立修改", () => {
    const repo = createMemoryRepository();
    const session = createWorkdir(repo, { baseTree: repo.createTree([]) });

    session.mkdir("src");
    session.writeFile("src/main.ts", Buffer.from("v1"));
    session.copy("src", "src-copy");
    session.writeFile("src/main.ts", Buffer.from("v2"));

    expect(session.readFile("src/main.ts").toString()).toBe("v2");
    expect(session.readFile("src-copy/main.ts").toString()).toBe("v1");
  });

  test("reset 丢弃 overlay", () => {
    const repo = createMemoryRepository();
    const fileHash = repo.writeBlob(Buffer.from("after"));
    const nextTree = repo.createTree([{ mode: "100644", name: "after.txt", hash: fileHash }]);
    const session = createWorkdir(repo, { baseTree: repo.createTree([]) });

    session.writeFile("before.txt", Buffer.from("before"));
    session.reset(nextTree);

    expect(session.exists("before.txt")).toBe(false);
    expect(session.readFile("after.txt").toString()).toBe("after");
    expect(session.diff()).toEqual([]);
  });

  test("origin 缺失时报 VirtualOriginUnavailableError", () => {
    const repo = createMemoryRepository();
    const fileHash = repo.writeBlob(Buffer.from("gone"));
    const session = createWorkdir(repo, {
      baseTree: repo.createTree([{ mode: "100644", name: "file.txt", hash: fileHash }]),
    });

    repo.objects.delete(fileHash);
    expect(() => session.readFile("file.txt")).toThrow(VirtualOriginUnavailableError);
  });

  test("writeTree 后可被新 workdir 重新打开", () => {
    const repo = createMemoryRepository();
    const session = createWorkdir(repo, { baseTree: repo.createTree([]) });

    session.writeFile("a.txt", Buffer.from("alpha"));
    session.mkdir("dir");
    session.writeFile("dir/b.txt", Buffer.from("beta"));

    const tree = session.writeTree();
    const reopened = createWorkdir(repo, { baseTree: tree as SHA1 });

    expect(reopened.readFile("a.txt").toString()).toBe("alpha");
    expect(reopened.readFile("dir/b.txt").toString()).toBe("beta");
  });
}

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
