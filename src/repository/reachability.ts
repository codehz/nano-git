/**
 * 仓库可达性遍历工具
 *
 * 负责从 refs 出发遍历所有可达 Git 对象。
 */

import { HEAD_REF, HEADS_PREFIX, TAGS_PREFIX, resolveRefHash } from "../refs/index.ts";
import type { RefStore } from "../refs/index.ts";
import type { ObjectStore } from "../odb/index.ts";
import type { SHA1 } from "../core/types.ts";

function listRootRefs(refs: RefStore): string[] {
  const rootRefs = new Set<string>([HEAD_REF]);

  for (const ref of refs.listRaw(HEADS_PREFIX)) {
    rootRefs.add(ref);
  }

  for (const ref of refs.listRaw(TAGS_PREFIX)) {
    rootRefs.add(ref);
  }

  return Array.from(rootRefs).sort();
}

function collectReachableObjectHashesFrom(
  objects: ObjectStore,
  hash: SHA1,
  reachable: Set<SHA1>,
): void {
  if (reachable.has(hash)) {
    return;
  }

  reachable.add(hash);
  const obj = objects.read(hash);

  switch (obj.type) {
    case "blob":
      return;
    case "tree":
      for (const entry of obj.entries) {
        collectReachableObjectHashesFrom(objects, entry.hash, reachable);
      }
      return;
    case "commit":
      collectReachableObjectHashesFrom(objects, obj.tree, reachable);
      for (const parent of obj.parents) {
        collectReachableObjectHashesFrom(objects, parent, reachable);
      }
      return;
    case "tag":
      collectReachableObjectHashesFrom(objects, obj.object, reachable);
      return;
  }
}

/**
 * 列出从 HEAD、所有分支和所有标签可达的对象哈希
 *
 * @param objects - 对象存储
 * @param refs - 引用存储
 * @returns 排序后的可达对象哈希列表
 *
 * @example
 * ```ts
 * const hashes = listReachableObjects(objects, refs);
 * console.log(hashes.length);
 * ```
 */
export function listReachableObjects(objects: ObjectStore, refs: RefStore): SHA1[] {
  const reachable = new Set<SHA1>();

  for (const ref of listRootRefs(refs)) {
    const hash = resolveRefHash(refs, ref);
    if (hash) {
      collectReachableObjectHashesFrom(objects, hash, reachable);
    }
  }

  return Array.from(reachable).sort();
}
