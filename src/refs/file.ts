/**
 * 基于文件系统的 Refs 存储
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { join, dirname } from "node:path";

import { RefNotFoundError, TransactionError } from "../core/errors.ts";
import { listLooseRefsRecursive } from "./fs-utils.ts";
import { validateRefName, validateRefPrefix } from "./names.ts";

import type {
  RefStore,
  RefTransaction,
  RefTransactionHook,
  ReadonlyRefTransaction,
} from "../core/types/refs.ts";

function readPackedRefs(gitDir: string): Map<string, string> {
  const packedRefsPath = join(gitDir, "packed-refs");
  if (!existsSync(packedRefsPath)) {
    return new Map<string, string>();
  }

  const packedRefs = new Map<string, string>();
  const lines = readFileSync(packedRefsPath, "utf-8").split("\n");

  for (const line of lines) {
    if (!line || line.startsWith("#") || line.startsWith("^")) {
      continue;
    }

    const spaceIndex = line.indexOf(" ");
    if (spaceIndex === -1) {
      continue;
    }

    const hash = line.slice(0, spaceIndex);
    const ref = line.slice(spaceIndex + 1);
    packedRefs.set(ref, hash);
  }

  return packedRefs;
}

/**
 * 从 packed-refs 中删除指定引用
 *
 * 会同时删除该引用可能携带的 peeled 行（`^...`）。
 *
 * @param gitDir - Git 目录
 * @param ref - 完整引用路径
 * @returns 是否实际删除了 packed-refs 条目
 */
function deletePackedRef(gitDir: string, ref: string): boolean {
  const packedRefsPath = join(gitDir, "packed-refs");
  if (!existsSync(packedRefsPath)) {
    return false;
  }

  const originalContent = readFileSync(packedRefsPath, "utf-8");
  const lines = originalContent.split("\n");
  const keptLines: string[] = [];
  let removed = false;
  let skipNextPeeledLine = false;

  for (const line of lines) {
    if (skipNextPeeledLine && line.startsWith("^")) {
      skipNextPeeledLine = false;
      removed = true;
      continue;
    }
    skipNextPeeledLine = false;

    if (line.length === 0 || line.startsWith("#")) {
      keptLines.push(line);
      continue;
    }

    const spaceIndex = line.indexOf(" ");
    if (spaceIndex === -1) {
      keptLines.push(line);
      continue;
    }

    const packedRef = line.slice(spaceIndex + 1);
    if (packedRef === ref) {
      removed = true;
      skipNextPeeledLine = true;
      continue;
    }

    keptLines.push(line);
  }

  if (!removed) {
    return false;
  }

  writeFileSync(packedRefsPath, keptLines.join("\n"));
  return true;
}

/**
 * 创建基于文件系统的 Refs 存储
 *
 * @example
 * ```ts
 * const store = createFileRefStore("/path/to/repo/.git");
 * ```
 */
// ============================================================================
// Lock 文件管理
// ============================================================================

/**
 * Lock 文件路径
 */
function lockPath(gitDir: string, ref: string): string {
  return join(gitDir, ref) + ".lock";
}

/**
 * 创建 Lock 文件（占位）
 *
 * 如果 lock 文件已存在，说明有并发写入或残留 lock，抛出异常。
 */
