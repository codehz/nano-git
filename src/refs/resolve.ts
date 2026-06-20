/**
 * Refs 解析工具
 */

import type { SHA1 } from "../core/types.ts";
import { sha1 } from "../core/types.ts";
import { CircularReferenceError } from "../core/errors.ts";
import type { RefStore } from "./types.ts";
import { HEAD_REF } from "./types.ts";

/**
 * 解析引用为 SHA-1 哈希
 *
 * @example
 * ```ts
 * const hash = resolveRefHash(store, "HEAD");
 * ```
 */
export function resolveRefHash(
  store: RefStore,
  ref: string,
  seen = new Set<string>(),
): SHA1 | null {
  if (seen.has(ref)) {
    throw new CircularReferenceError(ref);
  }

  seen.add(ref);
  const content = store.readRaw(ref);
  if (content === null) {
    return null;
  }

  if (content.startsWith("ref: ")) {
    return resolveRefHash(store, content.slice(5), seen);
  }

  return sha1(content);
}

/**
 * 解析符号引用为目标引用路径
 *
 * @example
 * ```ts
 * const target = resolveSymbolicRef(store, "HEAD");
 * ```
 */
export function resolveSymbolicRef(
  store: RefStore,
  ref: string,
  seen = new Set<string>(),
): string | null {
  if (seen.has(ref)) {
    throw new CircularReferenceError(ref);
  }

  seen.add(ref);
  const content = store.readRaw(ref);
  if (content === null || !content.startsWith("ref: ")) {
    return null;
  }

  const target = content.slice(5);
  const nestedTarget = resolveSymbolicRef(store, target, seen);
  return nestedTarget ?? target;
}

/**
 * 解析可选的哈希值，未提供时基于 HEAD 获取
 *
 * @example
 * ```ts
 * const hash = resolveTargetHash(store, undefined);
 * ```
 */
export function resolveTargetHash(store: RefStore, hash: SHA1 | undefined): SHA1 {
  if (hash) {
    return hash;
  }

  const headHash = resolveRefHash(store, HEAD_REF);
  if (!headHash) {
    throw new Error("Cannot resolve HEAD to create ref");
  }

  return headHash;
}
