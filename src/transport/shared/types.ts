/**
 * 传输层共享类型
 *
 * 协议无关的类型定义，同时被 v1 和 v2 使用。
 */

import type { SHA1 } from "../../core/types.ts";

/**
 * 远程引用
 */
export interface RemoteRef {
  hash: SHA1;
  name: string;
  peeled?: SHA1;
  symrefTarget?: string;
}

/**
 * Ref 映射规则
 */
export interface RefMappingRule {
  readonly source: string;
  readonly target: string;
  readonly force?: boolean;
}

/**
 * Ref 更新拒绝原因
 */
export interface RefUpdateRejection {
  readonly localRef: string;
  readonly reason: "not-fast-forward" | "tag-hash-mismatch" | "object-missing";
  readonly expected?: SHA1;
  readonly actual: SHA1;
}

/**
 * Ref 更新应用结果
 */
export interface ApplyRefUpdatesResult {
  readonly updatedRefs: Map<string, SHA1>;
  readonly rejectedRefs: RefUpdateRejection[];
}
