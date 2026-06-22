/**
 * planRefUpdates 单元测试（纯映射层）
 *
 * 覆盖 ref 映射逻辑：初始 clone、增量 fetch、refspec 去重。
 * 对象完整性补正测试移至 fetch-plan-finalize.test.ts。
 */

import { describe, test, expect } from "bun:test";

import { sha1, type SHA1 } from "@/core/types.ts";
import { planRefUpdates } from "@/transport/fetch-ref-plan.ts";

import type { RemoteRef } from "@/transport/types.ts";

// ============================================================================
// 辅助函数
// ============================================================================

function makeRef(name: string, hash?: string): RemoteRef {
  return { name, hash: sha1(hash ?? "95d09f2b10159347eece71399a7e2e907ea3df4f") };
}

// ============================================================================
// 纯 ref 映射
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
    const plan = planRefUpdates(refs, new Map(), defaultRules);
    expect(plan.updates).toHaveLength(2);
    expect(plan.updates[0]!.localRef).toBe("refs/remotes/origin/main");
    expect(plan.updates[0]!.currentLocalHash).toBeUndefined();
    expect(plan.updates[0]!.force).toBe(true);
    expect(plan.updates[1]!.localRef).toBe("refs/remotes/origin/develop");
    expect(plan.updates[1]!.currentLocalHash).toBeUndefined();
    expect(plan.updates[1]!.force).toBe(true);
  });

  test("本地 hash 相同则跳过（纯 hash 比较，不涉及对象库）", () => {
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
      makeRef("refs/heads/develop", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ];
    const localRefs = new Map<string, SHA1>([["refs/remotes/origin/main", hash1]]);
    const plan = planRefUpdates(refs, localRefs, defaultRules);
    // main 与本地 hash 相同，只有 develop 需要拉取
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]!.localRef).toBe("refs/remotes/origin/develop");
    expect(plan.updates[0]!.currentLocalHash).toBeUndefined();
    expect(plan.updates[0]!.force).toBe(true);
  });

  test("本地 hash 不同则应拉取并包含 currentLocalHash", () => {
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
    ];
    const localRefs = new Map<string, SHA1>([["refs/remotes/origin/main", hash2]]);
    const plan = planRefUpdates(refs, localRefs, defaultRules);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]!.currentLocalHash).toBe(hash2);
    expect(plan.updates[0]!.force).toBe(true);
  });

  test("非强制 refspec 传递 force=false", () => {
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
    ];
    const plan = planRefUpdates(refs, new Map(), [
      { source: "refs/heads/*", target: "refs/remotes/origin/*" },
    ]);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]!.force).toBe(false);
  });

  test("空远程返回空 updates", () => {
    const plan = planRefUpdates([], new Map(), defaultRules);
    expect(plan.updates).toHaveLength(0);
  });

  test("精确 refspec 不会因前缀匹配引入多余 updates", () => {
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
      makeRef("refs/heads/main-old", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ];
    const plan = planRefUpdates(refs, new Map(), [
      { source: "refs/heads/main", target: "refs/remotes/origin/main", force: true },
    ]);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]!.remoteRef.name).toBe("refs/heads/main");
    expect(plan.updates[0]!.localRef).toBe("refs/remotes/origin/main");
  });

  test("重叠 refspec 应去重，同一 remote ref 只生成一个 update", () => {
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
      makeRef("refs/heads/develop", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ];
    const plan = planRefUpdates(refs, new Map(), [
      { source: "refs/heads/*", target: "refs/remotes/origin/*", force: true },
      { source: "refs/heads/main", target: "refs/remotes/origin/main", force: true },
    ]);
    expect(plan.updates).toHaveLength(2);
    const mainUpdates = plan.updates.filter((w) => w.remoteRef.name === "refs/heads/main");
    expect(mainUpdates).toHaveLength(1);
    const devUpdates = plan.updates.filter((w) => w.remoteRef.name === "refs/heads/develop");
    expect(devUpdates).toHaveLength(1);
  });

  test("matchedRemoteRefs 应包含所有匹配的远端 ref（包括 hash 相同被跳过的）", () => {
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
      makeRef("refs/heads/develop", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ];
    const localRefs = new Map<string, SHA1>([["refs/remotes/origin/main", hash1]]);
    const plan = planRefUpdates(refs, localRefs, defaultRules);
    // matchedRemoteRefs 包含 main（hash 相同但被 matched）和 develop
    expect(plan.matchedRemoteRefs).toHaveLength(2);
  });

  test("不包含 wants 字段（已移至 FetchTransferPlan）", () => {
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
    ];
    const plan = planRefUpdates(refs, new Map(), defaultRules);
    // 类型层面验证：wants 不在 RefUpdatePlan 中
    expect("wants" in plan).toBe(false);
  });
});
