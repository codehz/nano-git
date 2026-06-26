/**
 * workdir/change-index.ts 规范化变更索引测试
 */
import { describe, expect, test } from "bun:test";

import { createMemoryRepository } from "@/repository/memory.ts";
import {
  rebuildNormalizedChangeIndex,
  refreshChangeRecordForPath,
} from "@/workdir/change-index.ts";
import { createVirtualWorkdirMemoryStateStore } from "@/workdir/memory-backend.ts";
import { openVirtualWorkdir } from "@/workdir/workdir.ts";

describe("change-index", () => {
  test("refreshChangeRecordForPath() 基于当前最终状态重算记录", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("data"));
    const baseTree = repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);
    const session = openVirtualWorkdir(repo.objects, store);

    session.move("a.txt", "b.txt");
    session.writeFile("b.txt", Buffer.from("changed"));

    refreshChangeRecordForPath(repo.objects, store, "b.txt");

    expect(store.listChangeRecords()).toHaveLength(2);
    expect(store.getChangeRecord("b.txt")).toMatchObject({
      path: "b.txt",
      previous: null,
    });
    expect(store.getChangeRecord("a.txt")).toMatchObject({
      path: "a.txt",
      current: null,
    });
  });

  test("rebuildNormalizedChangeIndex() 将路径变更收敛为最终 create/remove", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("data"));
    const baseTree = repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);
    const session = openVirtualWorkdir(repo.objects, store);

    session.move("a.txt", "b.txt");
    session.writeFile("b.txt", Buffer.from("changed"));
    session.copy("b.txt", "c.txt");

    const records = rebuildNormalizedChangeIndex(repo.objects, store);
    const aRecord = records.find((record) => record.path === "a.txt");
    const bRecord = records.find((record) => record.path === "b.txt");
    const cRecord = records.find((record) => record.path === "c.txt");

    expect(aRecord).not.toBeUndefined();
    expect(aRecord?.previous?.kind).toBe("blob");
    expect(aRecord?.previous?.mode).toBe("100644");
    expect(aRecord?.current).toBeNull();

    expect(bRecord).not.toBeUndefined();
    expect(bRecord?.previous).toBeNull();
    expect(bRecord?.current?.kind).toBe("blob");
    expect(bRecord?.current?.mode).toBe("100644");

    expect(cRecord).not.toBeUndefined();
    expect(cRecord?.previous).toBeNull();
    expect(cRecord?.current?.kind).toBe("blob");
    expect(cRecord?.current?.mode).toBe("100644");
  });
});
