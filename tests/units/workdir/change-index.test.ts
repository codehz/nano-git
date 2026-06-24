/**
 * workdir/change-index.ts 规范化变更索引测试
 */
import { describe, expect, test } from "bun:test";

import { createMemoryRepository } from "@/repository/memory.ts";
import {
  rebuildNormalizedChangeIndex,
  refreshChangeRecordForPath,
  writeChangeRecordForCopy,
} from "@/workdir/change-index.ts";
import { createVirtualWorkdirMemoryStateStore } from "@/workdir/memory-backend.ts";
import { openVirtualWorkdirSession } from "@/workdir/session.ts";

describe("change-index lineage", () => {
  test("refreshChangeRecordForPath() 保留 rename 来源", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("data"));
    const baseTree = repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);
    const session = openVirtualWorkdirSession(repo.objects, store);

    session.rename("a.txt", "b.txt");
    session.writeFile("b.txt", Buffer.from("changed"));

    const beforeRefresh = store.getChangeRecord("b.txt");
    refreshChangeRecordForPath(repo.objects, store, "b.txt");

    expect(store.listChangeRecords()).toHaveLength(1);
    expect(store.getChangeRecord("b.txt")).toEqual(beforeRefresh);
    expect(store.getChangeRecord("b.txt")).toMatchObject({
      path: "b.txt",
      source: {
        kind: "rename",
        path: "a.txt",
      },
    });
  });

  test("writeChangeRecordForCopy() 继承 rename 的原始来源路径", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("data"));
    const baseTree = repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);
    const session = openVirtualWorkdirSession(repo.objects, store);

    session.rename("a.txt", "b.txt");
    session.copy("b.txt", "c.txt");

    store.deleteChangeRecord("c.txt");
    writeChangeRecordForCopy(repo.objects, store, "b.txt", "c.txt");

    expect(store.getChangeRecord("c.txt")).toMatchObject({
      path: "c.txt",
      previous: null,
      source: {
        kind: "copy",
        path: "a.txt",
      },
    });
  });

  test("rebuildNormalizedChangeIndex() 全量重建后保留 rename/copy lineage 语义", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("data"));
    const baseTree = repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);
    const session = openVirtualWorkdirSession(repo.objects, store);

    session.rename("a.txt", "b.txt");
    session.writeFile("b.txt", Buffer.from("changed"));
    session.copy("b.txt", "c.txt");

    expect(rebuildNormalizedChangeIndex(repo.objects, store)).toMatchObject([
      {
        path: "b.txt",
        source: {
          kind: "rename",
          path: "a.txt",
        },
      },
      {
        path: "c.txt",
        source: {
          kind: "copy",
          path: "a.txt",
        },
      },
    ]);
  });
});
