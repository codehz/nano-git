/**
 * Shallow 状态单元测试
 *
 * 覆盖场景：
 * - ShallowStore 接口（内存实现）
 * - ShallowStore 接口（文件系统实现）
 * - RepositoryBackend shallow 属性
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
import { createMemoryShallowStore, createFileShallowStore } from "@/shallow/index.ts";
import { collectReachable } from "@/transport/object-graph.ts";

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
// ShallowStore（内存实现）独立测试
// ============================================================================

describe("createMemoryShallowStore()", () => {
  test("默认状态下 read 返回空数组", () => {
    const store = createMemoryShallowStore();
    expect(store.read()).toEqual([]);
  });

  test("write 后 read 返回写入的边界", () => {
    const store = createMemoryShallowStore();
    store.write([HASH_A, HASH_B]);
    expect(store.read()).toEqual([HASH_A, HASH_B]);
  });

  test("write 空数组清空 shallow 状态", () => {
    const store = createMemoryShallowStore();
    store.write([HASH_A]);
    store.write([]);
    expect(store.read()).toEqual([]);
  });

  test("read 返回排序后的结果", () => {
    const store = createMemoryShallowStore();
    store.write([HASH_B, HASH_A]);
    expect(store.read()).toEqual([HASH_A, HASH_B]);
  });

  test("applyUpdate 新增边界", () => {
    const store = createMemoryShallowStore();
    store.applyUpdate({ shallow: [HASH_A, HASH_B], unshallow: [] });
    expect(store.read()).toEqual([HASH_A, HASH_B]);
  });

  test("applyUpdate 删除边界", () => {
    const store = createMemoryShallowStore();
    store.write([HASH_A, HASH_B, HASH_C]);
    store.applyUpdate({ shallow: [], unshallow: [HASH_A] });
    expect(store.read()).toEqual([HASH_B, HASH_C]);
  });

  test("applyUpdate 同时新增和删除", () => {
    const store = createMemoryShallowStore();
    store.write([HASH_A, HASH_B]);
    store.applyUpdate({ shallow: [HASH_C], unshallow: [HASH_A] });
    expect(store.read()).toEqual([HASH_B, HASH_C]);
  });

  test("isShallow 返回正确结果", () => {
    const store = createMemoryShallowStore();
    store.write([HASH_A, HASH_B]);

    expect(store.isShallow(HASH_A)).toBe(true);
    expect(store.isShallow(HASH_B)).toBe(true);
    expect(store.isShallow(HASH_C)).toBe(false);
  });

  test("初始参数初始化 shallow 状态", () => {
    const store = createMemoryShallowStore([HASH_A, HASH_B]);
    expect(store.read()).toEqual([HASH_A, HASH_B]);
    expect(store.isShallow(HASH_A)).toBe(true);
    expect(store.isShallow(HASH_C)).toBe(false);
  });

  test("read 返回数组副本，修改不影响内部状态", () => {
    const store = createMemoryShallowStore();
    store.write([HASH_A]);

    const result = store.read();
    result.push(HASH_B);

    expect(store.read()).toEqual([HASH_A]);
  });
});

// ============================================================================
// ShallowStore（文件实现）独立测试
// ============================================================================

describe("createFileShallowStore()", () => {
  let tempDir: string;
  let gitDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `nano-git-shallow-file-${Date.now()}-${Math.random()}`);
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

  test("无 .git/shallow 文件时 read 返回空数组", () => {
    const store = createFileShallowStore(gitDir);
    expect(store.read()).toEqual([]);
  });

  test("write 创建 .git/shallow 文件", () => {
    const store = createFileShallowStore(gitDir);
    store.write([HASH_A, HASH_B]);

    expect(existsSync(join(gitDir, "shallow"))).toBe(true);
    const content = readFileSync(join(gitDir, "shallow"), "utf-8");
    expect(content.trim().split("\n")).toEqual([HASH_A, HASH_B]);
  });

  test("写入后 read 能正确读取", () => {
    const store = createFileShallowStore(gitDir);
    store.write([HASH_A, HASH_B]);
    expect(store.read()).toEqual([HASH_A, HASH_B]);
  });

  test("write 空数组删除 .git/shallow 文件", () => {
    const store = createFileShallowStore(gitDir);
    store.write([HASH_A]);
    store.write([]);

    expect(existsSync(join(gitDir, "shallow"))).toBe(false);
    expect(store.read()).toEqual([]);
  });

  test("close 后 reopen 状态不丢失", () => {
    const store1 = createFileShallowStore(gitDir);
    store1.write([HASH_A, HASH_B]);

    // 重新打开（模拟 reopen）
    const store2 = createFileShallowStore(gitDir);
    expect(store2.read()).toEqual([HASH_A, HASH_B]);
    expect(store2.isShallow(HASH_A)).toBe(true);
    expect(store2.isShallow(HASH_C)).toBe(false);
  });

  test("applyUpdate 写入 .git/shallow 文件", () => {
    const store = createFileShallowStore(gitDir);
    store.write([HASH_A, HASH_B]);

    store.applyUpdate({ shallow: [HASH_C], unshallow: [HASH_A] });

    const content = readFileSync(join(gitDir, "shallow"), "utf-8");
    const hashes = content.trim().split("\n");
    expect(hashes).toContain(HASH_B);
    expect(hashes).toContain(HASH_C);
    expect(hashes).not.toContain(HASH_A);
  });

  test("isShallow 基于文件内容返回", () => {
    const store = createFileShallowStore(gitDir);
    store.write([HASH_A]);

    expect(store.isShallow(HASH_A)).toBe(true);
    expect(store.isShallow(HASH_B)).toBe(false);
  });

  test("手动创建 .git/shallow 文件后可被正常读取", () => {
    writeFileSync(join(gitDir, "shallow"), `${HASH_A}\n${HASH_B}\n`);

    const store = createFileShallowStore(gitDir);
    expect(store.read()).toEqual([HASH_A, HASH_B]);
    expect(store.isShallow(HASH_A)).toBe(true);
    expect(store.isShallow(HASH_C)).toBe(false);
  });
});

// ============================================================================
// RepositoryBackend shallow 属性
// ============================================================================

describe("RepositoryBackend.shallow", () => {
  test("内存后端 shallow 是 ShallowStore 实例", () => {
    const backend = createMemoryRepositoryBackend();
    expect(backend.shallow).toBeDefined();
    expect(typeof backend.shallow.read).toBe("function");
    expect(typeof backend.shallow.write).toBe("function");
    expect(typeof backend.shallow.applyUpdate).toBe("function");
    expect(typeof backend.shallow.isShallow).toBe("function");
  });

  test("内存后端默认 shallow 为空", () => {
    const backend = createMemoryRepositoryBackend();
    expect(backend.shallow.read()).toEqual([]);
  });

  test("文件后端 shallow 是 ShallowStore 实例", () => {
    const tempDir = join(tmpdir(), `nano-git-backend-${Date.now()}-${Math.random()}`);
    const gDir = join(tempDir, ".git");
    mkdirSync(join(gDir, "objects"), { recursive: true });
    mkdirSync(join(gDir, "refs", "heads"), { recursive: true });
    writeFileSync(join(gDir, "HEAD"), "ref: refs/heads/main\n");
    try {
      const backend = createFileRepositoryBackend(gDir);
      expect(backend.shallow).toBeDefined();
      expect(typeof backend.shallow.read).toBe("function");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("通过 backend.shallow 读写状态", () => {
    const backend = createMemoryRepositoryBackend();
    backend.shallow.write([HASH_A]);
    expect(backend.shallow.read()).toEqual([HASH_A]);
    expect(backend.shallow.isShallow(HASH_A)).toBe(true);
  });

  test("initialShallow 通过 backend.shallow 反映", () => {
    const backend = createMemoryRepositoryBackend({
      initialShallow: [HASH_A, HASH_B],
    });
    expect(backend.shallow.read()).toEqual([HASH_A, HASH_B]);
    expect(backend.shallow.isShallow(HASH_A)).toBe(true);
  });
});

// ============================================================================
// Repository 层 shallow 编排
// ============================================================================

describe("Repository 层 shallow 编排", () => {
  test("Repository 通过 backend.shallow 访问 shallow 状态", () => {
    const repo = createMemoryRepository();
    expect(repo.backend.shallow).toBeDefined();
  });

  test("内存仓库默认无 shallow 状态", () => {
    const repo = createMemoryRepository();
    expect(repo.backend.shallow.read()).toEqual([]);
  });

  test("通过 backend.shallow 设置后 repo 可见", () => {
    const backend = createMemoryRepositoryBackend();
    const repo = createRepository(backend);

    backend.shallow.write([HASH_A]);
    expect(repo.backend.shallow.read()).toEqual([HASH_A]);
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
