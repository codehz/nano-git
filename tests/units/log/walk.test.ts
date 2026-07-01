/**
 * 提交日志遍历单元测试
 */

import { describe, test, expect } from "bun:test";

import { walkLogEntries } from "@/log/walk.ts";
import { writeObject } from "@/objects/raw.ts";
import { createMemoryObjectStore } from "@/odb/memory.ts";

import type { ObjectDatabase } from "@/odb/types.ts";
import type { GitAuthor, GitCommit, SHA1 } from "@/types/index.ts";

// ============================================================================
// 测试辅助
// ============================================================================

const defaultAuthor: GitAuthor = {
  name: "Test",
  email: "test@test",
  timestamp: 1000,
  timezone: "+0000",
};

function makeAuthor(timestamp: number): GitAuthor {
  return { ...defaultAuthor, timestamp };
}

function createCommit(
  objects: ObjectDatabase,
  tree: SHA1,
  parents: SHA1[],
  message: string,
  timestamp: number,
): SHA1 {
  return writeObject(objects, {
    type: "commit",
    tree,
    parents,
    author: makeAuthor(timestamp),
    committer: makeAuthor(timestamp),
    message,
  } as GitCommit);
}

// 树哈希辅助：总是创建空树（减少干扰）
function emptyTree(objects: ObjectDatabase): SHA1 {
  return writeObject(objects, { type: "tree", entries: [] });
}

function collectResults(
  gen: Generator<import("@/log/types.ts").LogEntry, void, undefined>,
): { hash: SHA1; message: string }[] {
  return Array.from(gen).map((e) => ({ hash: e.hash, message: e.commit.message }));
}

// ============================================================================
// 测试
// ============================================================================

