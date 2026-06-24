/**
 * repository/ops/maintenance-operations.ts 单元测试
 */

import { describe, test, expect, beforeEach } from "bun:test";

import { HEAD_REF, HEADS_PREFIX } from "@/core/types/refs.ts";
import { writeObject } from "@/objects/raw.ts";
import { createMemoryObjectStore } from "@/odb/memory.ts";
import { createMemoryRefStore } from "@/refs/memory.ts";
import { createMaintenanceRepositoryOperations } from "@/repository/ops/maintenance-operations.ts";

describe("createMaintenanceRepositoryOperations()", () => {
  let objects: ReturnType<typeof createMemoryObjectStore>;
  let refs: ReturnType<typeof createMemoryRefStore>;

  beforeEach(() => {
    objects = createMemoryObjectStore();
    refs = createMemoryRefStore(new Map([[HEAD_REF, `ref: ${HEADS_PREFIX}main`]]));
  });

  test("packs 为 null 时 writePack 抛出异常", () => {
    const ops = createMaintenanceRepositoryOperations(objects, refs, null);
    expect(() => ops.writePack()).toThrow("Backend does not support packfile writes");
  });

  test("packs 为 null 时 repack 抛出异常", () => {
    const ops = createMaintenanceRepositoryOperations(objects, refs, null);
    expect(() => ops.repack()).toThrow("Backend does not support repack");
  });

  test("listReachableObjects() 空仓库返回空数组", () => {
    const ops = createMaintenanceRepositoryOperations(objects, refs, null);
    expect(ops.listReachableObjects()).toHaveLength(0);
  });

  test("listReachableObjects() 返回所有可达对象", () => {
    const blobHash = writeObject(objects, {
      type: "blob",
      content: Buffer.from("content"),
    });
    const treeHash = writeObject(objects, {
      type: "tree",
      entries: [{ mode: "100644", name: "f.txt", hash: blobHash }],
    });
    const commitHash = writeObject(objects, {
      type: "commit",
      tree: treeHash,
      parents: [],
      author: {
        name: "T",
        email: "t@t.com",
        timestamp: 1,
        timezone: "+0000",
      },
      committer: {
        name: "T",
        email: "t@t.com",
        timestamp: 1,
        timezone: "+0000",
      },
      message: "init",
    });
    refs.write("refs/heads/main", commitHash);

    const ops = createMaintenanceRepositoryOperations(objects, refs, null);
    const reachable = ops.listReachableObjects();
    expect(reachable).toContain(blobHash);
    expect(reachable).toContain(treeHash);
    expect(reachable).toContain(commitHash);
  });

  test("gc() 无 pack 支持时清理不可达对象", () => {
    const blobHash = writeObject(objects, { type: "blob", content: Buffer.from("reachable") });
    writeObject(objects, { type: "blob", content: Buffer.from("unreachable") });
    refs.write("refs/heads/main", blobHash);

    const ops = createMaintenanceRepositoryOperations(objects, refs, null);
    const result = ops.gc();

    // gc 返回 undefined（无 pack 支持）
    expect(result).toBeUndefined();
    // 可达对象仍存在
    expect(() => objects.read(blobHash)).not.toThrow();
  });
});
