/**
 * Push 策略规则
 *
 * 处理"这些 ref 更新是否合法"的问题：
 * - fast-forward 预检
 * - refs/tags/* 更新限制
 * - non-commit 对象推送限制
 *
 * 纯规则层，不依赖协议细节。
 *
 * @example
 * ```ts
 * import { checkFastForward } from "./push-policy.ts";
 * const items = [{
 *   localRef: "refs/heads/main",
 *   remoteRef: "refs/heads/main",
 *   localHash: sha1("new"),
 *   remoteHash: sha1("old"),
 *   force: false,
 * }];
 * checkFastForward(store, items);
 * ```
 */

import { isAncestor, peelTagChain } from "../../shared/object-graph.ts";
import { PushError } from "./push-error.ts";

import type { SHA1 } from "../../../core/types.ts";
import type { ObjectStore } from "../../../odb/types.ts";
import type { PushRefItem } from "./push-ref-plan.ts";

/**
 * 预检所有推送项是否为 fast-forward，不通过的（且未设 force）立即报错
 *
 * @param store - 对象存储
 * @param items - 推送引用项列表
 * @param shallowBoundaries - 已知 shallow 边界集合（可选）
 *   提供后，isAncestor 会优先判断缺失 parent 是否为已知 shallow boundary，
 *   避免在 shallow 仓库中将正常边界缺失误判为损坏。
 *
 * @throws PushError 如果存在 non-fast-forward 更新且未设 force
 */
export function checkFastForward(
  store: ObjectStore,
  items: PushRefItem[],
  shallowBoundaries?: Set<SHA1>,
): void {
  for (const item of items) {
    // 删除操作（newHash === null）或新建操作（remoteHash === null）总是安全
    if (item.localHash === null || item.remoteHash === null) {
      continue;
    }

    // force 跳过预检
    if (item.force) {
      continue;
    }

    // 相同哈希（已是最新，no-op）总是安全
    if (item.localHash === item.remoteHash) {
      continue;
    }

    // Git 语义：refs/tags/* 不允许任何替换（即使是 fast-forward），必须显式 force
    if (item.remoteRef.startsWith("refs/tags/")) {
      throw new PushError(
        `Tag update rejected for "${item.remoteRef}": ` +
          `tag already exists, cannot replace without force (--force or +refspec).`,
      );
    }

    // Non-commit 对象检查：fast-forward 概念只适用于 commit 对象。
    // 如果 remote 或 local 解引用后不是 commit，必须使用 --force。
    const peeledRemote = peelTagChain(store, item.remoteHash, shallowBoundaries);
    const peeledLocal = peelTagChain(store, item.localHash, shallowBoundaries);

    {
      const remoteObj = store.tryRead(peeledRemote);
      if (remoteObj !== undefined && remoteObj.type !== "commit") {
        throw new PushError(
          `Update rejected for "${item.remoteRef}": ` +
            `remote object is a ${remoteObj.type}, expected commit. ` +
            `Use --force or +refspec to override.`,
        );
      }
    }

    {
      const localObj = store.tryRead(peeledLocal);
      if (localObj !== undefined && localObj.type !== "commit") {
        throw new PushError(
          `Update rejected for "${item.remoteRef}": ` +
            `local object is a ${localObj.type}, expected commit. ` +
            `Use --force or +refspec to override.`,
        );
      }
    }

    // 构建逐 ref 的独立边界集，仅包含本 ref 的远端 tip。
    // 注意：此处不传递全局 shallowBoundaries 给 isAncestor，因为
    // isAncestor 的"遇到边界即放行"语义对 push fast-forward 预检来说
    // 过于宽松——任意缺失祖先只要落在边界集合中就会被错误放行。
    // 只有本 ref 自身的 remoteHash 才是合法的缺失边界（服务端持有它，
    // 且它在祖先链上就等于找到 peeledOld）。
    const refBoundaries = new Set<SHA1>();
    if (item.remoteHash) {
      refBoundaries.add(item.remoteHash);
    }

    if (!isAncestor(store, item.remoteHash, item.localHash, refBoundaries)) {
      const shortRemote = item.remoteHash.slice(0, 8);
      const shortLocal = item.localHash.slice(0, 8);
      throw new PushError(
        `Non-fast-forward update rejected for "${item.remoteRef}": ` +
          `remote ${shortRemote} is not an ancestor of local ${shortLocal}. ` +
          `Use force (--force or +refspec) to override.`,
      );
    }
  }
}
