/**
 * 基于文件系统的 Refs 存储
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { join, dirname } from "node:path";

import { RefNotFoundError, TransactionError } from "../errors.ts";
import { listLooseRefsRecursive } from "./fs-utils.ts";
import { validateRefName, validateRefPrefix } from "./names.ts";

import type {
  RefStore,
  RefTransaction,
  RefTransactionHook,
  ReadonlyRefTransaction,
} from "../types/refs.ts";

interface ParsedPackedRefs {
  readonly refs: Map<string, string>;
  readonly lines: readonly string[];
}

interface PackedRefsCacheEntry extends ParsedPackedRefs {
  readonly statKey: string | null;
}

function parsePackedRefs(content: string): ParsedPackedRefs {
  const packedRefs = new Map<string, string>();
  const lines = content.split("\n");

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

  return {
    refs: packedRefs,
    lines,
  };
}

/**
 * 从 packed-refs 中移除一批指定引用
 *
 * 会同时删除目标引用可能携带的 peeled 行（`^...`）。
 *
 * @param lines - packed-refs 原始行
 * @param refs - 需要删除的完整引用路径集合
 * @returns 是否实际删除了条目，以及删除后的完整文本
 */
function filterPackedRefsLines(
  lines: readonly string[],
  refs: ReadonlySet<string>,
): { readonly removed: boolean; readonly content: string } {
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
    if (refs.has(packedRef)) {
      removed = true;
      skipNextPeeledLine = true;
      continue;
    }

    keptLines.push(line);
  }

  return {
    removed,
    content: keptLines.join("\n"),
  };
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
  const packedRefsPath = join(gitDir, "packed-refs");
  let packedRefsCache: PackedRefsCacheEntry | null = null;

  function invalidatePackedRefsCache(): void {
    packedRefsCache = null;
  }

  function getPackedRefsStatKey(): string | null {
    try {
      const stat = statSync(packedRefsPath);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "string" &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }
  }

  function readPackedRefsSnapshot(): PackedRefsCacheEntry {
    const statKey = getPackedRefsStatKey();
    if (packedRefsCache !== null && packedRefsCache.statKey === statKey) {
      return packedRefsCache;
    }

    if (statKey === null) {
      packedRefsCache = {
        statKey: null,
        refs: new Map<string, string>(),
        lines: [],
      };
      return packedRefsCache;
    }

    const parsed = parsePackedRefs(readFileSync(packedRefsPath, "utf-8"));
    packedRefsCache = {
      statKey,
      refs: parsed.refs,
      lines: parsed.lines,
    };
    return packedRefsCache;
  }

  function deletePackedRefs(refs: ReadonlySet<string>): boolean {
    if (refs.size === 0) {
      return false;
    }

    const snapshot = readPackedRefsSnapshot();
    if (snapshot.lines.length === 0) {
      return false;
    }

    const filtered = filterPackedRefsLines(snapshot.lines, refs);
    if (!filtered.removed) {
      return false;
    }

    writeFileSync(packedRefsPath, filtered.content);
    invalidatePackedRefsCache();
    return true;
  }

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
        const hasPackedRef = readPackedRefsSnapshot().refs.has(ref);
        if (!hasLooseRef && !hasPackedRef && !pending.has(ref)) {
          throw new RefNotFoundError(ref);
        }
        pending.set(ref, null);
      },

      commit(): void {
        if (committed) throw new TransactionError("Transaction already committed");
        committed = true;

        const txSnapshot = freezePending(pending);
        const packedRefsToDelete = new Set(pending.keys());

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
              unlinkSync(lock);
            } else {
              mkdirSync(dirname(target), { recursive: true });
              renameSync(lock, target);
            }
          }

          deletePackedRefs(packedRefsToDelete);

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

      return readPackedRefsSnapshot().refs.get(ref) ?? null;
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
      const removedPackedRef = deletePackedRefs(new Set([ref]));

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

      for (const ref of readPackedRefsSnapshot().refs.keys()) {
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

      for (const ref of readPackedRefsSnapshot().refs.keys()) {
        if (ref.startsWith("refs/")) {
          refs.add(ref);
        }
      }

      return Array.from(refs).sort();
    },

    beginTransaction,
  };
}
