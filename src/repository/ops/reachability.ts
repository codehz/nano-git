/**
 * 仓库可达性遍历工具
 *
 * 负责从 refs 出发遍历所有可达 Git 对象。
 */

import { HEAD_REF, HEADS_PREFIX, TAGS_PREFIX } from "../../core/types/refs.ts";
import { readObject } from "../../objects/raw.ts";
import { resolveRefHash } from "../../refs/resolve.ts";

import type { SHA1 } from "../../core/types.ts";
import type { RefStore } from "../../core/types/refs.ts";
import type { ObjectSource } from "../../odb/types.ts";

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
  source: ObjectSource,
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

    const obj = readObject(source, current);

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
 * @param source - 对象源
 * @param refs - 引用存储
 * @returns 排序后的可达对象哈希列表
 *
 * @example
 * ```ts
 * const hashes = listReachableObjects(source, refs);
 * console.log(hashes.length);
 * ```
 */
export function listReachableObjects(source: ObjectSource, refs: RefStore): SHA1[] {
  const reachable = new Set<SHA1>();

  for (const ref of listRootRefs(refs)) {
    const hash = resolveRefHash(refs, ref);
    if (hash) {
      collectReachableObjectHashesFrom(source, hash, reachable);
    }
  }

  return Array.from(reachable).sort();
}
