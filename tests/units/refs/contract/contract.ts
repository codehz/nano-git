/**
 * Refs 多后端合同测试基础设施
 *
 * 提供后端矩阵与共享会话类型，
 * 具体合同测试按主题拆分到独立 test 文件。
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireConnection } from "@/backend/sqlite-pool.ts";
import { createFileRefStore } from "@/refs/file.ts";
import { createMemoryRefStore } from "@/refs/memory.ts";
import { createSqliteRefStore } from "@/refs/sqlite.ts";

import type { RefStore } from "@/core/types/refs.ts";

export interface RefStoreContractSession {
  readonly store: RefStore;
  [Symbol.dispose](): void;
}

export interface RefStoreBackend {
  readonly name: string;
  readonly createStore: () => RefStoreContractSession;
}

function createMemorySession(): RefStoreContractSession {
  return {
    store: createMemoryRefStore(),
    [Symbol.dispose](): void {},
  };
}

function createFileSession(): RefStoreContractSession {
  const root = mkdtempSync(join(tmpdir(), "nano-git-refs-contract-file-"));
  mkdirSync(root, { recursive: true });
  return {
    store: createFileRefStore(root),
    [Symbol.dispose](): void {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function createSqliteSession(): RefStoreContractSession {
  const conn = acquireConnection(":memory:");
  conn.db.run("CREATE TABLE IF NOT EXISTS refs (name TEXT PRIMARY KEY, target TEXT NOT NULL)");
  return {
    store: createSqliteRefStore(conn),
    [Symbol.dispose](): void {
      conn.release();
    },
  };
}

/**
 * RefStore 后端矩阵
 *
 * @example
 * ```ts
 * describe.each(refStoreBackends)("$name", ({ createStore }) => {
 *   using session = createStore();
 *   expect(session.store.listAll()).toEqual([]);
 * });
 * ```
 */
export const refStoreBackends = [
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
] satisfies RefStoreBackend[];
