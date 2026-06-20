/**
 * Smart HTTP Fetch 传输层类型定义
 *
 * 定义了远程 Git 仓库交互所需的核心类型：
 * - RemoteRef：远程引用信息
 * - RefAdvertisement：服务端引用广告（含能力声明）
 * - FetchOptions：fetch 操作选项
 * - FetchResult：fetch 操作结果
 */

import type { SHA1 } from "../core/types.ts";

/**
 * 远程引用
 *
 * 表示服务端广告的单个 Git 引用。
 *
 * @example
 * ```ts
 * const ref: RemoteRef = {
 *   hash: sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"),
 *   name: "refs/heads/main",
 * };
 * ```
 */
export interface RemoteRef {
  /** 引用指向的对象哈希 */
  hash: SHA1;
  /** 引用完整名称，如 "refs/heads/main" */
  name: string;
  /** 如果引用是 annotated tag，此项为最终指向的 peeled 对象哈希 */
  peeled?: SHA1;
  /**
   * 符号引用目标
   * 如 "HEAD" → "refs/heads/main"
   */
  symrefTarget?: string;
}

/**
 * 服务端引用广告
 *
 * 包含服务端通过 ref advertisement 响应的能力声明和所有引用。
 *
 * @example
 * ```ts
 * const adv: RefAdvertisement = {
 *   capabilities: { multi_ack: true, "symref": "HEAD:refs/heads/main" },
 *   refs: [ { hash: sha1("..."), name: "refs/heads/main" } ],
 * };
 * ```
 */
export interface RefAdvertisement {
  /** 服务端能力声明 */
  capabilities: Record<string, string | true>;
  /** 所有广告的引用列表 */
  refs: RemoteRef[];
}

/**
 * Fetch 操作选项
 *
 * 控制 clone/fetch 行为。
 */
export interface FetchOptions {
  /**
   * refspec 列表，格式如 "+refs/heads/*:refs/remotes/origin/*"
   * 默认为 ["+refs/heads/*:refs/remotes/origin/*"]
   */
  refSpecs?: string[];
  /** shallow clone 深度（可选） */
  depth?: number;
}

/**
 * Fetch 操作结果
 */
export interface FetchResult {
  /** 本地 ref → 新 hash 的映射 */
  fetchedRefs: Map<string, SHA1>;
  /** 获取的对象数量 */
  objectCount: number;
}
