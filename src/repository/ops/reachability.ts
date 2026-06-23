/**
 * 仓库可达性遍历工具
 *
 * 负责从 refs 出发遍历所有可达 Git 对象。
 */

import { resolveRefHash } from "../../refs/resolve.ts";
import { HEAD_REF, HEADS_PREFIX, TAGS_PREFIX } from "../../refs/types.ts";

import type { SHA1 } from "../../core/types.ts";
import type { ObjectDatabase } from "../../odb/types.ts";
import type { RefStore } from "../../refs/types.ts";

function listRootRefs(refs: RefStore): string[] {
  const rootRefs = new Set<string>([HEAD_REF]);

  for (const ref of refs.list(HEADS_PREFIX)) {
    rootRefs.add(ref);
  }

  for (const ref of refs.list(TAGS_PREFIX)) {
    rootRefs.add(ref);
  }

  return Array.from(rootRefs).sort();
}

function collectReachableObjectHashesFrom(
  objects: ObjectDatabase,
  hash: SHA1,
  reachable: Set<SHA1>,
): void {
  const stack: SHA1[] = [hash];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (reachable.has(current)) {
      continue;
    }
    reachable.add(current);

    const obj = objects.read(current);

    switch (obj.type) {
      case "blob":
        break;
      case "tree":
        for (const entry of obj.entries) {
          if (!reachable.has(entry.hash)) {
            stack.push(entry.hash);
          }
        }
        break;
      case "commit":
        if (!reachable.has(obj.tree)) {
          stack.push(obj.tree);
        }
        for (const parent of obj.parents) {
          if (!reachable.has(parent)) {
            stack.push(parent);
          }
        }
        break;
      case "tag":
        if (!reachable.has(obj.object)) {
          stack.push(obj.object);
        }
        break;
    }
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
export function listReachableObjects(objects: ObjectDatabase, refs: RefStore): SHA1[] {
  const reachable = new Set<SHA1>();

  for (const ref of listRootRefs(refs)) {
    const hash = resolveRefHash(refs, ref);
    if (hash) {
      collectReachableObjectHashesFrom(objects, hash, reachable);
    }
  }

  return Array.from(reachable).sort();
}
