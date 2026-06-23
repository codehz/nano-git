/**
 * 基于内存的 Refs 存储
 */

import { RefNotFoundError, TransactionError } from "../core/errors.ts";
import { validateRefName, validateRefPrefix } from "./names.ts";

import type {
  RefStore,
  RefTransaction,
  RefTransactionHook,
  ReadonlyRefTransaction,
} from "./types.ts";

/**
 * 创建基于内存的 Refs 存储
 *
 * @example
 * ```ts
 * const store = createMemoryRefStore();
 * ```
 */
export function createMemoryRefStore(initial?: Map<string, string>): RefStore {
  const active = new Map(initial);

  function beginTransaction(hooks?: RefTransactionHook[]): RefTransaction {
    const pending = new Map<string, string | null>(); // null = delete mark
    const snapshot = new Map(active);
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
        if (!active.has(ref) && !pending.has(ref)) {
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

          for (const [ref, content] of pending) {
            if (content === null) {
              if (!active.has(ref)) {
                throw new RefNotFoundError(ref);
              }
              active.delete(ref);
            } else {
              active.set(ref, content);
            }
          }

          for (const hook of hooks ?? []) {
            hook.onCommitted?.(txSnapshot);
          }
        } catch (e) {
          // 回滚：恢复 snapshot
          active.clear();
          for (const [k, v] of snapshot) active.set(k, v);

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
      return active.get(ref) ?? null;
    },

    write(ref: string, content: string): void {
      validateRefName(ref);
      active.set(ref, content.trimEnd());
    },

    delete(ref: string): void {
      validateRefName(ref);
      if (!active.has(ref)) {
        throw new RefNotFoundError(ref);
      }

      active.delete(ref);
    },

    list(prefix: string): string[] {
      validateRefPrefix(prefix);
      return Array.from(active.keys())
        .filter((key) => key.startsWith(prefix))
        .sort();
    },

    listAll(): string[] {
      return Array.from(active.keys())
        .filter((key) => key.startsWith("refs/"))
        .sort();
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