describe("walkLogEntries", () => {
  test("空起点列表返回空结果", () => {
    const objects = createMemoryObjectStore();
    const results = collectResults(walkLogEntries(objects, { from: [] }));
    expect(results).toEqual([]);
  });

  test("无起点选项也返回空结果", () => {
    const objects = createMemoryObjectStore();
    const results = collectResults(walkLogEntries(objects, {}));
    expect(results).toEqual([]);
  });

  test("线性历史按日期降序遍历", () => {
    const objects = createMemoryObjectStore();

    // 构造线性历史：A ← B ← C（时间戳递增）
    const tree = emptyTree(objects);
    const hashA = createCommit(objects, tree, [], "First", 1000);
    const hashB = createCommit(objects, tree, [hashA], "Second", 2000);
    const hashC = createCommit(objects, tree, [hashB], "Third", 3000);

    const results = collectResults(walkLogEntries(objects, { from: [hashC] }));
    expect(results).toHaveLength(3);
    expect(results[0]!.message).toBe("Third");
    expect(results[1]!.message).toBe("Second");
    expect(results[2]!.message).toBe("First");
  });

  test("maxCount 限制输出数量", () => {
    const objects = createMemoryObjectStore();
    const tree = emptyTree(objects);
    const hashA = createCommit(objects, tree, [], "First", 1000);
    const hashB = createCommit(objects, tree, [hashA], "Second", 2000);
    const hashC = createCommit(objects, tree, [hashB], "Third", 3000);

    const results = collectResults(walkLogEntries(objects, { from: [hashC], maxCount: 2 }));
    expect(results).toHaveLength(2);
    expect(results[0]!.message).toBe("Third");
    expect(results[1]!.message).toBe("Second");
  });

  test("skip 跳过开头 N 条提交", () => {
    const objects = createMemoryObjectStore();
    const tree = emptyTree(objects);
    const hashA = createCommit(objects, tree, [], "First", 1000);
    const hashB = createCommit(objects, tree, [hashA], "Second", 2000);
    const hashC = createCommit(objects, tree, [hashB], "Third", 3000);
    const hashD = createCommit(objects, tree, [hashC], "Fourth", 4000);

    const results = collectResults(
      walkLogEntries(objects, { from: [hashD], skip: 2, maxCount: 10 }),
    );
    expect(results).toHaveLength(2);
    expect(results[0]!.message).toBe("Second");
    expect(results[1]!.message).toBe("First");
  });

  test("exclude 排除指定提交及其祖先", () => {
    const objects = createMemoryObjectStore();
    const tree = emptyTree(objects);

    // 构造：A ← B ← C ← D
    const hashA = createCommit(objects, tree, [], "A", 1000);
    const hashB = createCommit(objects, tree, [hashA], "B", 2000);
    const hashC = createCommit(objects, tree, [hashB], "C", 3000);
    const hashD = createCommit(objects, tree, [hashC], "D", 4000);

    // 等价于 git log D ^B 或 B..D
    const results = collectResults(walkLogEntries(objects, { from: [hashD], exclude: [hashB] }));
    expect(results).toHaveLength(2);
    expect(results[0]!.message).toBe("D");
    expect(results[1]!.message).toBe("C");
  });

  test("exclude 起点本身不出现在结果中", () => {
    const objects = createMemoryObjectStore();
    const tree = emptyTree(objects);
    const hashA = createCommit(objects, tree, [], "A", 1000);
    const hashB = createCommit(objects, tree, [hashA], "B", 2000);

    // from 和 exclude 包含同一个提交
    const results = collectResults(walkLogEntries(objects, { from: [hashB], exclude: [hashB] }));
    expect(results).toEqual([]);
  });

  test("since 过滤时间戳之前的提交", () => {
    const objects = createMemoryObjectStore();
    const tree = emptyTree(objects);
    const hashA = createCommit(objects, tree, [], "A", 1000);
    const hashB = createCommit(objects, tree, [hashA], "B", 2000);
    const hashC = createCommit(objects, tree, [hashB], "C", 3000);

    // since=2000：只包含 timestamp >= 2000 的提交
    const results = collectResults(walkLogEntries(objects, { from: [hashC], since: 2000 }));
    expect(results).toHaveLength(2);
    expect(results[0]!.message).toBe("C");
    expect(results[1]!.message).toBe("B");
  });

  test("until 过滤时间戳之后的提交", () => {
    const objects = createMemoryObjectStore();
    const tree = emptyTree(objects);
    const hashA = createCommit(objects, tree, [], "A", 1000);
    const hashB = createCommit(objects, tree, [hashA], "B", 2000);
    const hashC = createCommit(objects, tree, [hashB], "C", 3000);

    // until=2000：只包含 timestamp <= 2000 的提交
    const results = collectResults(walkLogEntries(objects, { from: [hashC], until: 2000 }));
    expect(results).toHaveLength(2);
    expect(results[0]!.message).toBe("B");
    expect(results[1]!.message).toBe("A");
  });

  test("merge 提交的两个 parent 都会被遍历", () => {
    const objects = createMemoryObjectStore();
    const tree = emptyTree(objects);

    // 构造：A ← B ← D
    //        ↙
    //       C
    const hashA = createCommit(objects, tree, [], "A", 1000);
    const hashB = createCommit(objects, tree, [hashA], "B", 2000);
    const hashC = createCommit(objects, tree, [hashA], "C", 1000);
    const hashD = createCommit(objects, tree, [hashB, hashC], "D", 3000);

    const results = collectResults(walkLogEntries(objects, { from: [hashD] }));
    expect(results).toHaveLength(4);
    expect(results[0]!.message).toBe("D");
    // B 和 C 的时间戳相同（B=2000, C=1000），所以 B 先于 C
    expect(results[1]!.message).toBe("B");
    expect(results[2]!.message).toBe("C");
    expect(results[3]!.message).toBe("A");
  });

  test("firstParent 仅沿第一条父链行走", () => {
    const objects = createMemoryObjectStore();
    const tree = emptyTree(objects);

    // 构造：A ← B ← D
    //        ↙
    //       C
    const hashA = createCommit(objects, tree, [], "A", 1000);
    const hashB = createCommit(objects, tree, [hashA], "B", 2000);
    const hashC = createCommit(objects, tree, [hashA], "C", 1000);
    const hashD = createCommit(objects, tree, [hashB, hashC], "D", 3000);

    // firstParent 只走 D → B → A，跳过 C
    const results = collectResults(walkLogEntries(objects, { from: [hashD], firstParent: true }));
    expect(results).toHaveLength(3);
    expect(results[0]!.message).toBe("D");
    expect(results[1]!.message).toBe("B");
    expect(results[2]!.message).toBe("A");
  });

  test("非 commit 对象被静默跳过", () => {
    const objects = createMemoryObjectStore();
    const tree = emptyTree(objects);
    const commitHash = createCommit(objects, tree, [], "Only commit", 1000);
    const blobHash = writeObject(objects, { type: "blob", content: Buffer.from("data") });

    // from 中包含 blob 哈希，应被自动跳过
    const results = collectResults(walkLogEntries(objects, { from: [commitHash, blobHash] }));
    expect(results).toHaveLength(1);
    expect(results[0]!.message).toBe("Only commit");
  });

  test("多个起点合并去重", () => {
    const objects = createMemoryObjectStore();
    const tree = emptyTree(objects);

    const hashA = createCommit(objects, tree, [], "A", 1000);
    const hashB = createCommit(objects, tree, [hashA], "B", 2000);

    // 同一个起点出现两次
    const results = collectResults(walkLogEntries(objects, { from: [hashB, hashB] }));
    expect(results).toHaveLength(2);
    expect(results[0]!.message).toBe("B");
    expect(results[1]!.message).toBe("A");
  });

  test("不存在的哈希被静默跳过", () => {
    const objects = createMemoryObjectStore();

    const results = collectResults(
      walkLogEntries(objects, {
        from: ["0000000000000000000000000000000000000000" as SHA1],
      }),
    );
    expect(results).toEqual([]);
  });
});

