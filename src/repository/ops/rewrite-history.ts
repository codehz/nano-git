/**
 * 历史重写：规范化 unsorted tree（treeNotSorted）
 *
 * 从 tip refs 出发，记忆化重写：
 * 1. tree：递归映射子 tree，经 serializeTree 自动按 Git 规范排序
 * 2. commit：映射 tree/parents，剥离 gpgsig/mergetag
 * 3. tag：映射目标对象，剥离 gpgsig
 * 4. 更新 tip 变化的具体 ref（符号引用内容本身不改写）
 *
 * dryRun 只 encode 算哈希，不 ingest、不改 refs。
 *
 * @example
 * ```ts
 * import { rewriteHistory } from "./rewrite-history.ts";
 *
 * const result = rewriteHistory(repo.objects, repo.refs);
 * console.log(`rewrote ${result.rewrittenTrees} trees`);
 * ```
 */

import { encodeObject, readObject, tryReadObject, writeObject } from "../../objects/raw.ts";
import { isTreeEntryMode } from "../../objects/tree.ts";
import { resolveRefHash } from "../../refs/resolve.ts";
import { sha1, type GitCommit, type GitTag, type GitTree, type SHA1 } from "../../types/index.ts";
import { listRootRefs } from "./reachability.ts";

import type { ObjectDatabase } from "../../odb/types.ts";
import type { RefStore } from "../../types/refs.ts";
import type {
  DroppedSignature,
  RewriteHistoryOptions,
  RewriteHistoryResult,
  RewrittenObject,
  UpdatedRef,
} from "./rewrite-types.ts";

// ============================================================================
// 公开 API
// ============================================================================

/**
 * 重写历史以修复 unsorted tree
 *
 * @param objects - 对象数据库
 * @param refs - 引用存储
 * @param options - dryRun / refs 覆盖等
 * @returns 重写结果（含 objectMap 与 updatedRefs）
 *
 * @example
 * ```ts
 * // 预览
 * const preview = rewriteHistory(objects, refs, { dryRun: true });
 * // 就地修复
 * const result = rewriteHistory(objects, refs);
 * ```
 */
