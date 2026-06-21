/**
 * 仓库初始化和打开测试
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFileRepositoryBackend,
  createMemoryRepositoryBackend,
  type RepositoryBackend,
} from "@/repository/backend/index.ts";
import { createRepository, initRepository, openRepository } from "@/repository/index.ts";

describe("initRepository()", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `nano-git-repo-${Date.now()}-${Math.random()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("创建 .git 目录结构", () => {
    initRepository(tempDir);
    expect(existsSync(join(tempDir, ".git"))).toBe(true);
    expect(existsSync(join(tempDir, ".git", "objects"))).toBe(true);
    expect(existsSync(join(tempDir, ".git", "refs", "heads"))).toBe(true);
    expect(existsSync(join(tempDir, ".git", "refs", "tags"))).toBe(true);
  });

  test("HEAD 指向 refs/heads/main", () => {
    initRepository(tempDir);
    const head = readFileSync(join(tempDir, ".git", "HEAD"), "utf-8");
    expect(head.trim()).toBe("ref: refs/heads/main");
  });

  test("返回可用的 Repository 实例", () => {
    const repo = initRepository(tempDir);
    expect(repo.gitDir).toBe(join(tempDir, ".git"));
    expect(repo.objects).toBeDefined();
    expect(repo.refs).toBeDefined();
    expect(repo.backend.gitDir).toBe(join(tempDir, ".git"));
  });
});

describe("createRepository()", () => {
  test("基于显式后端创建仓库", () => {
    const backend = createMemoryRepositoryBackend();
    const repo = createRepository(backend);

    expect(repo.backend).toBe(backend);
    expect(repo.objects).toBe(backend.objects);
    expect(repo.refs).toBe(backend.refs);
    expect(repo.packs).toBeNull();
    expect(repo.gitDir).toBeNull();
  });

  test("允许调用方自行组合文件系统后端", () => {
    const tempDir = join(tmpdir(), `nano-git-backend-${Date.now()}-${Math.random()}`);
    mkdirSync(join(tempDir, ".git", "objects"), { recursive: true });
    mkdirSync(join(tempDir, ".git", "refs", "heads"), { recursive: true });
    mkdirSync(join(tempDir, ".git", "refs", "tags"), { recursive: true });
    writeFileSync(join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n");

    try {
      const backend: RepositoryBackend = createFileRepositoryBackend(join(tempDir, ".git"));
      const repo = createRepository(backend);

      expect(repo.backend.gitDir).toBe(join(tempDir, ".git"));
      expect(repo.packs).not.toBeNull();
      expect(repo.getCurrentBranch()).toBe("main");
    } finally {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });
});

describe("openRepository()", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `nano-git-repo-${Date.now()}-${Math.random()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("打开已初始化的仓库", () => {
    initRepository(tempDir);
    const repo = openRepository(tempDir);
    expect(repo.gitDir).toBe(join(tempDir, ".git"));
  });

  test("打开不存在的仓库应抛出异常", () => {
    expect(() => openRepository(tempDir)).toThrow("Not a git repository");
  });
});
