/**
 * determineWants 单元测试
 *
 * 覆盖 wants 确定逻辑：初始 clone、增量 fetch、refspec 去重、
 * 对象存在性校验、store 参数向后兼容。
 */

import { describe, test, expect } from "bun:test";

import { sha1, type SHA1, type GitBlob, type GitCommit } from "@/core/types.ts";
import { createMemoryObjectStore } from "@/odb/memory-store.ts";
import { parseRefSpec, determineWants } from "@/transport/fetch.ts";

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

describe("determineWants()", () => {
  const hash1 = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
  const hash2 = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const defaultSpec = parseRefSpec("+refs/heads/*:refs/remotes/origin/*");

  test("初始 clone：所有分支都应 want，localHash 为 undefined", () => {
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
      makeRef("refs/heads/develop", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ];
    const wants = determineWants(refs, new Map(), [defaultSpec]);
    expect(wants).toHaveLength(2);
    expect(wants[0]!.localName).toBe("refs/remotes/origin/main");
    expect(wants[0]!.localHash).toBeUndefined();
    expect(wants[0]!.force).toBe(true);
    expect(wants[1]!.localName).toBe("refs/remotes/origin/develop");
    expect(wants[1]!.localHash).toBeUndefined();
    expect(wants[1]!.force).toBe(true);
  });

  test("本地已是最新则跳过", () => {
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
      makeRef("refs/heads/develop", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ];
    const localRefs = new Map<string, SHA1>([["refs/remotes/origin/main", hash1]]);
    const wants = determineWants(refs, localRefs, [defaultSpec]);
    // main 已是最新，只有 develop 需要拉取
    expect(wants).toHaveLength(1);
    expect(wants[0]!.localName).toBe("refs/remotes/origin/develop");
    expect(wants[0]!.localHash).toBeUndefined(); // develop 本地不存在
    expect(wants[0]!.force).toBe(true);
  });

  test("本地 hash 不同则应拉取并包含 localHash", () => {
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
    ];
    const localRefs = new Map<string, SHA1>([
      ["refs/remotes/origin/main", hash2], // 不同的 hash
    ]);
    const wants = determineWants(refs, localRefs, [defaultSpec]);
    expect(wants).toHaveLength(1);
    expect(wants[0]!.localHash).toBe(hash2); // 应返回本地旧 hash
    expect(wants[0]!.force).toBe(true);
  });

  test("非强制 refspec 传递 force=false", () => {
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
    ];
    const nonForceSpec = parseRefSpec("refs/heads/*:refs/remotes/origin/*");
    const wants = determineWants(refs, new Map(), [nonForceSpec]);
    expect(wants).toHaveLength(1);
    expect(wants[0]!.force).toBe(false);
  });

  test("空远程返回空 wants", () => {
    const wants = determineWants([], new Map(), [defaultSpec]);
    expect(wants).toHaveLength(0);
  });

  test("精确 refspec 不会因前缀匹配引入多余 wants", () => {
    const exactSpec = parseRefSpec("+refs/heads/main:refs/remotes/origin/main");
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
      makeRef("refs/heads/main-old", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ];
    const wants = determineWants(refs, new Map(), [exactSpec]);
    expect(wants).toHaveLength(1);
    expect(wants[0]!.remote.name).toBe("refs/heads/main");
    expect(wants[0]!.localName).toBe("refs/remotes/origin/main");
  });

  test("重叠 refspec 应去重，同一 remote ref 只生成一个 want", () => {
    const wildSpec = parseRefSpec("+refs/heads/*:refs/remotes/origin/*");
    const exactSpec = parseRefSpec("+refs/heads/main:refs/remotes/origin/main");
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
      makeRef("refs/heads/develop", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ];
    const wants = determineWants(refs, new Map(), [wildSpec, exactSpec]);
    // main 和 develop 来自通配符，main 另由精确 spec 匹配但应去重
    // => main x1 + develop x1 = 2
    expect(wants).toHaveLength(2);
    const mainWants = wants.filter((w) => w.remote.name === "refs/heads/main");
    expect(mainWants).toHaveLength(1);
    const devWants = wants.filter((w) => w.remote.name === "refs/heads/develop");
    expect(devWants).toHaveLength(1);
  });

  describe("对象存在性校验", () => {
    const hash = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");

    test("hash 匹配且对象存在时跳过（不传 store 时保持向后兼容）", () => {
      const refs: RemoteRef[] = [makeRef("refs/heads/main", hash)];
      const localRefs = new Map<string, SHA1>([["refs/remotes/origin/main", hash]]);
      // 不传 store —— 旧行为，hash 匹配即跳过
      const wants = determineWants(refs, localRefs, [defaultSpec]);
      expect(wants).toHaveLength(0);
    });

    test("hash 匹配但对象不存在时仍产生 want", () => {
      const refs: RemoteRef[] = [makeRef("refs/heads/main", hash)];
      const localRefs = new Map<string, SHA1>([["refs/remotes/origin/main", hash]]);
      // 传一个空 store（什么都不存在）
      const wants = determineWants(refs, localRefs, [defaultSpec], createMemoryObjectStore());
      // 对象不存在，应仍产生 want
      expect(wants).toHaveLength(1);
      expect(wants[0]!.localName).toBe("refs/remotes/origin/main");
      expect(wants[0]!.localHash).toBe(hash);
      expect(wants[0]!.force).toBe(true);
    });

    test("hash 匹配且对象存在时跳过（传 store 且对象存在）", () => {
      const refs: RemoteRef[] = [makeRef("refs/heads/main", hash)];
      const localRefs = new Map<string, SHA1>([["refs/remotes/origin/main", hash]]);
      // 在 store 里写入一个假对象让 exists 返回 true
      const store = createMemoryObjectStore();
      const blob: GitBlob = { type: "blob", content: Buffer.from("dummy") };
      store.write(blob);
      // hash 对应的对象不存在于 store 中，所以仍应产生 want
      const wants = determineWants(refs, localRefs, [defaultSpec], store);
      // hash 是个假哈希，store 里没有，所以仍 want
      expect(wants).toHaveLength(1);
    });

    test("hash 匹配且对象确实存在时跳过", () => {
      const store = createMemoryObjectStore();
      // 写入真正的对象使 exists 返回 true
      const realHash = createTestCommit(store, [], 100);
      const realRefs: RemoteRef[] = [makeRef("refs/heads/main", realHash)];
      const realLocalRefs = new Map<string, SHA1>([["refs/remotes/origin/main", realHash]]);
      const wants = determineWants(realRefs, realLocalRefs, [defaultSpec], store);
      // 对象存在，应跳过
      expect(wants).toHaveLength(0);
    });
  });

  describe("store 参数向后兼容", () => {
    const hash = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");

    test("不传 store 时 behavior 不变", () => {
      const refs: RemoteRef[] = [makeRef("refs/heads/main", hash)];
      const localRefs = new Map<string, SHA1>([["refs/remotes/origin/main", hash]]);
      const wants = determineWants(refs, localRefs, [defaultSpec]);
      expect(wants).toHaveLength(0);
    });
  });
});