export function rewriteHistory(
  objects: ObjectDatabase,
  refs: RefStore,
  options?: RewriteHistoryOptions,
): RewriteHistoryResult {
  const dryRun = options?.dryRun ?? false;
  const rootRefs = options?.refs ? [...options.refs] : listRootRefs(refs);

  const cache = new Map<SHA1, SHA1>();
  const objectMap: RewrittenObject[] = [];
  const droppedSignatures: DroppedSignature[] = [];
  let rewrittenTrees = 0;
  let rewrittenCommits = 0;
  let rewrittenTags = 0;

  function recordRewrite(oldHash: SHA1, newHash: SHA1, type: RewrittenObject["type"]): void {
    if (oldHash === newHash) {
      return;
    }
    objectMap.push({ oldHash, newHash, type });
    if (type === "tree") rewrittenTrees++;
    else if (type === "commit") rewrittenCommits++;
    else if (type === "tag") rewrittenTags++;
  }

  function persist(obj: GitTree | GitCommit | GitTag): SHA1 {
    if (dryRun) {
      return encodeObject(obj).hash;
    }
    return writeObject(objects, obj);
  }

  function mapObject(hash: SHA1): SHA1 {
    const cached = cache.get(hash);
    if (cached !== undefined) {
      return cached;
    }

    const obj = tryReadObject(objects, hash);
    if (obj === undefined) {
      // shallow / 缺失：保持原哈希，不进入缓存以免误伤后续存在对象
      return hash;
    }

    let mapped: SHA1;
    switch (obj.type) {
      case "blob":
        mapped = hash;
        break;
      case "tree":
        mapped = mapTree(hash, obj);
        break;
      case "commit":
        mapped = mapCommit(hash, obj);
        break;
      case "tag":
        mapped = mapTag(hash, obj);
        break;
    }

    cache.set(hash, mapped);
    return mapped;
  }

  function mapTree(hash: SHA1, obj: GitTree): SHA1 {
    const entries = obj.entries.map((entry) => {
      if (!isTreeEntryMode(entry.mode)) {
        // blob / symlink / gitlink：内容不动
        return entry;
      }
      const childHash = mapObject(entry.hash);
      if (childHash === entry.hash) {
        return entry;
      }
      return { mode: entry.mode, name: entry.name, hash: childHash };
    });

    // serializeTree 会按 Git 规范排序；即使子树未变，乱序条目也会得到新哈希
    const newHash = persist({ type: "tree", entries });
    recordRewrite(hash, newHash, "tree");
    return newHash;
  }

  function mapCommit(hash: SHA1, obj: GitCommit): SHA1 {
    const newTree = mapObject(obj.tree);
    const newParents = obj.parents.map((parent) => mapObject(parent));

    const dropGpg = obj.gpgsig !== undefined;
    const dropMergeTags = (obj.mergetag?.length ?? 0) > 0;
    if (dropGpg) {
      droppedSignatures.push({ hash, type: "commit", kind: "gpgsig" });
    }
    if (dropMergeTags) {
      droppedSignatures.push({ hash, type: "commit", kind: "mergetag" });
    }

    const parentsUnchanged =
      newParents.length === obj.parents.length &&
      newParents.every((parent, index) => parent === obj.parents[index]);

    if (newTree === obj.tree && parentsUnchanged && !dropGpg && !dropMergeTags) {
      return hash;
    }

    const rewritten: GitCommit = {
      type: "commit",
      tree: newTree,
      parents: newParents,
      author: obj.author,
      committer: obj.committer,
      message: obj.message,
      encoding: obj.encoding,
      extraHeaders: obj.extraHeaders,
      // 签名字段剥离
    };

    const newHash = persist(rewritten);
    recordRewrite(hash, newHash, "commit");
    return newHash;
  }

  function mapTag(hash: SHA1, obj: GitTag): SHA1 {
    const newTarget = mapObject(obj.object);
    const dropGpg = obj.gpgsig !== undefined;
    if (dropGpg) {
      droppedSignatures.push({ hash, type: "tag", kind: "gpgsig" });
    }

    if (newTarget === obj.object && !dropGpg) {
      return hash;
    }

    const rewritten: GitTag = {
      type: "tag",
      object: newTarget,
      objectType: obj.objectType,
      tag: obj.tag,
      tagger: obj.tagger,
      message: obj.message,
      extraHeaders: obj.extraHeaders,
    };

    const newHash = persist(rewritten);
    recordRewrite(hash, newHash, "tag");
    return newHash;
  }

  // ---- 1. 映射所有 tip ----
  const tipByRef = new Map<string, { oldHash: SHA1; newHash: SHA1 }>();
  for (const ref of rootRefs) {
    const oldHash = resolveRefHash(refs, ref);
    if (oldHash === null) {
      continue;
    }
    const newHash = mapObject(oldHash);
    tipByRef.set(ref, { oldHash, newHash });
  }

  // ---- 2. 计算需要更新的具体 ref（跳过符号引用内容）----
  const updatedRefs: UpdatedRef[] = [];
  for (const ref of rootRefs) {
    const tip = tipByRef.get(ref);
    if (!tip || tip.oldHash === tip.newHash) {
      continue;
    }

    const content = refs.read(ref);
    if (content === null || content.startsWith("ref: ")) {
      // 符号引用：只依赖目标具体 ref 被更新；detached 以外的 HEAD 不改写
      continue;
    }

    // 具体 ref 的存储内容应是 tip 哈希
    const storedHash = sha1(content);
    if (storedHash !== tip.oldHash) {
      // 理论上 resolve 与直接内容一致；不一致时仍以 resolve 结果为准更新
    }

    updatedRefs.push({
      ref,
      oldHash: tip.oldHash,
      newHash: tip.newHash,
    });
  }

  // ---- 3. 应用 ref 更新 ----
  if (!dryRun && updatedRefs.length > 0) {
    const tx = refs.beginTransaction();
    try {
      for (const update of updatedRefs) {
        tx.write(update.ref, update.newHash);
      }
      tx.commit();
    } catch (err: unknown) {
      tx.rollback();
      throw err;
    }
  }

  return {
    dryRun,
    rewrittenTrees,
    rewrittenCommits,
    rewrittenTags,
    objectMap,
    updatedRefs,
    droppedSignatures,
  };
}
