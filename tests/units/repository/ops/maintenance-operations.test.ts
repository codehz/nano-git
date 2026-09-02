/**
 * repository/ops/maintenance-operations.ts 单元测试
 */

import { describe, test, expect, beforeEach } from "bun:test";

import { bytes } from "../../../helpers/bytes.ts";
import { writeObject } from "@/objects/raw.ts";
import { createMemoryObjectStore } from "@/odb/memory.ts";
import { createMemoryRefStore } from "@/refs/memory.ts";
import { createMaintenanceRepositoryOperations } from "@/repository/ops/maintenance-operations.ts";
import { HEAD_REF, HEADS_PREFIX } from "@/types/refs.ts";

describe("createMaintenanceRepositoryOperations()", () => {
  let objects: ReturnType<typeof createMemoryObjectStore>;
  let refs: ReturnType<typeof createMemoryRefStore>;

  beforeEach(() => {
    objects = createMemoryObjectStore();
    refs = createMemoryRefStore(new Map([[HEAD_REF, `ref: ${HEADS_PREFIX}main`]]));
  });

  test("listReachableObjects() 空仓库返回空数组", () => {
    const ops = createMaintenanceRepositoryOperations(objects, refs);
    expect(ops.listReachableObjects()).toHaveLength(0);
  });

  test("listReachableObjects() 返回所有可达对象", () => {
    const blobHash = writeObject(objects, {
      type: "blob",
      content: bytes("content"),
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

    const ops = createMaintenanceRepositoryOperations(objects, refs);
    const reachable = ops.listReachableObjects();
    expect(reachable).toContain(blobHash);
    expect(reachable).toContain(treeHash);
    expect(reachable).toContain(commitHash);
  });

  test("gc() 无 pack 支持时清理不可达对象", () => {
    const blobHash = writeObject(objects, { type: "blob", content: bytes("reachable") });
    writeObject(objects, { type: "blob", content: bytes("unreachable") });
    refs.write("refs/heads/main", blobHash);

    const ops = createMaintenanceRepositoryOperations(objects, refs);
    const result = ops.gc();

    // gc 返回 undefined（无 pack 支持）
    expect(result).toBeUndefined();
    // 可达对象仍存在
    expect(() => objects.read(blobHash)).not.toThrow();
  });
});
