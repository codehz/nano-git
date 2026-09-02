/**
 * merge/three-way.ts 单元测试
 */

import { describe, test, expect } from "bun:test";

import { bytes } from "../../helpers/bytes.ts";
import { MergeError } from "@/errors.ts";
import { planTreeMerge } from "@/merge/three-way.ts";
import { writeObject } from "@/objects/raw.ts";
import { createMemoryObjectStore } from "@/odb/memory.ts";

import type { SHA1 } from "@/types/index.ts";

function writeBlob(store: ReturnType<typeof createMemoryObjectStore>, text: string): SHA1 {
  return writeObject(store, { type: "blob", content: bytes(text) });
}

function writeTree(
  store: ReturnType<typeof createMemoryObjectStore>,
  entries: { mode: string; name: string; hash: SHA1 }[],
): SHA1 {
  return writeObject(store, { type: "tree", entries });
}

describe("planTreeMerge() 状态短路", () => {
  test("ours === theirs → already-up-to-date", () => {
    const store = createMemoryObjectStore();
    const blob = writeBlob(store, "a");
    const tree = writeTree(store, [{ mode: "100644", name: "f.txt", hash: blob }]);
    const base = writeTree(store, []);

    const plan = planTreeMerge(store, {
      baseTree: base,
      oursTree: tree,
      theirsTree: tree,
    });
    expect(plan.status).toBe("already-up-to-date");
    expect(plan.resultTree).toBe(tree);
    expect(plan.conflicts).toEqual([]);
  });

  test("base === theirs → already-up-to-date（仅我们改了）", () => {
    const store = createMemoryObjectStore();
    const baseBlob = writeBlob(store, "base");
    const oursBlob = writeBlob(store, "ours");
    const base = writeTree(store, [{ mode: "100644", name: "f.txt", hash: baseBlob }]);
    const ours = writeTree(store, [{ mode: "100644", name: "f.txt", hash: oursBlob }]);

    const plan = planTreeMerge(store, {
      baseTree: base,
      oursTree: ours,
      theirsTree: base,
    });
    expect(plan.status).toBe("already-up-to-date");
    expect(plan.resultTree).toBe(ours);
  });

  test("base === ours → fast-forward", () => {
    const store = createMemoryObjectStore();
    const baseBlob = writeBlob(store, "base");
    const theirsBlob = writeBlob(store, "theirs");
    const base = writeTree(store, [{ mode: "100644", name: "f.txt", hash: baseBlob }]);
    const theirs = writeTree(store, [{ mode: "100644", name: "f.txt", hash: theirsBlob }]);

    const plan = planTreeMerge(store, {
      baseTree: base,
      oursTree: base,
      theirsTree: theirs,
    });
    expect(plan.status).toBe("fast-forward");
    expect(plan.resultTree).toBe(theirs);
  });
});

