/**
 * workdir/dirty-dir.ts 单元测试
 */
import { describe, expect, test } from "bun:test";

import { sha1 } from "@/core/types.ts";
import {
  affectedDirectoryEntriesForPath,
  createDirtyDirSummary,
  incrementDirtyDirDescendantCount,
  mergeDirtyDirSummary,
  materializeDirtyDirSummary,
} from "@/workdir/dirty-dir.ts";

describe("affectedDirectoryEntriesForPath()", () => {
  test("按祖先目录链返回受影响的直接子项", () => {
    expect(affectedDirectoryEntriesForPath("a/b/c.txt")).toEqual([
      { dirPath: "", affectedName: "a" },
      { dirPath: "a", affectedName: "b" },
      { dirPath: "a/b", affectedName: "c.txt" },
    ]);
  });
});

describe("DirtyDirSummary helpers", () => {
  test("mergeDirtyDirSummary 会去重并标记 hash stale", () => {
    const initial = createDirtyDirSummary("src", ["b.ts"]);
    const merged = mergeDirtyDirSummary(initial, "src", "a.ts");
    const deduped = mergeDirtyDirSummary(merged, "src", "a.ts");

    expect(deduped).toEqual({
      path: "src",
      isDirty: true,
      dirtyEntryCount: 2,
      dirtyDescendantCount: 0,
      affectedNames: ["a.ts", "b.ts"],
      currentTreeHash: null,
      hashState: "stale",
    });
  });

  test("incrementDirtyDirDescendantCount 会累计更深层脏项数", () => {
    const summary = createDirtyDirSummary("", ["src"]);
    const next = incrementDirtyDirDescendantCount(summary, "");

    expect(incrementDirtyDirDescendantCount(next, "")).toEqual({
      path: "",
      isDirty: true,
      dirtyEntryCount: 1,
      dirtyDescendantCount: 2,
      affectedNames: ["src"],
      currentTreeHash: null,
      hashState: "stale",
    });
  });

  test("materializeDirtyDirSummary 会保留受影响子项并写入 tree hash", () => {
    const summary = incrementDirtyDirDescendantCount(createDirtyDirSummary("", ["src"]), "");
    const treeHash = sha1("1111111111111111111111111111111111111111");

    expect(materializeDirtyDirSummary(summary, "", treeHash)).toEqual({
      path: "",
      isDirty: true,
      dirtyEntryCount: 1,
      dirtyDescendantCount: 1,
      affectedNames: ["src"],
      currentTreeHash: treeHash,
      hashState: "materialized",
    });
  });
});
