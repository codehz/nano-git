/**
 * 仓库相关类型入口
 *
 * 纯类型导出。
 */

export type { Repository } from "../repository/types.ts";
export type {
  RepositoryBackend,
  RepositoryPackSupport,
  RepositoryGCOptions,
  RepositoryRepackOptions,
} from "../repository/backend/types.ts";
export type { RepositoryObjectOperations } from "../repository/object-types.ts";
export type { RepositoryRefOperations } from "../repository/ref-types.ts";
export type { RepositoryMaintenanceOperations } from "../repository/maintenance-types.ts";
export type {
  RepositoryPushOptions,
  RepositoryPushResult,
  PushRefUpdateResult,
} from "../repository/push-types.ts";
export type {
  RepositoryFetchOptions,
  RepositoryFetchResult,
  FetchRefUpdateResult,
} from "../repository/fetch-types.ts";
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
} from "../repository/import-session-types.ts";
export type { TreePatchOp, TreePatchResult } from "../repository/tree-patch.ts";
export type { TreeEntryWithPath } from "../repository/tree-walk.ts";