describe("planTreeMerge() 自动合并", () => {
  test("两侧改不同文件 → clean", () => {
    const store = createMemoryObjectStore();
    const a0 = writeBlob(store, "a0");
    const b0 = writeBlob(store, "b0");
    const a1 = writeBlob(store, "a1");
    const b1 = writeBlob(store, "b1");

    const base = writeTree(store, [
      { mode: "100644", name: "a.txt", hash: a0 },
      { mode: "100644", name: "b.txt", hash: b0 },
    ]);
    const ours = writeTree(store, [
      { mode: "100644", name: "a.txt", hash: a1 },
      { mode: "100644", name: "b.txt", hash: b0 },
    ]);
    const theirs = writeTree(store, [
      { mode: "100644", name: "a.txt", hash: a0 },
      { mode: "100644", name: "b.txt", hash: b1 },
    ]);

    const plan = planTreeMerge(store, {
      baseTree: base,
      oursTree: ours,
      theirsTree: theirs,
    });
    expect(plan.status).toBe("clean");
    expect(plan.conflicts).toEqual([]);
    expect(plan.resultTree).toBeNull();

    const byPath = new Map(plan.autoEntries.map((e) => [e.path, e]));
    expect(byPath.get("a.txt")?.hash).toBe(a1);
    expect(byPath.get("b.txt")?.hash).toBe(b1);
  });

  test("仅一侧新增文件", () => {
    const store = createMemoryObjectStore();
    const baseBlob = writeBlob(store, "keep");
    const newBlob = writeBlob(store, "new");
    const base = writeTree(store, [{ mode: "100644", name: "keep.txt", hash: baseBlob }]);
    const ours = base;
    const theirs = writeTree(store, [
      { mode: "100644", name: "keep.txt", hash: baseBlob },
      { mode: "100644", name: "new.txt", hash: newBlob },
    ]);

    // base === ours → FF 短路
    const plan = planTreeMerge(store, {
      baseTree: base,
      oursTree: ours,
      theirsTree: theirs,
    });
    expect(plan.status).toBe("fast-forward");
    expect(plan.resultTree).toBe(theirs);
  });

  test("一侧删除未改文件 → 删除生效", () => {
    const store = createMemoryObjectStore();
    const a = writeBlob(store, "a");
    const b = writeBlob(store, "b");
    const base = writeTree(store, [
      { mode: "100644", name: "a.txt", hash: a },
      { mode: "100644", name: "b.txt", hash: b },
    ]);
    // ours 删除 b.txt
    const ours = writeTree(store, [{ mode: "100644", name: "a.txt", hash: a }]);
    // theirs 未改
    const theirs = base;

    const plan = planTreeMerge(store, {
      baseTree: base,
      oursTree: ours,
      theirsTree: theirs,
    });
    // base === theirs → already-up-to-date with ours
    expect(plan.status).toBe("already-up-to-date");
    expect(plan.resultTree).toBe(ours);
  });

  test("两侧删除同一文件 → clean 无该路径", () => {
    const store = createMemoryObjectStore();
    const a = writeBlob(store, "a");
    const b = writeBlob(store, "b");
    const base = writeTree(store, [
      { mode: "100644", name: "a.txt", hash: a },
      { mode: "100644", name: "b.txt", hash: b },
    ]);
    const ours = writeTree(store, [{ mode: "100644", name: "a.txt", hash: a }]);
    const theirs = writeTree(store, [{ mode: "100644", name: "a.txt", hash: a }]);

    // ours === theirs → up-to-date
    const plan = planTreeMerge(store, {
      baseTree: base,
      oursTree: ours,
      theirsTree: theirs,
    });
    expect(plan.status).toBe("already-up-to-date");
  });

  test("一侧只改 mode → 取改后 mode", () => {
    const store = createMemoryObjectStore();
    const blob = writeBlob(store, "script");
    const base = writeTree(store, [{ mode: "100644", name: "run.sh", hash: blob }]);
    const ours = writeTree(store, [{ mode: "100755", name: "run.sh", hash: blob }]);
    const theirs = base;

    const plan = planTreeMerge(store, {
      baseTree: base,
      oursTree: ours,
      theirsTree: theirs,
    });
    expect(plan.status).toBe("already-up-to-date");
    expect(plan.resultTree).toBe(ours);
  });

  test("嵌套目录：两侧改不同子路径 → clean 且子树可压缩", () => {
    const store = createMemoryObjectStore();
    const x0 = writeBlob(store, "x0");
    const y0 = writeBlob(store, "y0");
    const x1 = writeBlob(store, "x1");
    const y1 = writeBlob(store, "y1");

    const baseSub = writeTree(store, [
      { mode: "100644", name: "x.txt", hash: x0 },
      { mode: "100644", name: "y.txt", hash: y0 },
    ]);
    const oursSub = writeTree(store, [
      { mode: "100644", name: "x.txt", hash: x1 },
      { mode: "100644", name: "y.txt", hash: y0 },
    ]);
    const theirsSub = writeTree(store, [
      { mode: "100644", name: "x.txt", hash: x0 },
      { mode: "100644", name: "y.txt", hash: y1 },
    ]);

    const base = writeTree(store, [{ mode: "040000", name: "dir", hash: baseSub }]);
    const ours = writeTree(store, [{ mode: "040000", name: "dir", hash: oursSub }]);
    const theirs = writeTree(store, [{ mode: "040000", name: "dir", hash: theirsSub }]);

    const plan = planTreeMerge(store, {
      baseTree: base,
      oursTree: ours,
      theirsTree: theirs,
    });
    expect(plan.status).toBe("clean");
    expect(plan.conflicts).toEqual([]);

    const byPath = new Map(plan.autoEntries.map((e) => [e.path, e]));
    expect(byPath.get("dir/x.txt")?.hash).toBe(x1);
    expect(byPath.get("dir/y.txt")?.hash).toBe(y1);
  });

  test("子树 hash 短路：整目录仅一侧修改", () => {
    const store = createMemoryObjectStore();
    const file = writeBlob(store, "f");
    const other = writeBlob(store, "o");
    const baseSub = writeTree(store, [{ mode: "100644", name: "f.txt", hash: file }]);
    const theirsSub = writeTree(store, [{ mode: "100644", name: "f.txt", hash: other }]);
    const keep = writeBlob(store, "keep");

    const base = writeTree(store, [
      { mode: "040000", name: "dir", hash: baseSub },
      { mode: "100644", name: "keep.txt", hash: keep },
    ]);
    const ours = base;
    const theirs = writeTree(store, [
      { mode: "040000", name: "dir", hash: theirsSub },
      { mode: "100644", name: "keep.txt", hash: keep },
    ]);

    const plan = planTreeMerge(store, {
      baseTree: base,
      oursTree: ours,
      theirsTree: theirs,
    });
    expect(plan.status).toBe("fast-forward");
    expect(plan.resultTree).toBe(theirs);
  });
});

