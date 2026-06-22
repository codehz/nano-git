/**
 * planRefUpdates wants 推导单元测试
 *
 * 覆盖对象完整性补正逻辑：hash 相同但对象缺失时的 wants 补拉、
 * hash 不同时的正常 wants、shallow deepen 模式。
 *
 * 注意：resolveFetchWants 已不再存在，所有逻辑已合并到 planRefUpdates。
 */

import { describe, test, expect } from "bun:test";

import { sha1, type SHA1, type GitBlob, type GitCommit } from "@/core/types.ts";
import { createMemoryObjectStore } from "@/odb/memory-store.ts";
import { planRefUpdates } from "@/transport/fetch-ref-plan.ts";

import type { RemoteRef } from "@/transport/types.ts";

// ============================================================================
// 辅助函数
// ============================================================================

function makeRef(name: string, hash?: string): RemoteRef {
  return { name, hash: sha1(hash ?? "95d09f2b10159347eece71399a7e2e907ea3df4f") };
}

const TREE_PLACEHOLDER = sha1("0000000000000000000000000000000000000001");

/** 创建一个提交对象并写入 store */
function createTestCommit(
  store: ReturnType<typeof createMemoryObjectStore>,
  parents: SHA1[],
  timestamp: number,
  msg?: string,
): SHA1 {
  const commit: GitCommit = {
    type: "commit",
    tree: TREE_PLACEHOLDER,
    parents,
    author: { name: "T", email: "t@t", timestamp, timezone: "+0000" },
    committer: { name: "T", email: "t@t", timestamp, timezone: "+0000" },
    message: msg ?? `commit at ${timestamp}`,
  };
  return store.write(commit);
}

const defaultRules = [{ source: "refs/heads/*", target: "refs/remotes/origin/*", force: true }];

// ============================================================================
// planRefUpdates wants 基本场景
// ============================================================================

describe("planRefUpdates() wants 推导", () => {
  test("hash 不同时产生 wants", () => {
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
    ];
    const store = createMemoryObjectStore();
    const plan = planRefUpdates(refs, new Map(), store, defaultRules);

    expect(plan.wants).toHaveLength(1);
    expect(plan.wants[0]).toBe(sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"));
    expect(plan.needsPackNegotiation).toBe(true);
  });

  test("hash 相同且对象存在时不产生 wants", () => {
    const store = createMemoryObjectStore();
    const realHash = createTestCommit(store, [], 100);
    const refs: RemoteRef[] = [makeRef("refs/heads/main", realHash)];
    const localRefs = new Map<string, SHA1>([["refs/remotes/origin/main", realHash]]);
    const plan = planRefUpdates(refs, localRefs, store, defaultRules);
    // hash 相同且对象存在 → refUpdate 仍在（hashEqual=true），但 wants 为空
    expect(plan.refUpdates).toHaveLength(1);
    expect(plan.refUpdates[0]!.hashEqual).toBe(true);
    expect(plan.wants).toHaveLength(0);
    expect(plan.needsPackNegotiation).toBe(false);
  });

  test("hash 相同但对象缺失时产生 wants（对象完整性补正）", () => {
    const hash = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
    const refs: RemoteRef[] = [makeRef("refs/heads/main", hash)];
    const localRefs = new Map<string, SHA1>([["refs/remotes/origin/main", hash]]);
    const store = createMemoryObjectStore(); // 空 store，对象缺失

    // planRefUpdates 现在包含对象完整性检查：hash 相同但对象缺失时仍生成 want
    const plan = planRefUpdates(refs, localRefs, store, defaultRules);
    // hash 相同但对象缺失 → 仍应产生 want，且 refUpdates 也保留此项（hashEqual=true）
    expect(plan.refUpdates).toHaveLength(1);
    expect(plan.refUpdates[0]!.hashEqual).toBe(true);
    expect(plan.wants).toHaveLength(1);
    expect(plan.wants[0]).toBe(hash);
    expect(plan.needsPackNegotiation).toBe(true);
  });

  test("hash 不同且对象缺失时产生 wants", () => {
    const hash = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
    const refs: RemoteRef[] = [makeRef("refs/heads/main", hash)];
    const localRefs = new Map<string, SHA1>([
      ["refs/remotes/origin/main", sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
    ]);
    const store = createMemoryObjectStore(); // 空 store，对象不存在
    const plan = planRefUpdates(refs, localRefs, store, defaultRules);
    expect(plan.refUpdates).toHaveLength(1);
    expect(plan.wants).toHaveLength(1);
    expect(plan.needsPackNegotiation).toBe(true);
  });
});

// ============================================================================
// Deepen 模式
// ============================================================================

describe("planRefUpdates() deepen 模式", () => {
  test("wants 为空但 depth 设置时，以 matchedRefs 作为 wants", () => {
    const store = createMemoryObjectStore();
    // 写入一个对象并用它的真实哈希
    const commit: GitCommit = {
      type: "commit",
      tree: sha1("0000000000000000000000000000000000000001"),
      parents: [],
      author: { name: "T", email: "t@t", timestamp: 1000, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 1000, timezone: "+0000" },
      message: "test",
    };
    const hash = store.write(commit);

    const refs: RemoteRef[] = [{ name: "refs/heads/main", hash }];
    const localRefs = new Map<string, SHA1>([["refs/remotes/origin/main", hash]]);

    // 不传 depth：正常模式 → hash 相同且对象存在，wants 为空
    const planNormal = planRefUpdates(refs, localRefs, store, defaultRules);
    expect(planNormal.refUpdates).toHaveLength(1);
    expect(planNormal.refUpdates[0]!.hashEqual).toBe(true);
    expect(planNormal.wants).toHaveLength(0);
    expect(planNormal.needsPackNegotiation).toBe(false);

    // 传 depth：deepen 模式 → 以 matchedRefs 作为 wants
    const planDeepen = planRefUpdates(refs, localRefs, store, defaultRules, 1);
    expect(planDeepen.wants).toHaveLength(1);
    expect(planDeepen.wants[0]).toBe(hash);
    expect(planDeepen.needsPackNegotiation).toBe(true);
  });

  test("wants 非空时 depth 不影响 wants", () => {
    const hash1 = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
    const hash2 = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const refs: RemoteRef[] = [makeRef("refs/heads/main", hash1)];
    const localRefs = new Map<string, SHA1>([["refs/remotes/origin/main", hash2]]);
    const store = createMemoryObjectStore();
    const plan = planRefUpdates(refs, localRefs, store, defaultRules, 1);
    expect(plan.refUpdates).toHaveLength(1);
    // wants 非空，depth 不应额外追加 matchedRefs
    expect(plan.wants).toHaveLength(1);
    expect(plan.wants[0]).toBe(hash1);
  });
});
