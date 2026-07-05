/**
 * Import Session 类型定义
 *
 * 新的远端导入模型：source → session → named views → plan → apply。
 * 彻底替代旧的 fetchRemote() / bootstrapRemote() / fetch(url) API。
 */

import type { RemoteSource } from "../../remote/types.ts";
import type { RemoteRef, RefAdvertisement } from "../../transport/protocol/types.ts";
import type { SHA1 } from "../../types/index.ts";
import type { ShallowUpdate } from "../../types/shallow.ts";

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
// ImportPlanDraft
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
export interface RefMaterializationDraft {
  toNamespace(targetPattern: string, options?: NamespaceMaterializationOptions): ImportPlanDraft;

  toBranch(branchName: string, options?: BranchMaterializationOptions): ImportPlanDraft;

  toTag(tagName: string, options?: TagMaterializationOptions): ImportPlanDraft;

  setHead(options?: HeadMaterializationOptions): ImportPlanDraft;
}

/**
 * 导入计划草案
 */
export interface ImportPlanDraft {
  materialize(view: ImportView): RefMaterializationDraft;

  build(): ImportPlan;
}

// ============================================================================
// Plan / Preview / Apply 结果类型
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
 * 静态计划检查结果
 */
export interface ImportPlanInspection {
  readonly selectedRefs: readonly PlannedRemoteRef[];
  readonly diagnostics: readonly ImportDiagnostic[];
  readonly canPrepare: boolean;
}

/**
 * 已准备导入计划的预览结果
 *
 * prepare() 的目标是展示对象预取和 ref/HEAD/prune 最终会发生什么，
 * 同时隐藏执行内部使用的前置条件快照。
 */
export interface ImportPreparedPreview {
  readonly remoteSnapshot: RefAdvertisement;
  readonly objectRoots: readonly SHA1[];
  readonly prefetchedObjects: number;
  readonly shallowUpdate?: ShallowUpdate;
  readonly refOperations: readonly PlannedRefOperation[];
  readonly headOperation?: PlannedHeadOperation;
  readonly pruneOperations: readonly PlannedRefDeletion[];
  readonly diagnostics: readonly ImportDiagnostic[];
  readonly canApply: boolean;
}

/**
 * prepare() 阶段的对象抓取选项
 *
 * 用于控制一次导入计划在 prepare() 时发出的 fetch 请求形态。
 * 未指定 shallow 参数时，会自动回退当前仓库 backend.shallow 中的边界。
 */
export interface ImportPrepareOptions {
  /**
   * 目标绝对深度（对标 `git fetch --depth=<n>`）
   *
   * 含义是“从远端 tip 起保留 n 层历史”。
   * 对已是 shallow 的仓库，也会尝试将历史调整到该绝对深度。
   */
  readonly depth?: number;

  /**
   * 相对加深层数（对标 `git fetch --deepen=<n>`）
   *
   * 含义是“从当前 shallow 边界再向后扩展 n 层历史”。
   */
  readonly deepen?: number;

  /**
   * 基于时间扩展 shallow 历史（对标 `git fetch --shallow-since=<timestamp>`）
   *
   * 这里使用 Unix 时间戳秒数，避免把近似日期解析规则泄漏到库 API 中。
   */
  readonly shallowSince?: number;

  /**
   * 排除指定远端分支/标签可达历史（对标 `git fetch --shallow-exclude=<ref>`）
   */
  readonly shallowExclude?: readonly string[];

  /**
   * 将 shallow 仓库尽量补齐为完整仓库（对标 `git fetch --unshallow`）
   */
  readonly unshallow?: boolean;
}

/**
 * 已编译的导入计划
 */
export interface ImportPlan {
  inspect(): ImportPlanInspection;

  prepare(options?: ImportPrepareOptions): Promise<PreparedImportPlan>;
}

/**
 * 已准备执行的导入计划
 */
export interface PreparedImportPlan {
  readonly preview: ImportPreparedPreview;

  apply(): Promise<ImportApplyResult>;
}

/**
 * 导入执行结果
 */
export interface ImportApplyResult {
  readonly importedObjects: number;
  readonly shallowUpdate?: ShallowUpdate;
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
  readonly source: RemoteSource;
  readonly advertisement: RefAdvertisement;

  select(pattern: string): ImportView;

  selectRefs(patterns: readonly string[]): ImportView;

  defaultBranch(): ImportView;

  headTarget(): ImportView;

  allRefs(): ImportView;

  plan(): ImportPlanDraft;
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
  openImportSession(source: RemoteSource): Promise<ImportSession>;
}
