/**
 * workdir/workdir-path.ts 路径辅助逻辑测试
 *
 * directory-view.ts 相关测试已拆分到 directory-view.test.ts。
 */
import { describe, test, expect } from "bun:test";

import {
  VirtualNotDirectoryError,
  VirtualNotFileError,
  VirtualPathAlreadyExistsError,
  VirtualPathNotFoundError,
} from "@/core/errors.ts";
import { createMemoryRepository } from "@/repository/memory.ts";
import { createVirtualWorkdirMemoryStateStore } from "@/workdir/memory-backend.ts";
import {
  getDirectoryChildrenView,
  joinChildPath,
  requireExistingWriteTarget,
  requireMissingWriteTarget,
  resolveCurrentLeafAtPath,
  resolveLeafWriteTarget,
  resolvePathByParentLookup,
  resolveWriteParentDirectory,
  resolveWriteTargetInParent,
  resolveWriteTransfer,
} from "@/workdir/workdir-path.ts";
import { openVirtualWorkdir } from "@/workdir/workdir.ts";

import type { GitTree } from "@/core/types.ts";

function readTree(repo: ReturnType<typeof createMemoryRepository>, hash: string): GitTree {
  const object = repo.catFile(hash as import("@/core/types.ts").SHA1);
  if (object.type !== "tree") {
    throw new Error(`Expected tree, got ${object.type}`);
  }
  return object;
}

describe("joinChildPath()", () => {
  test("根目录下直接返回子项名称", () => {
    expect(joinChildPath("", "a.txt")).toBe("a.txt");
  });

  test("子目录下拼出完整子路径", () => {
    expect(joinChildPath("src", "a.txt")).toBe("src/a.txt");
  });
});

describe("resolvePathByParentLookup()", () => {
  test("按父目录定向解析最终条目", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("a"));
    const subTree = repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]);
    const baseTree = repo.createTree([{ mode: "040000", name: "src", hash: subTree }]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);
    const session = openVirtualWorkdir(repo.objects, store);

    session.writeFile("src/b.txt", Buffer.from("b"));

    const resolved = resolvePathByParentLookup(repo.objects, store, "src/b.txt");
    const missing = resolvePathByParentLookup(repo.objects, store, "src/missing.txt");

    expect(resolved.found).toBe(true);
    expect(resolved.node?.state.kind).toBe("file");
    expect(missing).toEqual({ found: false, node: null });
  });
});

describe("resolveWriteParentDirectory()", () => {
  test("返回父目录路径、名称与目录节点", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);
    const session = openVirtualWorkdir(repo.objects, store);

    session.mkdir("src");

    const target = resolveWriteParentDirectory(repo.objects, store, "src/a.txt");

    expect(target.parentPath).toBe("src");
    expect(target.name).toBe("a.txt");
    expect(target.parentNode.state.kind).toBe("directory");
  });

  test("父路径不存在时抛 VirtualPathNotFoundError", () => {
    const repo = createMemoryRepository();
    const store = createVirtualWorkdirMemoryStateStore(repo.createTree([]));

    expect(() => resolveWriteParentDirectory(repo.objects, store, "src/a.txt")).toThrow(
      VirtualPathNotFoundError,
    );
  });

  test("父路径不是目录时抛 VirtualNotDirectoryError", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("data"));
    const baseTree = repo.createTree([{ mode: "100644", name: "file", hash: blobHash }]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);

    expect(() => resolveWriteParentDirectory(repo.objects, store, "file/a.txt")).toThrow(
      VirtualNotDirectoryError,
    );
  });
});

describe("resolveWriteTargetInParent()", () => {
  test("同时返回父目录与现有目标子项", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("base"));
    const baseTree = repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);

    const target = resolveWriteTargetInParent(repo.objects, store, "a.txt");

    expect(target.parentPath).toBe("");
    expect(target.name).toBe("a.txt");
    expect(target.existing?.child.name).toBe("a.txt");
    expect(target.existing?.node.state.kind).toBe("file");
  });

  test("目标不存在时 existing 为 null", () => {
    const repo = createMemoryRepository();
    const store = createVirtualWorkdirMemoryStateStore(repo.createTree([]));

    const target = resolveWriteTargetInParent(repo.objects, store, "missing.txt");

    expect(target.parentPath).toBe("");
    expect(target.name).toBe("missing.txt");
    expect(target.existing).toBeNull();
  });
});

