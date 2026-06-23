/**
 * 仓库模块
 *
 * 拆分高层仓库 API 的类型、工厂函数和辅助逻辑。
 */

export type { Repository } from "./types.ts";
export type { RepositoryObjectOperations } from "./ops/object-types.ts";
export type { TreePatchOp, TreePatchResult } from "./tree/tree-patch.ts";
export { patchTree } from "./tree/tree-patch.ts";
export { readTree, walkTree } from "./tree/tree-walk.ts";
export type { TreeEntryWithPath } from "./tree/tree-walk.ts";
export type { RepositoryRefOperations } from "./ops/ref-types.ts";
export type { RepositoryMaintenanceOperations } from "./ops/maintenance-types.ts";
export type {
  RepositoryPushOptions,
  RepositoryPushResult,
  PushRefUpdateResult,
} from "./ops/push-types.ts";
export type {
  RepositoryFetchOptions,
  RepositoryFetchResult,
  FetchRefUpdateResult,
} from "./ops/fetch-types.ts";
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
} from "./import/import-session-types.ts";
export { createRepository } from "./create.ts";
export { initRepository, openRepository } from "./file.ts";
export { createMemoryRepository } from "./memory.ts";
