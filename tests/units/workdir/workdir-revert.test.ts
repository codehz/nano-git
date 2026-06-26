/**
 * workdir/workdir.ts revert 操作单元测试
 */
import { describe, test, expect } from "bun:test";

import { VirtualPathNotFoundError, VirtualRevertNotSupportedError } from "@/core/errors.ts";
import { createMemoryRepository } from "@/repository/memory.ts";
import { createVirtualWorkdirMemoryStateStore } from "@/workdir/memory-backend.ts";
import { createVirtualWorkdir, openVirtualWorkdir } from "@/workdir/workdir.ts";

describe("revert", () => {
  test("共享同一个 origin blob hash 的不同路径中 revert 只恢复目标路径", () => {
    const repo = createMemoryRepository();
    const sharedBlobHash = repo.writeBlob(Buffer.from("shared"));
    const baseTree = repo.createTree([
      { mode: "100644", name: "a.txt", hash: sharedBlobHash },
      { mode: "100644", name: "b.txt", hash: sharedBlobHash },
    ]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.writeFile("a.txt", Buffer.from("edited-a"));
    session.writeFile("b.txt", Buffer.from("edited-b"));

    session.revert("a.txt");

    expect(session.readFile("a.txt").toString()).toBe("shared");
    expect(session.readFile("b.txt").toString()).toBe("edited-b");
  });

  test("revert 根路径抛错误", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    expect(() => session.revert("")).toThrow(/Path must not be empty/);
  });

  test("恢复 repo-backed 文件内容", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("old"));
    const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: blobHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.writeFile("f", Buffer.from("new"));
    expect(session.readFile("f").toString()).toBe("new");

    session.revert("f");
    expect(session.readFile("f").toString()).toBe("old");
    expect(session.diff()).toEqual([]);
  });

  test("重复修改后 revert 会清空单路径变更记录", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("old"));
    const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: blobHash }]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);
    const session = openVirtualWorkdir(repo.objects, store);

    session.writeFile("f", Buffer.from("v1"));
    session.writeFile("f", Buffer.from("v2"));
    expect(store.listChangeRecords()).toHaveLength(1);

    session.revert("f");
    expect(store.listChangeRecords()).toEqual([]);
    expect(session.diff()).toEqual([]);
    expect(session.readFile("f").toString()).toBe("old");
  });

  test("恢复 repo-backed 符号链接目标", () => {
    const repo = createMemoryRepository();
    const linkHash = repo.writeBlob(Buffer.from("old-target"));
    const baseTree = repo.createTree([{ mode: "120000", name: "link", hash: linkHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.writeLink("link", "new-target");
    session.revert("link");

    expect(session.readLink("link")).toBe("old-target");
  });

  test("恢复 copy 出来的 repo-backed 文件（未 materialize）为 no-op", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("repo data"));
    const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: blobHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.copy("f", "f-copy");
    session.revert("f-copy");

    expect(session.readFile("f-copy").toString()).toBe("repo data");
  });

  test("恢复 copy 出来的 repo-backed 文件（已 materialize）", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("repo data"));
    const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: blobHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.copy("f", "f-copy");
    session.writeFile("f-copy", Buffer.from("edited"));
    session.revert("f-copy");

    expect(session.readFile("f-copy").toString()).toBe("repo data");
  });

  test("恢复目录 overlay 到 origin", () => {
    const repo = createMemoryRepository();
    const childHash = repo.writeBlob(Buffer.from("base"));
    const dirHash = repo.createTree([{ mode: "100644", name: "base.txt", hash: childHash }]);
    const baseTree = repo.createTree([{ mode: "040000", name: "dir", hash: dirHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.writeFile("dir/new.txt", Buffer.from("new"));
    expect(session.readdir("dir").map((entry) => entry.name)).toEqual(["base.txt", "new.txt"]);

    session.revert("dir");
    expect(session.readdir("dir").map((entry) => entry.name)).toEqual(["base.txt"]);
  });

  test("恢复目录 overlay 后新增子路径不可见", () => {
    const repo = createMemoryRepository();
    const childHash = repo.writeBlob(Buffer.from("base"));
    const dirHash = repo.createTree([{ mode: "100644", name: "base.txt", hash: childHash }]);
    const baseTree = repo.createTree([{ mode: "040000", name: "dir", hash: dirHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.writeFile("dir/new.txt", Buffer.from("new"));
    session.revert("dir");

    expect(session.exists("dir/new.txt")).toBe(false);
    expect(() => session.readFile("dir/new.txt")).toThrow(VirtualPathNotFoundError);
  });

  test("恢复纯新建节点抛 VirtualRevertNotSupportedError", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("fresh.txt", Buffer.from("data"));
    expect(() => session.revert("fresh.txt")).toThrow(VirtualRevertNotSupportedError);
  });

  test("恢复不存在路径抛 VirtualPathNotFoundError", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    expect(() => session.revert("missing.txt")).toThrow(VirtualPathNotFoundError);
  });
});
