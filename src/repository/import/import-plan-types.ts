import type { RepositoryBackend } from "../../backend/types.ts";
import type { V2GitServiceTransport } from "../../transport/client/upload-pack/types.ts";
import type { RemoteRef, RefAdvertisement } from "../../transport/protocol/types.ts";
import type { SHA1 } from "../../types/index.ts";
import type { ShallowUpdate } from "../../types/shallow.ts";
import type {
  ImportDiagnostic,
  ImportPreparedPreview,
  PlannedHeadOperation,
  PlannedRefDeletion,
  PlannedRefOperation,
  PlannedRemoteRef,
  RefUpdatePolicy,
} from "./import-session-types.ts";

export interface ImportMaterializationIntent {
  readonly viewRefs: readonly RemoteRef[];
  readonly viewLabel?: string;
  readonly action: "namespace" | "branch" | "tag" | "head";
  readonly target: string;
  readonly policy: RefUpdatePolicy | undefined;
  readonly prune?: boolean;
  readonly detach?: boolean;
}

export interface ResolvedMapping {
  readonly remoteRef: RemoteRef;
  readonly localRef: string;
  readonly policy: RefUpdatePolicy;
  readonly viewLabel?: string;
}

export interface NamespaceOwnership {
  readonly pattern: string;
  readonly prefix: string;
  readonly currentRefs: Set<string>;
  viewLabel?: string;
  prune: boolean;
}

export interface NamespaceSnapshotEntry {
  readonly refName: string;
  readonly expectedValue: string | null;
}

export interface HeadRequest {
  readonly localRef: string;
  readonly detach: boolean;
  readonly viewLabel?: string;
}

export interface LocalPrecondition {
  readonly refName: string;
  readonly expectedHash: SHA1 | null;
  readonly expectedValue?: string | null;
  readonly namespacePrefix?: string;
  readonly namespacePattern?: string;
  readonly expectedRefs?: readonly NamespaceSnapshotEntry[];
}

export interface CompiledImportPlanState {
  readonly backend: RepositoryBackend;
  readonly advertisement: Readonly<RefAdvertisement>;
  readonly v2Transport?: V2GitServiceTransport;
  readonly wantsExplicitTags: boolean;
  readonly resolvedMappings: readonly ResolvedMapping[];
  readonly headRequests: readonly HeadRequest[];
  readonly namespaceOwnerships: ReadonlyMap<string, NamespaceOwnership>;
  readonly selectedRefs: readonly PlannedRemoteRef[];
  readonly diagnostics: readonly ImportDiagnostic[];
  readonly conflictedTargets: ReadonlySet<string>;
}

export interface PreparedImportPlanState {
  readonly preview: ImportPreparedPreview;
  readonly shallowUpdate?: ShallowUpdate;
  readonly preconditions: readonly LocalPrecondition[];
  readonly refOperations: readonly PlannedRefOperation[];
  readonly headOperation?: PlannedHeadOperation;
  readonly pruneOperations: readonly PlannedRefDeletion[];
}

export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  const target = value as Record<PropertyKey, unknown>;
  for (const key of Reflect.ownKeys(target)) {
    deepFreeze(target[key]);
  }

  return Object.freeze(value);
}
