/**
 * ODB 多后端合同测试基础设施
 *
 * 提供后端矩阵与共享会话类型，
 * 具体合同测试按主题拆分到独立 test 文件。
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openTestSqlite } from "../../../helpers/sqlite.ts";
import { createFileObjectStore } from "@/odb/file.ts";
import { createMemoryObjectStore } from "@/odb/memory.ts";
import { createSqliteObjectStore } from "@/odb/sqlite.ts";

import type { ObjectDatabase } from "@/types/odb.ts";

export interface ObjectDatabaseContractSession {
  readonly store: ObjectDatabase;
  [Symbol.dispose](): void;
}

export interface ObjectDatabaseBackend {
  readonly name: string;
  readonly createStore: () => ObjectDatabaseContractSession;
}

function createMemorySession(): ObjectDatabaseContractSession {
  return {
    store: createMemoryObjectStore(),
    [Symbol.dispose](): void {},
  };
}

function createFileSession(): ObjectDatabaseContractSession {
  const root = mkdtempSync(join(tmpdir(), "nano-git-odb-contract-file-"));
  mkdirSync(root, { recursive: true });
  return {
    store: createFileObjectStore(root),
    [Symbol.dispose](): void {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function createSqliteSession(): ObjectDatabaseContractSession {
  const db = openTestSqlite();
  db.run(
    "CREATE TABLE IF NOT EXISTS objects (hash TEXT PRIMARY KEY, type TEXT NOT NULL, content BLOB NOT NULL)",
  );
  return {
    store: createSqliteObjectStore(db),
    [Symbol.dispose](): void {
      db[Symbol.dispose]();
    },
  };
}

/**
 * ODB 后端矩阵
 *
 * @example
 * ```ts
 * describe.each(objectDatabaseBackends)("$name", ({ createStore }) => {
 *   using session = createStore();
 *   const { store } = session;
 *   expect(store.list()).toEqual([]);
 * });
 * ```
 */
export const objectDatabaseBackends = [
  {
    name: "memory",
    createStore: createMemorySession,
  },
  {
    name: "file",
    createStore: createFileSession,
  },
  {
    name: "sqlite",
    createStore: createSqliteSession,
  },
] satisfies ObjectDatabaseBackend[];