describe("requireExistingWriteTarget()", () => {
  test("要求目标存在并返回现有子项", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("base"));
    const baseTree = repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);

    const target = requireExistingWriteTarget(repo.objects, store, "a.txt");

    expect(target.parentPath).toBe("");
    expect(target.name).toBe("a.txt");
    expect(target.existing.child.name).toBe("a.txt");
    expect(target.existing.node.state.kind).toBe("file");
  });

  test("目标不存在时抛 VirtualPathNotFoundError", () => {
    const repo = createMemoryRepository();
    const store = createVirtualWorkdirMemoryStateStore(repo.createTree([]));

    expect(() => requireExistingWriteTarget(repo.objects, store, "missing.txt")).toThrow(
      VirtualPathNotFoundError,
    );
  });
});

describe("requireMissingWriteTarget()", () => {
  test("要求目标不存在并返回父目录上下文", () => {
    const repo = createMemoryRepository();
    const store = createVirtualWorkdirMemoryStateStore(repo.createTree([]));

    const target = requireMissingWriteTarget(repo.objects, store, "new.txt");

    expect(target.parentPath).toBe("");
    expect(target.name).toBe("new.txt");
    expect(target.parentNode.state.kind).toBe("directory");
  });

  test("目标已存在时抛 VirtualPathAlreadyExistsError", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("base"));
    const baseTree = repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);

    expect(() => requireMissingWriteTarget(repo.objects, store, "a.txt")).toThrow(
      VirtualPathAlreadyExistsError,
    );
  });
});

describe("resolveLeafWriteTarget()", () => {
  test("允许覆盖已有文件并返回叶子子项", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("base"));
    const baseTree = repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);

    const target = resolveLeafWriteTarget(repo.objects, store, "a.txt");

    expect(target.parentPath).toBe("");
    expect(target.name).toBe("a.txt");
    expect(target.existing?.child.name).toBe("a.txt");
    expect(target.existing?.node.state.kind).toBe("file");
  });

  test("目录路径上写入时抛 VirtualNotFileError", () => {
    const repo = createMemoryRepository();
    const subTree = repo.createTree([]);
    const baseTree = repo.createTree([{ mode: "040000", name: "dir", hash: subTree }]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);

    expect(() => resolveLeafWriteTarget(repo.objects, store, "dir")).toThrow(VirtualNotFileError);
  });
});

describe("resolveCurrentLeafAtPath()", () => {
  test("返回当前文件叶子节点", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("base"));
    const baseTree = repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);

    const leaf = resolveCurrentLeafAtPath(repo.objects, store, "a.txt");

    expect(leaf?.path).toBe("a.txt");
    expect(leaf?.node.state.kind).toBe("file");
  });

  test("目录路径返回 null", () => {
    const repo = createMemoryRepository();
    const subTree = repo.createTree([]);
    const baseTree = repo.createTree([{ mode: "040000", name: "dir", hash: subTree }]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);

    expect(resolveCurrentLeafAtPath(repo.objects, store, "dir")).toBeNull();
  });

  test("不存在路径返回 null", () => {
    const repo = createMemoryRepository();
    const store = createVirtualWorkdirMemoryStateStore(repo.createTree([]));

    expect(resolveCurrentLeafAtPath(repo.objects, store, "missing.txt")).toBeNull();
  });
});

describe("resolveWriteTransfer()", () => {
  test("同时返回已存在源与目标上下文", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("base"));
    const dirTree = repo.createTree([]);
    const baseTree = repo.createTree([
      { mode: "100644", name: "a.txt", hash: blobHash },
      { mode: "040000", name: "dir", hash: dirTree },
    ]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);

    const transfer = resolveWriteTransfer(repo.objects, store, "a.txt", "dir/b.txt");

    expect(transfer.from.name).toBe("a.txt");
    expect(transfer.from.existing.child.name).toBe("a.txt");
    expect(transfer.to.parentPath).toBe("dir");
    expect(transfer.to.name).toBe("b.txt");
  });

  test("源不存在时抛 VirtualPathNotFoundError", () => {
    const repo = createMemoryRepository();
    const store = createVirtualWorkdirMemoryStateStore(repo.createTree([]));

    expect(() => resolveWriteTransfer(repo.objects, store, "missing.txt", "next.txt")).toThrow(
      VirtualPathNotFoundError,
    );
  });
});
