/**
 * Refs 工具函数
 *
 * 提供 Git 引用的解析、校验和名称转换等纯函数。
 * 所有函数不依赖具体存储实现，通过 RefStore 接口操作。
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SHA1 } from "../core/types.ts";
import { sha1 } from "../core/types.ts";
import { CircularReferenceError } from "../core/errors.ts";
import type { RefStore } from "./types.ts";
import { HEAD_REF, HEADS_PREFIX, TAGS_PREFIX } from "./types.ts";

// ============================================================================
// 引用解析
// ============================================================================

/**
 * 解析引用为 SHA-1 哈希
 *
 * 符号引用会被递归解析，直到找到直接指向哈希的引用。
 *
 * @param store - RefStore 实例
 * @param ref - 引用路径
 * @param seen - 已访问的引用集合（用于循环检测）
 * @returns SHA-1 哈希，引用不存在时返回 null
 *
 * @example
 * ```ts
 * const hash = resolveRefHash(store, "refs/heads/main");
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
 * 只解析符号引用（以 "ref: " 开头的引用），
 * 遇到直接指向哈希的引用时返回 null。
 *
 * @param store - RefStore 实例
 * @param ref - 引用路径
 * @param seen - 已访问的引用集合（用于循环检测）
 * @returns 最终的目标引用路径，不是符号引用时返回 null
 *
 * @example
 * ```ts
 * const target = resolveSymbolicRef(store, "HEAD");
 * // => "refs/heads/main"
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
 * @param store - RefStore 实例
 * @param hash - 可选的 SHA-1 哈希
 * @returns SHA-1 哈希
 * @throws 如果 hash 未提供且 HEAD 不存在
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

// ============================================================================
// Ref 名称校验
// ============================================================================

/**
 * 验证引用前缀是否合法
 *
 * @param prefix - 引用前缀，如 "refs/heads/"
 * @throws 如果前缀格式无效
 */
export function validateRefPrefix(prefix: string): void {
  if (!prefix.startsWith("refs/") || !prefix.endsWith("/")) {
    throw new Error(`Invalid ref prefix: ${prefix}`);
  }

  validateRefName(`${prefix}placeholder`);
}

/**
 * 验证引用名称是否合法
 *
 * Git 引用名称不允许包含：
 * - 控制字符、空格
 * - 特殊字符: ~ ^ : ? * [ \
 * - 连续的 ..、//、@{、.lock 结尾等
 *
 * @param ref - 完整引用路径
 * @throws 如果引用名称无效
 */
export function validateRefName(ref: string): void {
  if (ref === HEAD_REF) {
    return;
  }

  if (!ref.startsWith("refs/")) {
    throw new Error(`Invalid ref name: ${ref}`);
  }

  if (
    ref.includes("\\") ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.includes("//") ||
    ref.endsWith("/") ||
    ref.endsWith(".")
  ) {
    throw new Error(`Invalid ref name: ${ref}`);
  }

  for (const char of ref) {
    const code = char.charCodeAt(0);
    if (
      code <= 0x1f ||
      code === 0x7f ||
      char === " " ||
      char === "~" ||
      char === "^" ||
      char === ":" ||
      char === "?" ||
      char === "*" ||
      char === "["
    ) {
      throw new Error(`Invalid ref name: ${ref}`);
    }
  }

  const parts = ref.split("/");
  if (parts.length < 3) {
    throw new Error(`Invalid ref name: ${ref}`);
  }

  for (const part of parts) {
    if (!part || part === "." || part === ".." || part.endsWith(".lock")) {
      throw new Error(`Invalid ref name: ${ref}`);
    }
  }
}

// ============================================================================
// 分支/标签名称转换
// ============================================================================

/**
 * 将分支短名转换为完整引用路径
 *
 * @example
 * ```ts
 * branchNameToRef("main") // => "refs/heads/main"
 * ```
 */
export function branchNameToRef(name: string): string {
  return `${HEADS_PREFIX}${normalizeShortRefName(name, "branch")}`;
}

/**
 * 将标签短名转换为完整引用路径
 *
 * @example
 * ```ts
 * tagNameToRef("v1.0.0") // => "refs/tags/v1.0.0"
 * ```
 */
export function tagNameToRef(name: string): string {
  return `${TAGS_PREFIX}${normalizeShortRefName(name, "tag")}`;
}

/**
 * 规范化短引用名称
 *
 * 对分支名或标签名进行基本验证，并确保能拼合为合法的完整 ref 路径。
 */
export function normalizeShortRefName(name: string, kind: "branch" | "tag"): string {
  if (!name) {
    throw new Error(`${kind} name cannot be empty`);
  }

  validateRefName(`refs/x/${name}`);
  return name;
}

// ============================================================================
// 文件系统辅助（供 file-ref-store 使用）
// ============================================================================

/**
 * 递归列出目录下的所有引用文件
 *
 * @param baseDir - 基础目录路径
 * @param prefix - 当前路径前缀
 * @returns 引用路径列表
 */
export function listLooseRefsRecursive(baseDir: string, prefix: string): string[] {
  const refs: string[] = [];
  const entries = readdirSync(baseDir).sort();

  for (const entry of entries) {
    const fullPath = join(baseDir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      refs.push(...listLooseRefsRecursive(fullPath, `${prefix}${entry}/`));
      continue;
    }

    if (stat.isFile()) {
      refs.push(`${prefix}${entry}`);
    }
  }

  return refs;
}
