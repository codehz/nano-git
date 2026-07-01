/**
 * 基于 SQLite 的 Refs 存储
 *
 * 所有引用存储在 SQLite 数据库的 refs 表中。
 * 使用 INSERT OR REPLACE 实现幂等写入，使用 db.transaction() 实现事务原子性。
 *
 * 表创建由上层 createSqliteRepositoryBackend 负责，
 * 本模块只操作已存在的表，不负责 DDL。
 */

import { RefNotFoundError, TransactionError } from "../errors.ts";
import { validateRefName, validateRefPrefix } from "./names.ts";

import type { SqliteConnectionHandle } from "../backend/sqlite-pool.ts";
import type {
  RefStore,
  RefTransaction,
  RefTransactionHook,
  ReadonlyRefTransaction,
} from "../types/refs.ts";

/**
 * 创建基于 SQLite 的 RefStore
 *
 * @param conn - SQLite 连接池句柄（含 statement 缓存）
 * @returns 符合 RefStore 接口的存储后端（含事务支持）
 *
 * @example
 * ```ts
 * import { acquireConnection } from "nano-git/backend/sqlite";
 * using conn = acquireConnection("/tmp/repo.sqlite");
 * const store = createSqliteRefStore(conn);
 *
 * store.write("refs/heads/main", "abc123");
 * const content = store.read("refs/heads/main");
 * ```
 */
export function createSqliteRefStore(conn: SqliteConnectionHandle): RefStore {
  // 预编译 SQL 语句（通过 conn.prepare 缓存复用）
  // 注意：bun:sqlite 的 .get() 始终返回行对象，即使是单列查询
  const selectStmt = conn.prepare<{ target: string } | null>(
    "SELECT target FROM refs WHERE name = ?",
  );
  const selectExistsStmt = conn.prepare<{ "1": number }>("SELECT 1 FROM refs WHERE name = ?");
  const insertStmt = conn.prepare<void>("INSERT OR REPLACE INTO refs (name, target) VALUES (?, ?)");
  const deleteStmt = conn.prepare<void>("DELETE FROM refs WHERE name = ?");
  const listPrefixStmt = conn.prepare<{ name: string }>(
    "SELECT name FROM refs WHERE name >= ? AND name < ? ORDER BY name",
  );
  const listAllStmt = conn.prepare<{ name: string }>(
    "SELECT name FROM refs WHERE name LIKE 'refs/%' ORDER BY name",
  );

  // 以下代码通过 closure 引用上述 stmt 变量和 conn.db
  const db = conn.db;

  /**
   * 开启一个新的事务
   *
   * 所有变更暂存于 JS Map，commit() 时通过 SQLite 事务原子性写入。
   */
  function beginTransaction(hooks?: RefTransactionHook[]): RefTransaction {
    const pending = new Map<string, string | null>(); // null = delete mark
    const snapshot = new Map<string, string>();
    // 捕获当前存储状态作为快照
    for (const row of listAllStmt.all()) {
      const val = selectStmt.get(row.name);
      if (val !== null) {
        snapshot.set(row.name, val.target);
      }
    }
    let committed = false;

    return {
      get pendingCount(): number {
        return pending.size;
      },

      write(ref: string, content: string): void {
        if (committed) throw new TransactionError("Transaction already committed");
        validateRefName(ref);
        pending.set(ref, content.trimEnd());
      },

      delete(ref: string): void {
        if (committed) throw new TransactionError("Transaction already committed");
        validateRefName(ref);
        // 检查 ref 在 DB 或 pending 中是否存在
        const inDb = selectExistsStmt.get(ref) !== null;
        const inPending = pending.has(ref);
        if (!inDb && !inPending) {
          throw new RefNotFoundError(ref);
        }
        pending.set(ref, null);
      },

      commit(): void {
        if (committed) throw new TransactionError("Transaction already committed");
        committed = true;

        const txSnapshot = freezePending(pending);

        try {
          for (const hook of hooks ?? []) {
            hook.onPrepare?.(txSnapshot);
          }

          // 在 SQLite 事务中执行所有 pending 变更
          const txFn = db.transaction(() => {
            for (const [ref, content] of pending) {
              if (content === null) {
                // delete：在执行层再次确认存在性
                if (!snapshot.has(ref) && !selectExistsStmt.get(ref)) {
                  throw new RefNotFoundError(ref);
                }
                deleteStmt.run(ref);
              } else {
                insertStmt.run(ref, content);
              }
            }
          });
          txFn();

          for (const hook of hooks ?? []) {
            hook.onCommitted?.(txSnapshot);
          }
        } catch (e) {
          for (const hook of hooks ?? []) {
            hook.onAborted?.(txSnapshot);
          }
          throw e;
        }
      },

      rollback(): void {
        if (committed) return;
        committed = true;

        const txSnapshot = freezePending(pending);
        for (const hook of hooks ?? []) {
          hook.onAborted?.(txSnapshot);
        }
      },
    };
  }

  return {
    read(ref: string): string | null {
      validateRefName(ref);
      const row = selectStmt.get(ref);
      return row?.target ?? null;
    },

    write(ref: string, content: string): void {
      validateRefName(ref);
      insertStmt.run(ref, content.trimEnd());
    },

    delete(ref: string): void {
      validateRefName(ref);
      if (!selectExistsStmt.get(ref)) {
        throw new RefNotFoundError(ref);
      }
      deleteStmt.run(ref);
    },

    list(prefix: string): string[] {
      validateRefPrefix(prefix);
      // 使用字符串范围查询：prefix <= name < prefix + '\x7f'
      const end = prefix + "\x7f";
      return listPrefixStmt.all(prefix, end).map((row) => row.name);
    },

    listAll(): string[] {
      return listAllStmt.all().map((row) => row.name);
    },

    beginTransaction,
  };
}

/**
 * 将 pending Map 冻结为只读快照
 */
function freezePending(pending: Map<string, string | null>): ReadonlyRefTransaction {
  const writes: Array<{ ref: string; content: string }> = [];
  const deletes: Array<{ ref: string }> = [];
  for (const [ref, content] of pending) {
    if (content === null) {
      deletes.push({ ref });
    } else {
      writes.push({ ref, content });
    }
  }
  return Object.freeze({
    pendingCount: pending.size,
    writes: Object.freeze(writes),
    deletes: Object.freeze(deletes),
  });
}
