/**
 * Shallow 状态单元测试
 *
 * 覆盖场景：
 * - 内存后端 shallow 状态读写
 * - 文件后端 shallow 状态持久化 (.git/shallow)
 * - Repository 层 shallow 编排
 * - collectReachable 与 shallow boundaries 配合
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha1, type SHA1, type GitCommit } from "@/core/types.ts";
import { createMemoryObjectStore } from "@/odb/memory-store.ts";
import {
  createFileRepositoryBackend,
  createMemoryRepositoryBackend,
} from "@/repository/backend/index.ts";
import { createRepository, createMemoryRepository } from "@/repository/index.ts";
import { collectReachable } from "@/transport/push.ts";

import type { ObjectStore } from "@/odb/types.ts";

// ============================================================================
// 辅助函数
// ============================================================================

function makeHash(seed: string): SHA1 {
  return sha1(seed.padStart(40, "0").slice(0, 40));
}

const HASH_A = makeHash("a");
const HASH_B = makeHash("b");
const HASH_C = makeHash("c");

// ============================================================================
// 内存后端 Shallow 状态
// ============================================================================

describe("MemoryRepositoryBackend - shallow 状态", () => {
  test("默认状态下 readShallow 返回空数组", () => {
    const backend = createMemoryRepositoryBackend();
    expect(backend.readShallow()).toEqual([]);
  });

  test("writeShallow 后 readShallow 返回写入的边界", () => {
    const backend = createMemoryRepositoryBackend();
    backend.writeShallow([HASH_A, HASH_B]);
    expect(backend.readShallow()).toEqual([HASH_A, HASH_B]);
  });

  test("writeShallow 空数组清空 shallow 状态", () => {
    const backend = createMemoryRepositoryBackend();
    backend.writeShallow([HASH_A]);
    backend.writeShallow([]);
    expect(backend.readShallow()).toEqual([]);
  });

  test("writeShallow 返回排序后的结果", () => {
    const backend = createMemoryRepositoryBackend();
    backend.writeShallow([HASH_B, HASH_A]);
    expect(backend.readShallow()).toEqual([HASH_A, HASH_B]);
  });

  test("applyShallowUpdate 新增边界", () => {
    const backend = createMemoryRepositoryBackend();
    backend.applyShallowUpdate({ shallow: [HASH_A, HASH_B], unshallow: [] });
    expect(backend.readShallow()).toEqual([HASH_A, HASH_B]);
  });

  test("applyShallowUpdate 删除边界", () => {
    const backend = createMemoryRepositoryBackend();
    backend.writeShallow([HASH_A, HASH_B, HASH_C]);
    backend.applyShallowUpdate({ shallow: [], unshallow: [HASH_A] });
    expect(backend.readShallow()).toEqual([HASH_B, HASH_C]);
  });

  test("applyShallowUpdate 同时新增和删除", () => {
    const backend = createMemoryRepositoryBackend();
    backend.writeShallow([HASH_A, HASH_B]);
    backend.applyShallowUpdate({ shallow: [HASH_C], unshallow: [HASH_A] });
    expect(backend.readShallow()).toEqual([HASH_B, HASH_C]);
  });

  test("isShallowCommit 返回正确结果", () => {
    const backend = createMemoryRepositoryBackend();
    backend.writeShallow([HASH_A, HASH_B]);

    expect(backend.isShallowCommit(HASH_A)).toBe(true);
    expect(backend.isShallowCommit(HASH_B)).toBe(true);
    expect(backend.isShallowCommit(HASH_C)).toBe(false);
  });

  test("initialShallow 选项初始化 shallow 状态", () => {
    const backend = createMemoryRepositoryBackend({
      initialShallow: [HASH_A, HASH_B],
    });
    expect(backend.readShallow()).toEqual([HASH_A, HASH_B]);
    expect(backend.isShallowCommit(HASH_A)).toBe(true);
    expect(backend.isShallowCommit(HASH_C)).toBe(false);
  });

  test("readShallow 返回的数组可被外部修改而不影响内部状态", () => {
    const backend = createMemoryRepositoryBackend();
    backend.writeShallow([HASH_A]);

    const result = backend.readShallow();
    result.push(HASH_B);

    // 内部状态不受影响
    expect(backend.readShallow()).toEqual([HASH_A]);
  });
});

// ============================================================================
// 文件后端 Shallow 状态（.git/shallow 持久化）
// ============================================================================

describe("FileRepositoryBackend - shallow 状态持久化", () => {
  let tempDir: string;
  let gitDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `nano-git-shallow-${Date.now()}-${Math.random()}`);
    gitDir = join(tempDir, ".git");
    mkdirSync(join(gitDir, "objects"), { recursive: true });
    mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("无 .git/shallow 文件时 readShallow 返回空数组", () => {
    const backend = createFileRepositoryBackend(gitDir);
    expect(backend.readShallow()).toEqual([]);
  });

  test("writeShallow 创建 .git/shallow 文件", () => {
    const backend = createFileRepositoryBackend(gitDir);
    backend.writeShallow([HASH_A, HASH_B]);

    expect(existsSync(join(gitDir, "shallow"))).toBe(true);
    const content = readFileSync(join(gitDir, "shallow"), "utf-8");
    expect(content.trim().split("\n")).toEqual([HASH_A, HASH_B]);
  });

  test("写入后 readShallow 能正确读取", () => {
    const backend = createFileRepositoryBackend(gitDir);
    backend.writeShallow([HASH_A, HASH_B]);
    expect(backend.readShallow()).toEqual([HASH_A, HASH_B]);
  });

  test("writeShallow 空数组删除 .git/shallow 文件", () => {
    const backend = createFileRepositoryBackend(gitDir);
    backend.writeShallow([HASH_A]);
    backend.writeShallow([]);

    expect(existsSync(join(gitDir, "shallow"))).toBe(false);
    expect(backend.readShallow()).toEqual([]);
  });

  test("openRepository 后 shallow 状态不丢失", () => {
    // 先写入 shallow 文件
    const backend1 = createFileRepositoryBackend(gitDir);
    backend1.writeShallow([HASH_A, HASH_B]);

    // 模拟 reopen
    const backend2 = createFileRepositoryBackend(gitDir);
    expect(backend2.readShallow()).toEqual([HASH_A, HASH_B]);
    expect(backend2.isShallowCommit(HASH_A)).toBe(true);
    expect(backend2.isShallowCommit(HASH_C)).toBe(false);
  });

  test("applyShallowUpdate 写入 .git/shallow 文件", () => {
    const backend = createFileRepositoryBackend(gitDir);
    backend.writeShallow([HASH_A, HASH_B]);

    backend.applyShallowUpdate({ shallow: [HASH_C], unshallow: [HASH_A] });

    const content = readFileSync(join(gitDir, "shallow"), "utf-8");
    const hashes = content.trim().split("\n");
    expect(hashes).toContain(HASH_B);
    expect(hashes).toContain(HASH_C);
    expect(hashes).not.toContain(HASH_A);
  });

  test("isShallowCommit 基于文件内容返回", () => {
    const backend = createFileRepositoryBackend(gitDir);
    backend.writeShallow([HASH_A]);

    expect(backend.isShallowCommit(HASH_A)).toBe(true);
    expect(backend.isShallowCommit(HASH_B)).toBe(false);
  });

  test("手动创建 .git/shallow 文件后可被正常读取", () => {
    // 模拟真实 Git 创建的 .git/shallow 文件
    writeFileSync(join(gitDir, "shallow"), `${HASH_A}\n${HASH_B}\n`);

    const backend = createFileRepositoryBackend(gitDir);
    expect(backend.readShallow()).toEqual([HASH_A, HASH_B]);
    expect(backend.isShallowCommit(HASH_A)).toBe(true);
    expect(backend.isShallowCommit(HASH_C)).toBe(false);
  });
});

// ============================================================================
// Repository 层 shallow 编排
// ============================================================================

describe("Repository 层 shallow 编排", () => {
  test("Repository 的 backend 暴露 shallow 方法", () => {
    const repo = createMemoryRepository();
    expect(repo.backend.readShallow).toBeDefined();
    expect(repo.backend.writeShallow).toBeDefined();
    expect(repo.backend.applyShallowUpdate).toBeDefined();
    expect(repo.backend.isShallowCommit).toBeDefined();
  });

  test("内存仓库默认无 shallow 状态", () => {
    const repo = createMemoryRepository();
    expect(repo.backend.readShallow()).toEqual([]);
  });

  test("通过 backend 设置 shallow 后可通过 readShallow 读取", () => {
    const backend = createMemoryRepositoryBackend();
    const repo = createRepository(backend);

    backend.writeShallow([HASH_A]);
    expect(repo.backend.readShallow()).toEqual([HASH_A]);
  });
});

// ============================================================================
// collectReachable 与 shallow boundaries
// ============================================================================

describe("collectReachable 与 shallow boundaries", () => {
  let store: ObjectStore;
  let emptyTree: SHA1;
  let rootHash: SHA1;
  let aHash: SHA1;
  let bHash: SHA1;
  let cHash: SHA1;

  beforeEach(() => {
    store = createMemoryObjectStore();
    emptyTree = store.write({ type: "tree", entries: [] });

    // 构造链：root → a → b (缺失, shallow) → c
    rootHash = store.write({
      type: "commit",
      tree: emptyTree,
      parents: [],
      author: { name: "T", email: "t@t", timestamp: 1000, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 1000, timezone: "+0000" },
      message: "root",
    } as GitCommit);

    aHash = store.write({
      type: "commit",
      tree: emptyTree,
      parents: [rootHash],
      author: { name: "T", email: "t@t", timestamp: 1000, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 1000, timezone: "+0000" },
      message: "a",
    } as GitCommit);

    // b 不写入 store（模拟 shallow boundary）
    bHash = sha1("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

    // c 的 parent 是 b（不存在于 store）
    cHash = store.write({
      type: "commit",
      tree: emptyTree,
      parents: [bHash],
      author: { name: "T", email: "t@t", timestamp: 2000, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 2000, timezone: "+0000" },
      message: "c",
    } as GitCommit);
  });

  test("不传 shallowBoundaries 时，缺失 commit parent 在 skip 模式被跳过", () => {
    const result = collectReachable(store, [cHash], "skip");
    expect(result.has(cHash)).toBe(true);
    expect(result.has(emptyTree)).toBe(true);
    expect(result.has(bHash)).toBe(false);
    expect(result.has(aHash)).toBe(false);
    expect(result.has(rootHash)).toBe(false);
  });

  test("传入 shallowBoundaries 时，集合内的缺失 parent 被跳过", () => {
    const result = collectReachable(store, [cHash], "skip", new Set([bHash]));
    expect(result.has(cHash)).toBe(true);
    expect(result.has(emptyTree)).toBe(true);
    // b 本身不在集合中（未写入 store），但因为是已知 shallow 边界，不报错
    expect(result.has(bHash)).toBe(false);
    expect(result.has(aHash)).toBe(false);
  });

  test("传入 shallowBoundaries 时，集合外的缺失 parent 在 throw 模式仍报错", () => {
    // bHash 不在 shallowBoundaries 中，在 throw 模式应报错
    expect(() => {
      collectReachable(
        store,
        [cHash],
        "throw",
        new Set([
          /* bHash not included */
        ]),
      );
    }).toThrow(/missing from the local store/i);
  });

  test("传入 shallowBoundaries 时，集合内的缺失 parent 在 throw 模式下也不报错", () => {
    // bHash 在 shallowBoundaries 中，即使 throw 模式也不应报错
    const result = collectReachable(store, [cHash], "throw", new Set([bHash]));
    expect(result.has(cHash)).toBe(true);
    expect(result.has(emptyTree)).toBe(true);
  });

  test("shallowBoundaries 包含多个哈希时只跳过匹配的", () => {
    const otherHash = sha1("cccccccccccccccccccccccccccccccccccccccc");
    const result = collectReachable(store, [cHash], "throw", new Set([bHash, otherHash]));
    expect(result.has(cHash)).toBe(true);
    expect(result.has(emptyTree)).toBe(true);
  });
});
