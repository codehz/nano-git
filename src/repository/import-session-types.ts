/**
 * Import Session 类型定义
 *
 * 新的远端导入模型：source → session → named views → plan → apply。
 * 彻底替代旧的 fetchRemote() / bootstrapRemote() / fetch(url) API。
 */

import type { SHA1 } from "../core/types.ts";
import type { RemoteRef, RefAdvertisement } from "../transport/shared/types.ts";

// ============================================================================
// ImportSource
// ============================================================================

/**
 * 远端 Git 数据来源
 *
 * 只描述"从哪里读"，不描述"写到哪里"。
 * ImportSource 不包含命名空间映射规则。
 */
export interface ImportSource {
  /** 远端仓库 URL */
  readonly url: string;

  /** 认证 token（用于 bearer 或 basic auth） */
  readonly token?: string;

  /** 自定义请求头 */
  readonly headers?: Record<string, string>;
}

// ============================================================================
// ImportView
// ============================================================================

/**
 * 远端 ref 视图
 *
 * 一个可命名、可复用、冻结的远端 ref 集合。
 * view 是冻结集合，不是活查询。
 * view 可以被多个物化步骤复用。
 */
export interface ImportView {
  /** 视图包含的远端 ref 列表（冻结快照） */
  readonly refs: readonly RemoteRef[];

  /**
   * 通过谓词过滤当前视图
   *
   * @param predicate - 过滤谓词，返回 true 的 ref 保留
   * @returns 新的 ImportView
   */
  where(predicate: (ref: RemoteRef) => boolean): ImportView;

  /**
   * 排除匹配指定 glob 模式的 ref
   *
   * @param pattern - glob 模式，如 "refs/tags/*beta*"
   * @returns 新的 ImportView
   */
  exclude(pattern: string): ImportView;

  /**
   * 与另一个 view 取并集
   *
   * @param other - 另一个 view
   * @returns 新的 ImportView（含两个 view 的 refs，去重保留首次出现的 ref）
   */
  union(other: ImportView): ImportView;

  /**
   * 为当前视图命名
   *
   * 命名后的 view 可用于 plan 阶段引用。
   *
   * @param label - 视图名称
   * @returns NamedImportView
   */
  name(label: string): NamedImportView;
}

/**
 * 命名的远端 ref 视图
 *
 * 在 ImportView 基础上增加 label 属性，用于 plan 阶段的语义引用。
 */
export interface NamedImportView extends ImportView {
  /** 视图名称 */
  readonly label: string;
}

// ============================================================================
// ImportPlanBuilder
// ============================================================================

/**
 * Ref 更新策略
 */
export type RefUpdatePolicy =
  | { mode: "fast-forward" }
  | { mode: "replace" }
  | { mode: "create-only" }
  | { mode: "mirror" };

/**
 * 命名空间物化选项
 */
export interface NamespaceMaterializationOptions {
  readonly policy?: RefUpdatePolicy;
  readonly prune?: boolean;
}

/**
 * Branch 物化选项
 */
export interface BranchMaterializationOptions {
  readonly policy?: RefUpdatePolicy;
}

/**
 * Tag 物化选项
 */
export interface TagMaterializationOptions {
  readonly policy?: RefUpdatePolicy;
}

/**
 * HEAD 物化选项
 *
 * setHead() 只能绑定到同一 plan 中已物化出的 `refs/heads/*`。
 * `detach` 仅改变 HEAD 最终写入方式，不放宽目标命名空间。
 */
export interface HeadMaterializationOptions {
  readonly detach?: boolean;
}

/**
 * Ref 物化构建器
 */
export interface RefMaterializationBuilder {
  toNamespace(targetPattern: string, options?: NamespaceMaterializationOptions): ImportPlanBuilder;

  toBranch(branchName: string, options?: BranchMaterializationOptions): ImportPlanBuilder;

  toTag(tagName: string, options?: TagMaterializationOptions): ImportPlanBuilder;

  setHead(options?: HeadMaterializationOptions): ImportPlanBuilder;
}

/**
 * 导入计划构建器
 */
export interface ImportPlanBuilder {
  materialize(view: ImportView): RefMaterializationBuilder;

  preview(): Promise<ImportPreview>;

  apply(): Promise<ImportApplyResult>;
}

// ============================================================================
// Preview 与 Apply 结果类型
// ============================================================================

/**
 * 计划中的远端 ref 项
 */
export interface PlannedRemoteRef {
  readonly remoteRef: RemoteRef;
  readonly localTarget: string;
  readonly policy: RefUpdatePolicy;
  readonly viewLabel?: string;
}

