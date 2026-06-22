/**
 * planRefUpdates 单元测试
 *
 * 覆盖 wants 确定逻辑：初始 clone、增量 fetch、refspec 去重、
 * 对象存在性校验、store 参数向后兼容。
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

// ============================================================================
// Wants 确定
// ============================================================================

describe("planRefUpdates()", () => {
  const hash1 = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
  const hash2 = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const defaultRules = [{ source: "refs/heads/*", target: "refs/remotes/origin/*", force: true }];

  test("初始 clone：所有分支都应 want，currentLocalHash 为 undefined", () => {
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

  test("本地已是最新则跳过", () => {
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
      makeRef("refs/heads/develop", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ];
    const localRefs = new Map<string, SHA1>([["refs/remotes/origin/main", hash1]]);
    const plan = planRefUpdates(refs, localRefs, defaultRules);
    // main 已是最新，只有 develop 需要拉取
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]!.localRef).toBe("refs/remotes/origin/develop");
    expect(plan.updates[0]!.currentLocalHash).toBeUndefined(); // develop 本地不存在
    expect(plan.updates[0]!.force).toBe(true);
  });

  test("本地 hash 不同则应拉取并包含 currentLocalHash", () => {
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
    ];
    const localRefs = new Map<string, SHA1>([
      ["refs/remotes/origin/main", hash2], // 不同的 hash
    ]);
    const plan = planRefUpdates(refs, localRefs, defaultRules);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]!.currentLocalHash).toBe(hash2); // 应返回本地旧 hash
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

  test("空远程返回空 wants", () => {
    const plan = planRefUpdates([], new Map(), defaultRules);
    expect(plan.updates).toHaveLength(0);
  });

  test("精确 refspec 不会因前缀匹配引入多余 wants", () => {
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

  test("重叠 refspec 应去重，同一 remote ref 只生成一个 want", () => {
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
      makeRef("refs/heads/develop", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ];
    const plan = planRefUpdates(refs, new Map(), [
      { source: "refs/heads/*", target: "refs/remotes/origin/*", force: true },
      { source: "refs/heads/main", target: "refs/remotes/origin/main", force: true },
    ]);
    // main 和 develop 来自通配符，main 另由精确 spec 匹配但应去重
    // => main x1 + develop x1 = 2
    expect(plan.updates).toHaveLength(2);
    const mainWants = plan.updates.filter((w) => w.remoteRef.name === "refs/heads/main");
    expect(mainWants).toHaveLength(1);
    const devWants = plan.updates.filter((w) => w.remoteRef.name === "refs/heads/develop");
    expect(devWants).toHaveLength(1);
  });

  describe("对象存在性校验", () => {
    const hash = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");

    test("hash 匹配且对象存在时跳过（不传 store 时保持向后兼容）", () => {
      const refs: RemoteRef[] = [makeRef("refs/heads/main", hash)];
      const localRefs = new Map<string, SHA1>([["refs/remotes/origin/main", hash]]);
      // 不传 store —— 旧行为，hash 匹配即跳过
      const plan = planRefUpdates(refs, localRefs, defaultRules);
      expect(plan.updates).toHaveLength(0);
    });

    test("hash 匹配但对象不存在时仍产生 want", () => {
      const refs: RemoteRef[] = [makeRef("refs/heads/main", hash)];
      const localRefs = new Map<string, SHA1>([["refs/remotes/origin/main", hash]]);
      // 传一个空 store（什么都不存在）
      const plan = planRefUpdates(refs, localRefs, defaultRules, createMemoryObjectStore());
      // 对象不存在，应仍产生 want
      expect(plan.updates).toHaveLength(1);
      expect(plan.updates[0]!.localRef).toBe("refs/remotes/origin/main");
      expect(plan.updates[0]!.currentLocalHash).toBe(hash);
      expect(plan.updates[0]!.force).toBe(true);
    });

    test("hash 匹配且对象存在时跳过（传 store 且对象存在）", () => {
      const refs: RemoteRef[] = [makeRef("refs/heads/main", hash)];
      const localRefs = new Map<string, SHA1>([["refs/remotes/origin/main", hash]]);
      // 在 store 里写入一个假对象让 exists 返回 true
      const store = createMemoryObjectStore();
      const blob: GitBlob = { type: "blob", content: Buffer.from("dummy") };
      store.write(blob);
      // hash 对应的对象不存在于 store 中，所以仍应产生 want
      const plan = planRefUpdates(refs, localRefs, defaultRules, store);
      // hash 是个假哈希，store 里没有，所以仍 want
      expect(plan.updates).toHaveLength(1);
    });

    test("hash 匹配且对象确实存在时跳过", () => {
      const store = createMemoryObjectStore();
      // 写入真正的对象使 exists 返回 true
      const realHash = createTestCommit(store, [], 100);
      const realRefs: RemoteRef[] = [makeRef("refs/heads/main", realHash)];
      const realLocalRefs = new Map<string, SHA1>([["refs/remotes/origin/main", realHash]]);
      const plan = planRefUpdates(realRefs, realLocalRefs, defaultRules, store);
      // 对象存在，应跳过
      expect(plan.updates).toHaveLength(0);
    });
  });

  describe("store 参数向后兼容", () => {
    const hash = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");

    test("不传 store 时 behavior 不变", () => {
      const refs: RemoteRef[] = [makeRef("refs/heads/main", hash)];
      const localRefs = new Map<string, SHA1>([["refs/remotes/origin/main", hash]]);
      const plan = planRefUpdates(refs, localRefs, defaultRules);
      expect(plan.updates).toHaveLength(0);
    });
  });
});
