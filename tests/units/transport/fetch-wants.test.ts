/**
 * planRefUpdates 单元测试（完整规划模型）
 *
 * 覆盖 ref 映射逻辑：初始 clone、增量 fetch、冲突检测。
 * wants 推导和对象完整性补正测试移至 fetch-plan.test.ts。
 */

import { describe, test, expect } from "bun:test";

import { sha1, type SHA1, type GitCommit } from "@/core/types.ts";
import { createMemoryObjectStore } from "@/odb/memory.ts";
import { planRefUpdates, RefPlanError } from "@/transport/fetch-ref-plan.ts";

import type { RemoteRef } from "@/transport/types.ts";

// ============================================================================
// 辅助函数
// ============================================================================

function makeRef(name: string, hash?: string): RemoteRef {
  return { name, hash: sha1(hash ?? "95d09f2b10159347eece71399a7e2e907ea3df4f") };
}

// ============================================================================
// 完整规划
// ============================================================================

describe("planRefUpdates()", () => {
  const hash1 = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
  const hash2 = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const defaultRules = [{ source: "refs/heads/*", target: "refs/remotes/origin/*", force: true }];

  test("初始 clone：所有分支都应 update，currentLocalHash 为 undefined", () => {
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
      makeRef("refs/heads/develop", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ];
    const store = createMemoryObjectStore();
    const plan = planRefUpdates(refs, new Map(), store, defaultRules);
    expect(plan.refUpdates).toHaveLength(2);
    expect(plan.refUpdates[0]!.localRef).toBe("refs/remotes/origin/main");
    expect(plan.refUpdates[0]!.currentLocalHash).toBeUndefined();
    expect(plan.refUpdates[0]!.force).toBe(true);
    expect(plan.refUpdates[1]!.localRef).toBe("refs/remotes/origin/develop");
    expect(plan.refUpdates[1]!.currentLocalHash).toBeUndefined();
    expect(plan.refUpdates[1]!.force).toBe(true);
  });

  test("本地 hash 相同且对象存在则跳过", () => {
    const store = createMemoryObjectStore();
    // 先写入一个 commit 对象，拿到真实 hash
    const commit: GitCommit = {
      type: "commit",
      tree: sha1("0000000000000000000000000000000000000001"),
      parents: [],
      author: { name: "T", email: "t@t", timestamp: 1000, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 1000, timezone: "+0000" },
      message: "test",
    };
    const localHash = store.write(commit);

    const refs: RemoteRef[] = [
      { name: "refs/heads/main", hash: localHash },
      makeRef("refs/heads/develop", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ];
    const localRefs = new Map<string, SHA1>([["refs/remotes/origin/main", localHash]]);
    const plan = planRefUpdates(refs, localRefs, store, defaultRules);
    // main（hash 相同且对象存在 → 进入 matchedItems，不进入 refUpdates）
    // develop（hash 不同 → 进入 refUpdates）
    expect(plan.refUpdates).toHaveLength(1);
    const mainUpdate = plan.refUpdates.find((u) => u.localRef === "refs/remotes/origin/main");
    expect(mainUpdate).toBeUndefined(); // no-op 不进入 refUpdates
    const mainMatched = plan.matchedItems.find((u) => u.localRef === "refs/remotes/origin/main");
    expect(mainMatched).toBeDefined();
    expect(mainMatched!.hashEqual).toBe(true);
    const devUpdate = plan.refUpdates.find((u) => u.localRef === "refs/remotes/origin/develop");
    expect(devUpdate).toBeDefined();
    expect(devUpdate!.currentLocalHash).toBeUndefined();
    expect(devUpdate!.force).toBe(true);
    // wants 只包含 develop（hash 不同）
    expect(plan.wants).toHaveLength(1);
  });

  test("本地 hash 不同则应拉取并包含 currentLocalHash", () => {
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
    ];
    const store = createMemoryObjectStore();
    const localRefs = new Map<string, SHA1>([["refs/remotes/origin/main", hash2]]);
    const plan = planRefUpdates(refs, localRefs, store, defaultRules);
    expect(plan.refUpdates).toHaveLength(1);
    expect(plan.refUpdates[0]!.currentLocalHash).toBe(hash2);
    expect(plan.refUpdates[0]!.force).toBe(true);
  });

  test("非强制 refspec 传递 force=false", () => {
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
    ];
    const store = createMemoryObjectStore();
    const plan = planRefUpdates(refs, new Map(), store, [
      { source: "refs/heads/*", target: "refs/remotes/origin/*" },
    ]);
    expect(plan.refUpdates).toHaveLength(1);
    expect(plan.refUpdates[0]!.force).toBe(false);
  });

  test("空远程返回空 refUpdates", () => {
    const store = createMemoryObjectStore();
    const plan = planRefUpdates([], new Map(), store, defaultRules);
    expect(plan.refUpdates).toHaveLength(0);
  });

  test("精确 refspec 不会因前缀匹配引入多余 updates", () => {
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
      makeRef("refs/heads/main-old", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ];
    const store = createMemoryObjectStore();
    const plan = planRefUpdates(refs, new Map(), store, [
      { source: "refs/heads/main", target: "refs/remotes/origin/main", force: true },
    ]);
    expect(plan.refUpdates).toHaveLength(1);
    expect(plan.refUpdates[0]!.remoteRef.name).toBe("refs/heads/main");
    expect(plan.refUpdates[0]!.localRef).toBe("refs/remotes/origin/main");
  });

  test("重叠 refspec 映射到同一 localRef 应抛 RefPlanError", () => {
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
      makeRef("refs/heads/develop", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ];
    const store = createMemoryObjectStore();
    expect(() =>
      planRefUpdates(refs, new Map(), store, [
        { source: "refs/heads/*", target: "refs/remotes/origin/*", force: true },
        { source: "refs/heads/main", target: "refs/remotes/origin/main", force: true },
      ]),
    ).toThrow(RefPlanError);
  });

  test("matchedRefs 应包含所有匹配的远端 ref", () => {
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
      makeRef("refs/heads/develop", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ];
    const store = createMemoryObjectStore();
    const localRefs = new Map<string, SHA1>([["refs/remotes/origin/main", hash1]]);
    const plan = planRefUpdates(refs, localRefs, store, defaultRules);
    expect(plan.matchedRefs).toHaveLength(2);
  });

  test("FetchPlan 包含 wants 字段", () => {
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
    ];
    const store = createMemoryObjectStore();
    const plan = planRefUpdates(refs, new Map(), store, defaultRules);
    // FetchPlan 直接包含 wants
    expect("wants" in plan).toBe(true);
    expect(plan.needsPackNegotiation).toBe(true);
  });
});