function createLockFile(gitDir: string, ref: string): string {
  const lock = lockPath(gitDir, ref);
  const dir = dirname(lock);
  mkdirSync(dir, { recursive: true });

  if (existsSync(lock)) {
    throw new TransactionError(
      `Cannot lock ref "${ref}": lock file already exists. ` +
        "This may indicate a concurrent write or a stale lock file.",
    );
  }

  writeFileSync(lock, "");
  return lock;
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

// ============================================================================
// Factory
// ============================================================================

export function createFileRefStore(gitDir: string): RefStore {
  function beginTransaction(hooks?: RefTransactionHook[]): RefTransaction {
    const pending = new Map<string, string | null>(); // null = delete mark
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
        const refPath = join(gitDir, ref);
        const hasLooseRef = existsSync(refPath);
        const hasPackedRef = readPackedRefs(gitDir).has(ref);
        if (!hasLooseRef && !hasPackedRef && !pending.has(ref)) {
          throw new RefNotFoundError(ref);
        }
        pending.set(ref, null);
      },

      commit(): void {
        if (committed) throw new TransactionError("Transaction already committed");
        committed = true;

        const txSnapshot = freezePending(pending);

        // 创建所有 lock 文件
        const locks: string[] = [];
        try {
          for (const refName of pending.keys()) {
            const lock = createLockFile(gitDir, refName);
            locks.push(lock);
          }

          // onPrepare hook
          for (const hook of hooks ?? []) {
            hook.onPrepare?.(txSnapshot);
          }

          // 写入 lock 文件内容
          let idx = 0;
          for (const [, content] of pending) {
            const lock = locks[idx]!;
            idx++;
            if (content === null) {
              // delete: 空 lock 文件即可
              writeFileSync(lock, "");
            } else {
              writeFileSync(lock, `${content}\n`);
            }
          }

          // rename lock → ref（原子切换）
          idx = 0;
          for (const [ref, content] of pending) {
            const lock = locks[idx]!;
            idx++;
            const target = join(gitDir, ref);

            if (content === null) {
              // 删除：删 ref 文件和 packed-refs 条目
              if (existsSync(target)) {
                unlinkSync(target);
              }
              deletePackedRef(gitDir, ref);
              unlinkSync(lock);
            } else {
              mkdirSync(dirname(target), { recursive: true });
              renameSync(lock, target);
              // 写入 loose ref 后清理 packed-refs 条目
              deletePackedRef(gitDir, ref);
            }
          }

          // onCommitted hook
          for (const hook of hooks ?? []) {
            hook.onCommitted?.(txSnapshot);
          }
        } catch (e) {
          // 清理所有 lock 文件
          for (const lock of locks) {
            try {
              if (existsSync(lock)) unlinkSync(lock);
            } catch {
              /* best-effort */
            }
          }

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
      const refPath = join(gitDir, ref);
      if (existsSync(refPath)) {
        return readFileSync(refPath, "utf-8").trimEnd();
      }

      return readPackedRefs(gitDir).get(ref) ?? null;
    },

    write(ref: string, content: string): void {
      validateRefName(ref);
      const refPath = join(gitDir, ref);
      mkdirSync(dirname(refPath), { recursive: true });
      writeFileSync(refPath, `${content.trimEnd()}\n`);
    },

    delete(ref: string): void {
      validateRefName(ref);
      const refPath = join(gitDir, ref);
      const hasLooseRef = existsSync(refPath);
      const removedPackedRef = deletePackedRef(gitDir, ref);

      if (!hasLooseRef && !removedPackedRef) {
        throw new RefNotFoundError(ref);
      }

      if (hasLooseRef) {
        unlinkSync(refPath);
      }
    },

    list(prefix: string): string[] {
      validateRefPrefix(prefix);
      const baseDir = join(gitDir, prefix);
      const refs = new Set<string>();

      if (existsSync(baseDir)) {
        for (const ref of listLooseRefsRecursive(baseDir, prefix)) {
          refs.add(ref);
        }
      }

      for (const ref of readPackedRefs(gitDir).keys()) {
        if (ref.startsWith(prefix)) {
          refs.add(ref);
        }
      }

      return Array.from(refs).sort();
    },

    listAll(): string[] {
      const refs = new Set<string>();
      const refsDir = join(gitDir, "refs");

      if (existsSync(refsDir)) {
        for (const ref of listLooseRefsRecursive(refsDir, "refs/")) {
          refs.add(ref);
        }
      }

      for (const ref of readPackedRefs(gitDir).keys()) {
        if (ref.startsWith("refs/")) {
          refs.add(ref);
        }
      }

      return Array.from(refs).sort();
    },

    beginTransaction,
  };
}
