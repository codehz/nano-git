/**
 * 仓库模块
 *
 * 拆分高层仓库 API 的类型、工厂函数和辅助逻辑。
 */

export type { Repository } from "./types.ts";
export type { RepositoryContext } from "./context-types.ts";
export type { RepositoryObjectOperations } from "./object-types.ts";
export type { TreePatchOp, TreePatchResult } from "./tree-patch.ts";
export type { RepositoryRefOperations } from "./ref-types.ts";
export type { RepositoryMaintenanceOperations } from "./maintenance-types.ts";
export type {
  RepositoryPushOptions,
  RepositoryPushResult,
  PushRefUpdateResult,
} from "./push-types.ts";
export type {
  ImportSource,
  ImportView,
  NamedImportView,
  ImportSession,
  ImportPlanBuilder,
  RefMaterializationBuilder,
  ImportPreview,
  ImportApplyResult,
  RefUpdatePolicy,
  PlannedRemoteRef,
  LocalPrecondition,
  PlannedRefOperation,
  PlannedRefDeletion,
  PlannedHeadOperation,
  ImportDiagnostic,
  NamespaceMaterializationOptions,
  BranchMaterializationOptions,
  TagMaterializationOptions,
  HeadMaterializationOptions,
  RepoImportOperations,
} from "./import-session-types.ts";
export { createRepository } from "./create.ts";
export { initRepository, openRepository, createMemoryRepository } from "./init.ts";