// ============================================================================
// 拓扑排序测试
// ============================================================================

describe("walkLogEntries (topo order)", () => {
  test("线性历史结果与 date 排序一致", () => {
    const objects = createMemoryObjectStore();
    const tree = emptyTree(objects);

    const hashA = createCommit(objects, tree, [], "A", 1000);
    const hashB = createCommit(objects, tree, [hashA], "B", 2000);
    const hashC = createCommit(objects, tree, [hashB], "C", 3000);

    const results = collectResults(walkLogEntries(objects, { from: [hashC], order: "topo" }));
    expect(results).toHaveLength(3);
    expect(results[0]!.message).toBe("C");
    expect(results[1]!.message).toBe("B");
    expect(results[2]!.message).toBe("A");
  });

  test("拓扑序保证 parent 在 child 之后输出", () => {
    const objects = createMemoryObjectStore();
    const tree = emptyTree(objects);

    // 复杂合并：两个 branch 合并到 main
    // A(1000) ← B(3000) ← D(5000)
    //               ↙
    //          C(2000)
    // 时间顺序：D(5000) > B(3000) > C(2000) > A(1000)
    // 拓扑约束：D 必须出现在 B 和 C 之前，B 在 A 之前，C 在 A 之前
    const hashA = createCommit(objects, tree, [], "A", 1000);
    const hashB = createCommit(objects, tree, [hashA], "B", 3000);
    const hashC = createCommit(objects, tree, [hashA], "C", 2000);
    const hashD = createCommit(objects, tree, [hashB, hashC], "D", 5000);

    const results = collectResults(walkLogEntries(objects, { from: [hashD], order: "topo" }));

    expect(results).toHaveLength(4);

    // D 必须在 B 和 C 之前
    expect(results[0]!.message).toBe("D");
    // B 必须在 A 之前，C 必须在 A 之前
    const idxA = results.findIndex((r) => r.message === "A");
    const idxB = results.findIndex((r) => r.message === "B");
    const idxC = results.findIndex((r) => r.message === "C");
    expect(idxB).toBeLessThan(idxA);
    expect(idxC).toBeLessThan(idxA);
    // B 和 C 属于同一层，按时间戳降序
    expect(idxB).toBeLessThan(idxC); // B(3000) > C(2000)
  });

  test("拓扑序中 firstParent 限制 parent 范围", () => {
    const objects = createMemoryObjectStore();
    const tree = emptyTree(objects);

    const hashA = createCommit(objects, tree, [], "A", 1000);
    const hashB = createCommit(objects, tree, [hashA], "B", 2000);
    const hashC = createCommit(objects, tree, [hashA], "C", 1000);
    const hashD = createCommit(objects, tree, [hashB, hashC], "D", 3000);

    const results = collectResults(
      walkLogEntries(objects, { from: [hashD], order: "topo", firstParent: true }),
    );

    expect(results).toHaveLength(3);
    expect(results[0]!.message).toBe("D");
    expect(results[1]!.message).toBe("B");
    expect(results[2]!.message).toBe("A");
  });

  test("拓扑序配合 maxCount / skip / since / until", () => {
    const objects = createMemoryObjectStore();
    const tree = emptyTree(objects);

    const hashA = createCommit(objects, tree, [], "A", 1000);
    const hashB = createCommit(objects, tree, [hashA], "B", 2000);
    const hashC = createCommit(objects, tree, [hashB], "C", 3000);

    // maxCount
    expect(
      collectResults(walkLogEntries(objects, { from: [hashC], order: "topo", maxCount: 2 })),
    ).toHaveLength(2);

    // skip
    const skipResult = collectResults(
      walkLogEntries(objects, { from: [hashC], order: "topo", skip: 1 }),
    );
    expect(skipResult).toHaveLength(2);
    expect(skipResult[0]!.message).toBe("B");

    // since
    expect(
      collectResults(walkLogEntries(objects, { from: [hashC], order: "topo", since: 2000 })),
    ).toHaveLength(2);

    // until
    expect(
      collectResults(walkLogEntries(objects, { from: [hashC], order: "topo", until: 2000 })),
    ).toHaveLength(2);
  });
});
