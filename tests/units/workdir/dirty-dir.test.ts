/**
 * workdir/dirty-dir.ts 脏目录摘要测试
 */
import { describe, expect, test } from "bun:test";

import { sha1 } from "@/core/types.ts";
import {
  affectedDirectoryEntriesForPath,
  ancestorDirectoryPathsFor,
  createDirtyDirSummary,
  incrementDirtyDirDescendantCount,
  materializeDirtyDirSummary,
  mergeDirtyDirSummary,
} from "@/workdir/dirty-dir.ts";

describe("ancestorDirectoryPathsFor()", () => {
  test("返回包含根目录的有序祖先目录链", () => {
    expect(ancestorDirectoryPathsFor("src/lib/a.ts")).toEqual(["", "src", "src/lib"]);
  });

  test("根下文件仅影响根目录", () => {
    expect(ancestorDirectoryPathsFor("a.txt")).toEqual([""]);
  });
});

describe("affectedDirectoryEntriesForPath()", () => {
  test("按祖先目录链生成直接受影响条目", () => {
    expect(affectedDirectoryEntriesForPath("src/lib/a.ts")).toEqual([
      { dirPath: "", affectedName: "src" },
      { dirPath: "src", affectedName: "lib" },
      { dirPath: "src/lib", affectedName: "a.ts" },
    ]);
  });
});

describe("DirtyDirSummary helpers", () => {
  test("createDirtyDirSummary() 会去重并排序 affectedNames", () => {
    expect(createDirtyDirSummary("src", ["b.ts", "a.ts", "b.ts"])).toEqual({
      path: "src",
      isDirty: true,
      dirtyEntryCount: 2,
      dirtyDescendantCount: 0,
      affectedNames: ["a.ts", "b.ts"],
      currentTreeHash: null,
      hashState: "stale",
    });
  });

  test("mergeDirtyDirSummary() 重复合并同名条目时不膨胀计数", () => {
    const first = mergeDirtyDirSummary(null, "src", "b.ts");
    const merged = mergeDirtyDirSummary(first, "src", "b.ts");

    expect(merged.dirtyEntryCount).toBe(1);
    expect(merged.affectedNames).toEqual(["b.ts"]);
    expect(merged.hashState).toBe("stale");
    expect(merged.currentTreeHash).toBeNull();
  });

  test("incrementDirtyDirDescendantCount() 保留直接脏项并累加后代计数", () => {
    const base = createDirtyDirSummary("src", ["b.ts", "a.ts"]);
    const summary = incrementDirtyDirDescendantCount(base, "src", 3);

    expect(summary.dirtyEntryCount).toBe(2);
    expect(summary.dirtyDescendantCount).toBe(3);
    expect(summary.affectedNames).toEqual(["a.ts", "b.ts"]);
    expect(summary.hashState).toBe("stale");
  });

  test("materializeDirtyDirSummary() 标记已物化 tree hash", () => {
    const treeHash = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
    const summary = materializeDirtyDirSummary(
      createDirtyDirSummary("src", ["a.ts"]),
      "src",
      treeHash,
    );

    expect(summary.currentTreeHash).toBe(treeHash);
    expect(summary.hashState).toBe("materialized");
    expect(summary.affectedNames).toEqual(["a.ts"]);
  });
});
