/**
 * workdir/workdir.ts restore 操作单元测试
 */
import { describe, expect, test } from "bun:test";

import { VirtualPathNotFoundError } from "@/core/errors.ts";
import { createMemoryRepository } from "@/repository/memory.ts";
import { createVirtualWorkdir } from "@/workdir/workdir.ts";

describe("restore", () => {
  test("恢复被修改的 repo-backed 文件", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("base"));
    const baseTree = repo.createTree([{ mode: "100644", name: "f.txt", hash: blobHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.writeFile("f.txt", Buffer.from("changed"));
    session.restore("f.txt");

    expect(session.readFile("f.txt").toString()).toBe("base");
    expect(session.diff()).toEqual([]);
  });

  test("恢复被删除的 repo-backed 路径", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("base"));
    const baseTree = repo.createTree([{ mode: "100644", name: "f.txt", hash: blobHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.delete("f.txt");
    session.restore("f.txt");

    expect(session.readFile("f.txt").toString()).toBe("base");
    expect(session.diff()).toEqual([]);
  });

  test("未启用 force 时，恢复基线不存在的路径报错且不删除当前文件", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, { baseTree: repo.createTree([]) });

    session.writeFile("temp.txt", Buffer.from("temp"));

    expect(() => session.restore("temp.txt")).toThrow(VirtualPathNotFoundError);
    expect(session.readFile("temp.txt").toString()).toBe("temp");
  });

  test("启用 force 时，恢复基线不存在的路径等价于删除", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, { baseTree: repo.createTree([]) });

    session.mkdir("dir");
    session.writeFile("dir/a.txt", Buffer.from("temp"));
    session.restore("dir", { force: true });

    expect(session.exists("dir")).toBe(false);
    expect(session.diff()).toEqual([]);
  });

  test("默认不递归恢复目录子树修改", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("base"));
    const dirTree = repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]);
    const baseTree = repo.createTree([{ mode: "040000", name: "src", hash: dirTree }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.writeFile("src/a.txt", Buffer.from("changed"));
    session.restore("src");

    expect(session.stat("src")).toMatchObject({ kind: "tree", mode: "040000" });
    expect(session.readFile("src/a.txt").toString()).toBe("changed");
  });

  test("recursive 恢复目录时会清除子树修改", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("base"));
    const dirTree = repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]);
    const baseTree = repo.createTree([{ mode: "040000", name: "src", hash: dirTree }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.writeFile("src/a.txt", Buffer.from("changed"));
    session.restore("src", { recursive: true });

    expect(session.readFile("src/a.txt").toString()).toBe("base");
    expect(session.diff()).toEqual([]);
  });

  test("恢复目录路径时会按基线重建祖先目录链", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("base"));
    const nestedTree = repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]);
    const parentTree = repo.createTree([{ mode: "040000", name: "nested", hash: nestedTree }]);
    const baseTree = repo.createTree([{ mode: "040000", name: "src", hash: parentTree }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.delete("src");
    session.writeFile("src", Buffer.from("blocking file"));
    session.restore("src/nested/a.txt", { recursive: true });

    expect(session.stat("src")).toMatchObject({ kind: "tree", mode: "040000" });
    expect(session.readFile("src/nested/a.txt").toString()).toBe("base");
    expect(session.diff()).toEqual([]);
  });
});
