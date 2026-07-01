/**
 * SQLite 仓库后端单元测试
 *
 * 覆盖 createSqliteRepositoryBackend 的组合行为。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSqliteRepositoryBackend, type SqliteRepositoryBackend } from "@/backend/sqlite.ts";
import { createRepository } from "@/repository/create.ts";
import { sha1 } from "@/types/index.ts";
import { HEAD_REF } from "@/types/refs.ts";

describe("createSqliteRepositoryBackend()", () => {
  let dbPath: string;
  let backend: SqliteRepositoryBackend;

  beforeEach(() => {
    dbPath = join(tmpdir(), `nano-git-sqlite-backend-${Date.now()}-${Math.random()}.sqlite`);
    backend = createSqliteRepositoryBackend(dbPath);
  });

  afterEach(() => {
    backend[Symbol.dispose]();
    if (existsSync(dbPath)) {
      unlinkSync(dbPath);
    }
  });

  test("返回完整的 RepositoryBackend 接口", () => {
    expect(backend).toHaveProperty("gitDir");
    expect(backend).toHaveProperty("objects");
    expect(backend).toHaveProperty("refs");
    expect(backend).toHaveProperty("shallow");
    expect(backend).toHaveProperty("packs");
    expect(backend.packs).toBeNull();
  });

  test("gitDir 返回数据库文件路径", () => {
    expect(backend.gitDir).toBe(dbPath);
  });

  test("HEAD 引用默认存在并指向 main 分支", () => {
    expect(backend.refs.read(HEAD_REF)).toBe("ref: refs/heads/main");
  });

  test("子 store 通过 backend 正常工作：对象读写", () => {
    const read = backend.objects.read.bind(backend.objects);
    const ingest = backend.objects.ingest.bind(backend.objects);

    const raw = {
      hash: sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"),
      type: "blob" as const,
      content: Buffer.from("hello world"),
    };
    ingest(raw);
    const result = read(raw.hash);
    expect(result.type).toBe("blob");
  });

  test("子 store 通过 backend 正常工作：refs 读写", () => {
    backend.refs.write("refs/heads/feature", "abc123");
    expect(backend.refs.read("refs/heads/feature")).toBe("abc123");
  });

  test("子 store 通过 backend 正常工作：shallow 读写", () => {
    const hash = sha1("0000000000000000000000000000000000000001");
    backend.shallow.write([hash]);
    expect(backend.shallow.isShallow(hash)).toBe(true);
  });

  test("通过 createRepository 可正常使用", () => {
    const repo = createRepository(backend);

    const hash = repo.writeBlob(Buffer.from("hello repo"));

    const obj = repo.catFile(hash);
    expect(obj.type).toBe("blob");
    if (obj.type === "blob") {
      expect(obj.content.toString("utf-8")).toBe("hello repo");
    }
  });

  test("支持 Symbol.dispose 释放数据库连接", () => {
    const backend2 = createSqliteRepositoryBackend(
      join(tmpdir(), `nano-git-sqlite-dispose-${Date.now()}.sqlite`),
    );
    expect(typeof backend2[Symbol.dispose]).toBe("function");
    backend2[Symbol.dispose]();
  });

  test("再次打开同一数据库文件可读取已有数据", () => {
    backend.refs.write("refs/heads/main", "def456");
    const blobHash = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
    backend.objects.ingest({
      hash: blobHash,
      type: "blob",
      content: Buffer.from("hello world"),
    });
    backend[Symbol.dispose]();

    // 重新打开
    const backend2 = createSqliteRepositoryBackend(dbPath);
    try {
      expect(backend2.refs.read("refs/heads/main")).toBe("def456");
      expect(backend2.objects.exists(blobHash)).toBe(true);
    } finally {
      backend2[Symbol.dispose]();
    }
  });

  test("可通过 walMode: false 关闭 WAL 模式", () => {
    const noWalPath = join(tmpdir(), `nano-git-sqlite-nowal-${Date.now()}.sqlite`);
    const noWalBackend = createSqliteRepositoryBackend(noWalPath, { walMode: false });
    try {
      expect(noWalBackend.refs.read(HEAD_REF)).toBe("ref: refs/heads/main");
    } finally {
      noWalBackend[Symbol.dispose]();
      if (existsSync(noWalPath)) unlinkSync(noWalPath);
    }
  });
});
