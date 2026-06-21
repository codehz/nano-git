/**
 * fetch 辅助函数单元测试
 *
 * 覆盖 selectHaveTips、getLocalRefs，以及
 * getLocalRefs + determineWants 自定义 namespace 集成。
 */

import { describe, test, expect } from "bun:test";

import { sha1, type SHA1 } from "@/core/types.ts";
import { createMemoryRefStore } from "@/refs/stores/memory.ts";
import { parseRefSpec, selectHaveTips, getLocalRefs, determineWants } from "@/transport/fetch.ts";

import type { RemoteRef } from "@/transport/types.ts";

// ============================================================================
// 辅助函数
// ============================================================================

function makeRef(name: string, hash?: string): RemoteRef {
  return { name, hash: sha1(hash ?? "95d09f2b10159347eece71399a7e2e907ea3df4f") };
}

// ============================================================================
// selectHaveTips
// ============================================================================

describe("selectHaveTips()", () => {
  const hashA = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const hashB = sha1("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  const hashC = sha1("cccccccccccccccccccccccccccccccccccccccc");

  test("第一优先：wants 对应的 remote-tracking ref 旧值", () => {
    const localRefs = new Map<string, SHA1>([
      ["refs/remotes/origin/main", hashA],
      ["HEAD", hashB],
    ]);
    const wants = [
      {
        remote: makeRef("refs/heads/main"),
        localName: "refs/remotes/origin/main",
        localHash: hashA,
        force: true,
      },
    ];

    const tips = selectHaveTips(localRefs, wants);
    // hashA 应是第一个（第一优先）
    expect(tips[0]).toBe(hashA);
    // hashB 也会出现（第三优先 HEAD）
    expect(tips).toContain(hashB);
  });

  test("第二优先：同一远端命名空间下的其他 remote-tracking refs", () => {
    const localRefs = new Map<string, SHA1>([
      ["refs/remotes/origin/main", hashA],
      ["refs/remotes/origin/feature", hashB],
      ["refs/remotes/upstream/main", hashC],
    ]);
    const wants = [
      {
        remote: makeRef("refs/heads/main"),
        localName: "refs/remotes/origin/main",
        localHash: hashA,
        force: true,
      },
    ];

    const tips = selectHaveTips(localRefs, wants);
    // hashA 第一优先（wants 的 localHash）
    // hashB 第二优先（同一远端前缀 refs/remotes/origin/）
    // hashC 不应出现（不同远端前缀）
    expect(tips).toContain(hashA);
    expect(tips).toContain(hashB);
    expect(tips).not.toContain(hashC);
  });

  test("第三优先：HEAD", () => {
    const localRefs = new Map<string, SHA1>([
      ["refs/remotes/origin/main", hashA],
      ["HEAD", hashB],
      ["refs/heads/feature", hashC],
    ]);
    const wants = [
      {
        remote: makeRef("refs/heads/main"),
        localName: "refs/remotes/origin/main",
        localHash: hashA,
        force: true,
      },
    ];

    const tips = selectHaveTips(localRefs, wants);
    // hashA（第一优先）, hashB（第三优先 HEAD）, 然后 heads
    expect(tips.indexOf(hashA)).toBeLessThan(tips.indexOf(hashB)!);
    // HEAD 在 heads 之前
    expect(tips.indexOf(hashB)).toBeLessThan(tips.indexOf(hashC)!);
  });

  test("第四优先：本地 heads 兜底", () => {
    const localRefs = new Map<string, SHA1>([
      ["refs/heads/main", hashA],
      ["refs/heads/feature", hashB],
    ]);
    // 无 remote-tracking refs 且无 HEAD
    const wants: Array<{ remote: RemoteRef; localName: string; localHash?: SHA1; force: boolean }> =
      [];

    const tips = selectHaveTips(localRefs, wants);
    expect(tips).toContain(hashA);
    expect(tips).toContain(hashB);
  });

  test("不包含 tags 除非它们被 remote-tracking 覆盖", () => {
    const localRefs = new Map<string, SHA1>([
      ["refs/remotes/origin/main", hashA],
      ["refs/tags/v1.0", hashB],
      ["HEAD", hashC],
    ]);
    const wants = [
      {
        remote: makeRef("refs/heads/main"),
        localName: "refs/remotes/origin/main",
        localHash: hashA,
        force: true,
      },
    ];

    const tips = selectHaveTips(localRefs, wants);
    // hashB（tag）不应出现
    expect(tips).not.toContain(hashB);
  });

  test("wants 无 localHash 时从第二优先开始", () => {
    const localRefs = new Map<string, SHA1>([
      ["refs/remotes/origin/main", hashA],
      ["HEAD", hashB],
    ]);
    const wants = [
      {
        remote: makeRef("refs/heads/main"),
        localName: "refs/remotes/origin/main",
        force: true,
      },
    ];

    const tips = selectHaveTips(localRefs, wants);
    // 没有 localHash，直接跳到远程 tracking refs（第二优先）
    expect(tips).toContain(hashA);
    expect(tips).toContain(hashB);
  });

  test("去重：同一 hash 不会重复出现", () => {
    const localRefs = new Map<string, SHA1>([
      ["refs/remotes/origin/main", hashA],
      ["refs/heads/main", hashA], // 同一 hash
    ]);
    const wants = [
      {
        remote: makeRef("refs/heads/main"),
        localName: "refs/remotes/origin/main",
        localHash: hashA,
        force: true,
      },
    ];

    const tips = selectHaveTips(localRefs, wants);
    // hashA 只出现一次
    expect(tips.filter((h) => h === hashA)).toHaveLength(1);
  });
});

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
// getLocalRefs + determineWants 集成测试
// ============================================================================

describe("getLocalRefs + determineWants 自定义 namespace 集成", () => {
  test("自定义目标命名空间的本地已有 ref 应被检测到，localHash 正确设置", () => {
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
    // 远程有更新的 hash，本地已有旧值 → localHash 应为 existingHash
    const spec = parseRefSpec("refs/heads/main:refs/mirrors/upstream/main");
    const remoteRef: RemoteRef[] = [{ name: "refs/heads/main", hash: newHash }];

    const wants = determineWants(remoteRef, localRefs, [spec]);

    expect(wants).toHaveLength(1);
    expect(wants[0]!.localName).toBe("refs/mirrors/upstream/main");
    // 这才是关键断言：localHash 应为 existingHash 而非 undefined
    expect(wants[0]!.localHash).toBe(existingHash);
  });
});
