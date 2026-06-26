/**
 * workdir/workdir.ts 只读视图单元测试
 */
import { describe, test, expect } from "bun:test";

import {
  VirtualNotFileError,
  VirtualOriginUnavailableError,
  VirtualPathNotFoundError,
} from "@/core/errors.ts";
import { createMemoryRepository } from "@/repository/memory.ts";
import { createVirtualWorkdir } from "@/workdir/workdir.ts";

describe("createVirtualWorkdir() 只读", () => {
  test("空 tree 根目录可读", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    expect(session.baseTree).toBe(baseTree);
    expect(session.exists("")).toBe(true);
    expect(session.readdir()).toEqual([]);
    expect(session.readdir("")).toEqual([]);
    expect(session.stat("")).toEqual({
      kind: "tree",
      mode: "040000",
      size: 0,
      hash: baseTree,
    });
  });

  test("路径不存在时 readFile 抛 VirtualPathNotFoundError", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });
    expect(() => session.readFile("nope")).toThrow(VirtualPathNotFoundError);
  });

  test("对符号链接 readFile 抛 VirtualNotFileError", () => {
    const repo = createMemoryRepository();
    const linkHash = repo.writeBlob(Buffer.from("x"));
    const baseTree = repo.createTree([{ mode: "120000", name: "l", hash: linkHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });
    expect(() => session.readFile("l")).toThrow(VirtualNotFileError);
  });

  test("origin 对象缺失时抛 VirtualOriginUnavailableError", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("gone"));
    const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: blobHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });
    repo.objects.delete(blobHash);
    expect(() => session.readFile("f")).toThrow(VirtualOriginUnavailableError);
  });
});
