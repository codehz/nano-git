/**
 * workdir/workdir.ts mkdir 操作单元测试
 */
import { describe, test, expect } from "bun:test";

import {
  VirtualNotDirectoryError,
  VirtualPathAlreadyExistsError,
  VirtualPathNotFoundError,
} from "@/core/errors.ts";
import { createMemoryRepository } from "@/repository/memory.ts";
import { createVirtualWorkdir } from "@/workdir/workdir.ts";

describe("mkdir", () => {
  test("父目录不存在时抛 VirtualPathNotFoundError", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });
    expect(() => session.mkdir("no/such")).toThrow(VirtualPathNotFoundError);
  });

  test("重复创建抛 VirtualPathAlreadyExistsError", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });
    session.mkdir("x");
    expect(() => session.mkdir("x")).toThrow(VirtualPathAlreadyExistsError);
  });

  test("在文件下创建目录抛 VirtualNotDirectoryError", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("data"));
    const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: blobHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });
    expect(() => session.mkdir("f/sub")).toThrow(VirtualNotDirectoryError);
  });

  test("recursive 路径上存在文件时抛 VirtualNotDirectoryError", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("data"));
    const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: blobHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    expect(() => session.mkdir("f/sub", { recursive: true })).toThrow(VirtualNotDirectoryError);
  });

  test("recursive 目标路径已是文件时抛 VirtualNotDirectoryError", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("data"));
    const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: blobHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    expect(() => session.mkdir("f", { recursive: true })).toThrow(VirtualNotDirectoryError);
  });
});
