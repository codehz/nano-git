/**
 * nano-git 核心类型定义
 *
 * Git 的对象模型：
 * - 所有对象通过 SHA-1 哈希寻址（40 个十六进制字符）
 * - 四种对象类型：blob, tree, commit, tag
 * - 对象以 "<type> <size>\0<content>" 格式存储
 */

import { InvalidSHA1Error } from "./errors.ts";

/** SHA-1 哈希值（40 个十六进制字符） */
export type SHA1 = string & { readonly __brand: "SHA1" };

/** Git 对象类型 */
export type ObjectType = "blob" | "tree" | "commit" | "tag";

/** Blob 对象 — 存储文件内容 */
export interface GitBlob {
  type: "blob";
  content: Buffer;
}

/** Tree 条目 — 目录中的一个文件或子目录 */
export interface TreeEntry {
  /** 文件模式（如 "100644" 普通文件, "100755" 可执行文件, "040000" 目录） */
  mode: string;
  /** 文件/目录名 */
  name: string;
  /** 指向的 SHA-1 哈希 */
  hash: SHA1;
}

/** Tree 对象 — 存储目录结构 */
export interface GitTree {
  type: "tree";
  entries: TreeEntry[];
}

/** Commit 对象 — 存储快照信息 */
export interface GitCommit {
  type: "commit";
  /** 指向的 tree 对象哈希 */
  tree: SHA1;
  /** 父 commit 哈希列表（merge commit 有多个父节点） */
  parents: SHA1[];
  /** 作者信息 */
  author: GitAuthor;
  /** 提交者信息 */
  committer: GitAuthor;
  /** 提交信息 */
  message: string;
}

/** 作者/提交者信息 */
export interface GitAuthor {
  name: string;
  email: string;
  /** Unix 时间戳（秒） */
  timestamp: number;
  /** 时区偏移（如 "+0800"） */
  timezone: string;
}

/** Tag 对象 — 带注释的标签 */
export interface GitTag {
  type: "tag";
  /** 指向的对象哈希 */
  object: SHA1;
  /** 被标记对象的类型 */
  objectType: ObjectType;
  /** 标签名 */
  tag: string;
  /** 标签创建者 */
  tagger: GitAuthor;
  /** 标签信息 */
  message: string;
}

/** 所有 Git 对象的联合类型 */
export type GitObject = GitBlob | GitTree | GitCommit | GitTag;

/**
 * 创建 SHA1 类型的辅助函数
 *
 * @param value - 待校验的哈希字符串
 * @returns 带品牌的 SHA1 字符串
 *
 * @example
 * ```ts
 * const hash = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
 * console.log(hash);
 * ```
 */
export function sha1(value: string): SHA1 {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new InvalidSHA1Error(value);
  }
  return value as SHA1;
}
