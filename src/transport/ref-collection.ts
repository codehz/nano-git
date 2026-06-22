/**
 * 本地/远程引用收集
 *
 * 提供从 RefStore 收集本地 ref hash map 以及将远程 advertisement 转 map 的中立基础设施。
 * 不带 fetch/push 语义。
 *
 * @example
 * ```ts
 * import { getLocalRefs, remoteRefsToMap } from "./ref-collection.ts";
 *
 * const localRefs = getLocalRefs(refStore);
 * const remoteMap = remoteRefsToMap(advertisement.refs);
 * ```
 */

import { sha1 } from "../core/types.ts";
import { resolveRefHash } from "../refs/resolve.ts";
import { HEAD_REF } from "../refs/types.ts";

import type { SHA1 } from "../core/types.ts";
import type { RefStore } from "../refs/types.ts";

/**
 * 获取本地 refs 的哈希映射
 *
 * 扫描 refs/ 下所有命名空间的引用，确保任意自定义目标命名空间
 *（如 refs/mirrors/、refs/remotes/ 等）都能被正确检测到。
 *
 * @param refs - 本地引用存储
 * @returns ref 名称 → SHA1 哈希的映射
 *
 * @example
 * ```ts
 * const refs = getLocalRefs(refStore);
 * console.log(refs.get("refs/heads/main")); // SHA1 hash
 * ```
 */
export function getLocalRefs(refs: RefStore): Map<string, SHA1> {
  const map = new Map<string, SHA1>();

  for (const refName of refs.listAll()) {
    const content = refs.read(refName);
    if (content && /^[0-9a-f]{40}$/.test(content)) {
      try {
        map.set(refName, sha1(content));
      } catch {
        // 忽略无效哈希
      }
    }
  }

  // HEAD 可能指向 refs/ 外的引用（如 "HEAD" 自身），
  // 解析失败（循环/损坏）不影响其他 ref 的处理
  try {
    const hash = resolveRefHash(refs, HEAD_REF);
    if (hash) {
      map.set(HEAD_REF, hash);
    }
  } catch {
    // 忽略解析失败（如循环引用）
  }

  return map;
}

/**
 * 将远程 ref 广告转换为哈希映射
 *
 * @param refs - 远程引用列表（如来自 advertisement）
 * @returns ref 名称 → SHA1 哈希的映射
 *
 * @example
 * ```ts
 * const remoteMap = remoteRefsToMap(advertisement.refs);
 * console.log(remoteMap.get("refs/heads/main"));
 * ```
 */
export function remoteRefsToMap(refs: Array<{ name: string; hash: SHA1 }>): Map<string, SHA1> {
  const map = new Map<string, SHA1>();
  for (const ref of refs) {
    map.set(ref.name, ref.hash);
  }
  return map;
}
