/**
 * Refs 名称校验与名称转换工具
 */

import { HEAD_REF, HEADS_PREFIX, TAGS_PREFIX } from "../core/types/refs.ts";

/**
 * 验证引用前缀是否合法
 *
 * @param prefix - 引用前缀，如 "refs/heads/"
 * @throws 如果前缀格式无效
 *
 * @example
 * ```ts
 * validateRefPrefix("refs/heads/");
 * ```
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
 * @param ref - 完整引用路径
 * @throws 如果引用名称无效
 *
 * @example
 * ```ts
 * validateRefName("refs/heads/main");
 * ```
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

/**
 * 将分支短名转换为完整引用路径
 *
 * @example
 * ```ts
 * branchNameToRef("main");
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
 * tagNameToRef("v1.0.0");
 * ```
 */
export function tagNameToRef(name: string): string {
  return `${TAGS_PREFIX}${normalizeShortRefName(name, "tag")}`;
}

/**
 * 规范化短引用名称
 *
 * @example
 * ```ts
 * normalizeShortRefName("main", "branch");
 * ```
 */
export function normalizeShortRefName(name: string, kind: "branch" | "tag"): string {
  if (!name) {
    throw new Error(`${kind} name cannot be empty`);
  }

  validateRefName(`refs/x/${name}`);
  return name;
}
