/**
 * 应用本地 ref 更新
 *
 * 根据 RefUpdatePlanItem[] 应用 ref 更新，执行 fast-forward / tag / object-type 校验，
 * 返回成功更新与拒绝更新明细。
 *
 * @example
 * ```ts
 * const result = applyRefUpdates(store, refs, plan.updates);
 * console.log(`Updated ${result.updatedRefs.size} refs`);
 * ```
 */

import { GitError } from "../../errors.ts";
import { tryReadObject } from "../../objects/raw.ts";
import { isAncestor } from "./object-graph.ts";

import type { ObjectDatabase } from "../../odb/types.ts";
import type { SHA1 } from "../../types/index.ts";
import type { RefStore } from "../../types/refs.ts";
import type { ApplyRefUpdatesResult, RefUpdateRejection, RemoteRef } from "./types.ts";

/**
 * Ref 更新计划项
 *
 * 表示一个需要执行的本地 ref 写操作。
 */
export interface RefUpdatePlanItem {
  readonly remoteRef: RemoteRef;
  readonly localRef: string;
  readonly currentLocalHash?: SHA1;
  readonly force: boolean;
}

// ============================================================================
// 错误类型
// ============================================================================

/**
 * Ref 更新错误
 */
export class RefUpdateError extends GitError {
  constructor(message: string) {
    super(`Ref update error: ${message}`);
    this.name = "RefUpdateError";
  }
}

// ============================================================================
// 校验
// ============================================================================

/**
 * 校验远程 ref 对象可写入 refs/heads/*
 *
 * refs/heads/* 只能指向 commit 对象。
 *
 * @param store - 对象存储
 * @param hash - 远程引用哈希
 * @param refName - 远程引用名称（仅用于错误消息）
 * @returns 可用于写入 refs/heads/* 的哈希
 * @throws RefUpdateError 如果目标对象不存在或不是 commit
 */
export function resolveBranchTargetHash(store: ObjectDatabase, hash: SHA1, refName: string): SHA1 {
  const obj = tryReadObject(store, hash);
  if (obj === undefined) {
    throw new RefUpdateError(
      `Object ${hash} for remote ref "${refName}" is missing from the local store. ` +
        `refs/heads/* can only point to commit objects.`,
    );
  }

  if (obj.type === "tag") {
    throw new RefUpdateError(
      `Remote ref "${refName}" (${hash}) is a tag object, ` +
        `expected commit. refs/heads/* can only point to commit objects.`,
    );
  }

  if (obj.type !== "commit") {
    throw new RefUpdateError(
      `Remote ref "${refName}" (${hash}) is a ${obj.type}, ` +
        `expected commit. refs/heads/* can only point to commit objects.`,
    );
  }

  return hash;
}

/**
 * 判断指定 ref 是否属于需要 fast-forward 检查的命名空间
 *
 * Git fetch 语义：仅 refs/heads/* 在没有 + 的 refspec 下要求新 tip 必须是
 * 旧 tip 的子孙（快进）。
 */
export function isRefNamespaceRequiringFastForward(refName: string): boolean {
  return refName.startsWith("refs/heads/");
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 应用 ref 更新
 *
 * 根据更新计划逐条应用 ref 更新，执行以下校验：
 * - wanted tip 对象存在性校验
 * - refs/heads/* 的 commit 类型校验
 * - refs/tags/* 的非 force 拒绝替换
 * - refs/heads/* 的非 force fast-forward 检查
 *
 * @param store - 对象存储（用于校验对象存在性和类型）
 * @param refs - 本地引用存储
 * @param updates - ref 更新计划项列表
 * @returns 更新结果（成功和拒绝列表）
 *
 * @example
 * ```ts
 * const result = applyRefUpdates(objects, refs, plan.updates);
 * for (const [ref, hash] of result.updatedRefs) {
 *   console.log(`Updated ${ref} -> ${hash}`);
 * }
 * ```
 */
export function applyRefUpdates(
  store: ObjectDatabase,
  refs: RefStore,
  updates: RefUpdatePlanItem[],
): ApplyRefUpdatesResult {
  const committedUpdates: Array<{ localRef: string; writeHash: SHA1 }> = [];
  const rejectedRefs: RefUpdateRejection[] = [];
  const rejectedSet = new Set<string>();

  // 先校验所有 wanted tip 的对象都存在
  for (const item of updates) {
    if (!store.exists(item.remoteRef.hash)) {
      rejectedRefs.push({
        localRef: item.localRef,
        reason: `Object ${item.remoteRef.hash} was advertised but not received in the packfile`,
      });
      rejectedSet.add(item.localRef);
      continue;
    }
  }

  // 校验类型和 fast-forward 约束，收集可提交的更新
  for (const item of updates) {
    const { remoteRef, localRef, currentLocalHash, force } = item;

    if (rejectedSet.has(localRef)) continue;

    const writeHash = localRef.startsWith("refs/heads/")
      ? resolveBranchTargetHash(store, remoteRef.hash, remoteRef.name)
      : remoteRef.hash;

    if (!force && currentLocalHash !== undefined) {
      if (localRef.startsWith("refs/tags/")) {
        rejectedRefs.push({
          localRef,
          reason: `Tag "${localRef}" already exists and force is not set`,
        });
        continue;
      }

      if (
        isRefNamespaceRequiringFastForward(localRef) &&
        !isAncestor(store, currentLocalHash, writeHash)
      ) {
        rejectedRefs.push({
          localRef,
          reason: `Non-fast-forward update rejected for "${localRef}"`,
        });
        continue;
      }
    }

    committedUpdates.push({ localRef, writeHash });
  }

  // 事务内原子写入所有已校验的 ref 更新
  const tx = refs.beginTransaction();
  try {
    for (const { localRef, writeHash } of committedUpdates) {
      tx.write(localRef, writeHash);
    }
    tx.commit();
  } catch (e) {
    tx.rollback();
    throw e;
  }

  const updatedRefs = new Map(committedUpdates.map((u) => [u.localRef, u.writeHash]));
  return { updatedRefs, rejectedRefs };
}