describe("planTreeMerge() 冲突", () => {
  test("both-modified：两侧改同一文件", () => {
    const store = createMemoryObjectStore();
    const baseBlob = writeBlob(store, "base");
    const oursBlob = writeBlob(store, "ours");
    const theirsBlob = writeBlob(store, "theirs");
    const base = writeTree(store, [{ mode: "100644", name: "f.txt", hash: baseBlob }]);
    const ours = writeTree(store, [{ mode: "100644", name: "f.txt", hash: oursBlob }]);
    const theirs = writeTree(store, [{ mode: "100644", name: "f.txt", hash: theirsBlob }]);

    const plan = planTreeMerge(store, {
      baseTree: base,
      oursTree: ours,
      theirsTree: theirs,
    });
    expect(plan.status).toBe("conflicted");
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]!.path).toBe("f.txt");
    expect(plan.conflicts[0]!.reason).toBe("both-modified");
  });

  test("add-add：两侧新增同路径不同内容", () => {
    const store = createMemoryObjectStore();
    const base = writeTree(store, []);
    const oursBlob = writeBlob(store, "ours");
    const theirsBlob = writeBlob(store, "theirs");
    const ours = writeTree(store, [{ mode: "100644", name: "new.txt", hash: oursBlob }]);
    const theirs = writeTree(store, [{ mode: "100644", name: "new.txt", hash: theirsBlob }]);

    const plan = planTreeMerge(store, {
      baseTree: base,
      oursTree: ours,
      theirsTree: theirs,
    });
    expect(plan.status).toBe("conflicted");
    expect(plan.conflicts[0]!.reason).toBe("add-add");
    expect(plan.conflicts[0]!.path).toBe("new.txt");
    expect(plan.conflicts[0]!.base).toBeNull();
  });

  test("modify-delete：一侧改一侧删", () => {
    const store = createMemoryObjectStore();
    const baseBlob = writeBlob(store, "base");
    const oursBlob = writeBlob(store, "ours");
    const base = writeTree(store, [{ mode: "100644", name: "f.txt", hash: baseBlob }]);
    const ours = writeTree(store, [{ mode: "100644", name: "f.txt", hash: oursBlob }]);
    const theirs = writeTree(store, []);

    const plan = planTreeMerge(store, {
      baseTree: base,
      oursTree: ours,
      theirsTree: theirs,
    });
    expect(plan.status).toBe("conflicted");
    expect(plan.conflicts[0]!.reason).toBe("modify-delete");
    expect(plan.conflicts[0]!.theirs).toBeNull();
    expect(plan.conflicts[0]!.ours?.hash).toBe(oursBlob);
  });

  test("type-change：文件 vs 目录", () => {
    const store = createMemoryObjectStore();
    const fileBlob = writeBlob(store, "file");
    const inner = writeBlob(store, "inner");
    const sub = writeTree(store, [{ mode: "100644", name: "inner.txt", hash: inner }]);
    const base = writeTree(store, [{ mode: "100644", name: "x", hash: fileBlob }]);
    const theirs = writeTree(store, [{ mode: "040000", name: "x", hash: sub }]);

    // 构造：ours 改内容，theirs 改成目录（避免 base===ours 触发 FF 短路）
    const oursBlob = writeBlob(store, "ours-file");
    const ours = writeTree(store, [{ mode: "100644", name: "x", hash: oursBlob }]);
    const plan = planTreeMerge(store, {
      baseTree: base,
      oursTree: ours,
      theirsTree: theirs,
    });
    expect(plan.status).toBe("conflicted");
    expect(plan.conflicts[0]!.reason).toBe("type-change");
    expect(plan.conflicts[0]!.path).toBe("x");
  });

  test("mode-conflict：同内容不同 mode 两侧都改", () => {
    const store = createMemoryObjectStore();
    const blob = writeBlob(store, "same");
    // add-add 同 hash 不同 mode
    const empty = writeTree(store, []);
    const oursAdd = writeTree(store, [{ mode: "100644", name: "f", hash: blob }]);
    const theirsAdd = writeTree(store, [{ mode: "100755", name: "f", hash: blob }]);
    const plan = planTreeMerge(store, {
      baseTree: empty,
      oursTree: oursAdd,
      theirsTree: theirsAdd,
    });
    expect(plan.status).toBe("conflicted");
    expect(plan.conflicts[0]!.reason).toBe("mode-conflict");
  });

  test("目录删除 vs 内部修改 → 展开为路径级 modify-delete", () => {
    const store = createMemoryObjectStore();
    const a0 = writeBlob(store, "a0");
    const a1 = writeBlob(store, "a1");
    const b0 = writeBlob(store, "b0");

    const baseSub = writeTree(store, [
      { mode: "100644", name: "a.txt", hash: a0 },
      { mode: "100644", name: "b.txt", hash: b0 },
    ]);
    // theirs 修改 a.txt
    const theirsSub = writeTree(store, [
      { mode: "100644", name: "a.txt", hash: a1 },
      { mode: "100644", name: "b.txt", hash: b0 },
    ]);
    const base = writeTree(store, [{ mode: "040000", name: "dir", hash: baseSub }]);
    // ours 删除整个 dir
    const ours = writeTree(store, []);
    const theirs = writeTree(store, [{ mode: "040000", name: "dir", hash: theirsSub }]);

    const plan = planTreeMerge(store, {
      baseTree: base,
      oursTree: ours,
      theirsTree: theirs,
    });
    expect(plan.status).toBe("conflicted");
    // a.txt 被修改 → modify-delete；b.txt 未改 → 删除，无冲突
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]!.path).toBe("dir/a.txt");
    expect(plan.conflicts[0]!.reason).toBe("modify-delete");
  });

  test("不支持的 mode 抛 MergeError", () => {
    const store = createMemoryObjectStore();
    const blob = writeBlob(store, "sub");
    const file = writeBlob(store, "file");
    // 直接写入 160000 gitlink；两侧同路径不同内容以避开根级短路
    const oursTree = writeObject(store, {
      type: "tree",
      entries: [{ mode: "160000", name: "sub", hash: blob }],
    });
    const theirsTree = writeTree(store, [{ mode: "100644", name: "sub", hash: file }]);
    const empty = writeTree(store, []);

    expect(() =>
      planTreeMerge(store, {
        baseTree: empty,
        oursTree,
        theirsTree,
      }),
    ).toThrow(MergeError);
  });
});
