/**
 * SQLite 仓库后端单元测试
 *
 * 覆盖 createSqliteRepositoryBackend 的组合行为。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bytes, bytesToUtf8 } from "../../helpers/bytes.ts";
import { openTestSqlite } from "../../helpers/sqlite.ts";
import { createSqliteRepositoryBackend } from "@/backend/sqlite.ts";
import { createRepository } from "@/repository/create.ts";
import { sha1 } from "@/types/index.ts";
import { HEAD_REF } from "@/types/refs.ts";

import type { RepositoryBackend } from "@/backend/types.ts";
import type { SqliteDatabase } from "@/types/sqlite.ts";

describe("createSqliteRepositoryBackend()", () => {
  let dbPath: string;
  let db: SqliteDatabase & Disposable;
  let backend: RepositoryBackend;

  beforeEach(() => {
    dbPath = join(tmpdir(), `nano-git-sqlite-backend-${Date.now()}-${Math.random()}.sqlite`);
    db = openTestSqlite(dbPath);
    backend = createSqliteRepositoryBackend(db, { gitDir: dbPath });
  });

  afterEach(() => {
    db[Symbol.dispose]();
    if (existsSync(dbPath)) {
      unlinkSync(dbPath);
    }
  });

  test("返回核心 RepositoryBackend 接口", () => {
    expect(backend).toHaveProperty("gitDir");
    expect(backend).toHaveProperty("objects");
    expect(backend).toHaveProperty("refs");
    expect(backend).toHaveProperty("shallow");
    expect(backend).not.toHaveProperty("packs");
  });

  test("gitDir 默认空字符串，也可显式传入", () => {
    expect(backend.gitDir).toBe(dbPath);
    using mem = openTestSqlite();
    expect(createSqliteRepositoryBackend(mem).gitDir).toBe("");
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
      content: bytes("hello world"),
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

    const hash = repo.writeBlob(bytes("hello repo"));

    const obj = repo.catFile(hash);
    expect(obj.type).toBe("blob");
    if (obj.type === "blob") {
      expect(bytesToUtf8(obj.content)).toBe("hello repo");
    }
  });

  test("关闭后再打开同一数据库文件可读取已有数据", () => {
    backend.refs.write("refs/heads/main", "def456");
    const blobHash = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
    backend.objects.ingest({
      hash: blobHash,
      type: "blob",
      content: bytes("hello world"),
    });
    db[Symbol.dispose]();

    using db2 = openTestSqlite(dbPath);
    const backend2 = createSqliteRepositoryBackend(db2, { gitDir: dbPath });
    expect(backend2.refs.read("refs/heads/main")).toBe("def456");
    expect(backend2.objects.exists(blobHash)).toBe(true);
  });
});
