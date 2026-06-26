/**
 * workdir/workdir.ts delete 操作单元测试
 */
import { describe, test, expect } from "bun:test";

import { VirtualPathNotFoundError } from "@/core/errors.ts";
import { createMemoryRepository } from "@/repository/memory.ts";
import { createVirtualWorkdir } from "@/workdir/workdir.ts";

describe("delete", () => {
  test("删除新建文件", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("f.txt", Buffer.from("data"));
    expect(session.exists("f.txt")).toBe(true);
    session.delete("f.txt");
    expect(session.exists("f.txt")).toBe(false);
  });

  test("删除新建目录", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.mkdir("dir");
    expect(session.exists("dir")).toBe(true);
    session.delete("dir");
    expect(session.exists("dir")).toBe(false);
    expect(session.diff()).toEqual([]);
  });

  test("删除不存在的路径抛 VirtualPathNotFoundError", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });
    expect(() => session.delete("no/such")).toThrow(VirtualPathNotFoundError);
  });
});
