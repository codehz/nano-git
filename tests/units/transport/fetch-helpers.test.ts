/**
 * fetch 辅助函数单元测试
 *
 * 覆盖 getLocalRefs，以及
 * getLocalRefs + planRefUpdates 自定义 namespace 集成。
 */

import { describe, test, expect } from "bun:test";

import { sha1 } from "@/core/types.ts";
import { createMemoryRefStore } from "@/refs/stores/memory.ts";
import { getLocalRefs, planRefUpdates } from "@/transport/ref-plan.ts";

import type { RemoteRef } from "@/transport/types.ts";

// ============================================================================
// 辅助函数
// ============================================================================
// getLocalRefs
// ============================================================================

describe("getLocalRefs()", () => {
  test("符号引用 HEAD 应解析为目标 ref 的哈希", () => {
    const hash = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const store = createMemoryRefStore(
      new Map([
        ["HEAD", "ref: refs/heads/main"],
        ["refs/heads/main", hash],
      ]),
    );

    const refs = getLocalRefs(store);
    expect(refs.get("HEAD")).toBe(hash);
  });

  test("分离头指针（detached HEAD）也应解析", () => {
    const hash = sha1("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    const store = createMemoryRefStore(new Map([["HEAD", hash]]));

    const refs = getLocalRefs(store);
    expect(refs.get("HEAD")).toBe(hash);
  });

  test("自定义命名空间 refs/mirrors/ 也能被 getLocalRefs 检测到", () => {
    const hash = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const store = createMemoryRefStore(
      new Map([
        ["HEAD", "ref: refs/heads/main"],
        ["refs/heads/main", hash],
        ["refs/mirrors/upstream/main", hash],
      ]),
    );

    const refs = getLocalRefs(store);
    expect(refs.get("HEAD")).toBe(hash);
    expect(refs.get("refs/heads/main")).toBe(hash);
    expect(refs.get("refs/mirrors/upstream/main")).toBe(hash);
  });
});

// ============================================================================
// getLocalRefs + planRefUpdates 集成测试
// ============================================================================

describe("getLocalRefs + planRefUpdates 自定义 namespace 集成", () => {
  test("自定义目标命名空间的本地已有 ref 应被检测到，currentLocalHash 正确设置", () => {
    const existingHash = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const newHash = sha1("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

    // 模拟本地已有 refs/mirrors/upstream/main
    const refs = createMemoryRefStore(
      new Map([
        ["refs/heads/main", existingHash],
        ["refs/mirrors/upstream/main", existingHash],
      ]),
    );

    const localRefs = getLocalRefs(refs);

    // refspec: refs/heads/main:refs/mirrors/upstream/main
    // 远程有更新的 hash，本地已有旧值 → currentLocalHash 应为 existingHash
    const remoteRef: RemoteRef[] = [{ name: "refs/heads/main", hash: newHash }];

    const plan = planRefUpdates(remoteRef, localRefs, [
      { source: "refs/heads/main", target: "refs/mirrors/upstream/main" },
    ]);

    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]!.localRef).toBe("refs/mirrors/upstream/main");
    // 这才是关键断言：currentLocalHash 应为 existingHash 而非 undefined
    expect(plan.updates[0]!.currentLocalHash).toBe(existingHash);
  });
});