/**
 * 本地前置条件
 */
export interface LocalPrecondition {
  readonly refName: string;
  readonly expectedHash: SHA1 | null;
  /**
   * 原始 ref 值快照
   *
   * 用于 HEAD 这类可能是符号引用的特殊 ref。
   * 普通 hash ref 通常不需要此字段。
   */
  readonly expectedValue?: string | null;
  /**
   * 命名空间快照前缀
   *
   * 用于 prune ownership 场景。
   * 当此字段存在时，表示该前置条件校验的是整个命名空间下的 ref 集合，
   * 而不是单个 ref。
   */
  readonly namespacePrefix?: string;
  /**
   * 命名空间 ownership 模式
   *
   * 当 prune 目标不是简单的前缀投影（例如 `refs/mirrors/*-backup`）时，
   * 需要记录完整目标模式，以便 apply() 按同一集合重新校验和 prune。
   */
  readonly namespacePattern?: string;
  /**
   * 命名空间内全部 ref 的原始值快照
   *
   * 与 namespacePrefix 配合使用，用于检测 preview() 后
   * 该命名空间下 ref 的新增、删除或内容漂移。
   * 若存在 namespacePattern，则按完整模式而不是简单前缀匹配。
   */
  readonly expectedRefs?: readonly {
    readonly refName: string;
    readonly expectedValue: string | null;
  }[];
}

/**
 * 计划中的 ref 操作
 */
export interface PlannedRefOperation {
  readonly localRef: string;
  readonly newHash: SHA1;
  readonly policy: RefUpdatePolicy;
  readonly viewLabel?: string;
}

/**
 * 计划中的 HEAD 操作
 *
 * targetRef 始终是同一计划内已物化成功的本地 branch ref，
 * 且必须位于 `refs/heads/*`。
 */
export interface PlannedHeadOperation {
  readonly targetRef: string;
  readonly detach: boolean;
  readonly viewLabel?: string;
}

/**
 * 计划中的 ref 删除
 */
export interface PlannedRefDeletion {
  readonly refName: string;
  readonly reason: string;
  readonly namespacePattern: string;
  readonly viewLabel?: string;
}

/**
 * 导入诊断信息
 */
export interface ImportDiagnostic {
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly refName?: string;
}

/**
 * 导入预览结果
 *
 * preview() 的目标是明确展示将会发生什么，
 * 让调用者在 apply() 前有完整的认识。
 */
export interface ImportPreview {
  readonly remoteSnapshot: RefAdvertisement;
  readonly selectedRefs: readonly PlannedRemoteRef[];
  readonly objectRoots: readonly SHA1[];
  readonly prefetchedObjects: number;
  readonly localPreconditions: readonly LocalPrecondition[];
  readonly refOperations: readonly PlannedRefOperation[];
  readonly headOperation?: PlannedHeadOperation;
  readonly pruneOperations: readonly PlannedRefDeletion[];
  readonly diagnostics: readonly ImportDiagnostic[];
  readonly canApply: boolean;
}

/**
 * 导入执行结果
 */
export interface ImportApplyResult {
  readonly importedObjects: number;
  readonly updatedRefs: ReadonlyMap<string, SHA1>;
  readonly deletedRefs: readonly string[];
  readonly headTarget?: string;
}

// ============================================================================
// ImportSession
// ============================================================================

/**
 * 导入会话
 *
 * 一次冻结的远端快照。
 * 在创建时拉取一次 advertisement，所有派生 view 和 plan 都基于该快照。
 * 想刷新远端状态时，必须重新创建 session。
 */
export interface ImportSession {
  readonly source: ImportSource;
  readonly advertisement: RefAdvertisement;

  select(pattern: string): ImportView;

  selectRefs(patterns: readonly string[]): ImportView;

  defaultBranch(): ImportView;

  headTarget(): ImportView;

  allRefs(): ImportView;

  plan(): ImportPlanBuilder;
}

// ============================================================================
// Repository 导入操作接口
// ============================================================================

/**
 * 仓库导入操作
 */
export interface RepoImportOperations {
  /**
   * 打开一次导入会话
   *
   * 创建时自动拉取远端 advertisement。
   * 会话及其所有派生 view 都是基于该快照的冻结视图。
   *
   * @param source - 导入源配置
   * @returns ImportSession
   *
   * @example
   * ```ts
   * const session = await repo.openImportSession({
   *   url: "https://example.com/repo.git",
   * });
   * const branches = session.select("refs/heads/*");
   * ```
   */
  openImportSession(source: ImportSource): Promise<ImportSession>;
}
