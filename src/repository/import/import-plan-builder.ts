/**
 * Import Plan Builder 实现
 *
 * 负责 preview/apply 的完整执行语义，包括命名空间映射、分支/tag/HEAD 物化、
 * 前置条件校验、prune 清理以及实际的 ref 写入和对象导入。
 */

import { PreconditionCheckError } from "../../errors.ts";
import { v2FetchObjects } from "../../transport/client/upload-pack/fetch.ts";
import { isAncestor } from "../../transport/protocol/object-graph.ts";
import { getLocalRefs } from "../../transport/protocol/ref-collection.ts";
import { resolveBranchTargetHash } from "../../transport/protocol/update-refs.ts";
import { matchRefGlob, globToRegex } from "./import-glob.ts";
import {
  resolveNamespaceTargets,
  getNamespacePatternPrefix,
  isSameRemoteRef,
} from "./import-view.ts";

import type { RepositoryBackend } from "../../backend/types.ts";
import type { RemoteSource } from "../../remote/types.ts";
import type { V2GitServiceTransport } from "../../transport/client/upload-pack/types.ts";
import type {
  RemoteRef,
  RefAdvertisement,
  UploadPackTransport,
} from "../../transport/protocol/types.ts";
import type { SHA1 } from "../../types/index.ts";
import type {
  ImportPlanBuilder,
  ImportPreview,
  ImportApplyResult,
  ImportDiagnostic,
  LocalPrecondition,
  PlannedRemoteRef,
  PlannedRefOperation,
  PlannedRefDeletion,
  PlannedHeadOperation,
  RefMaterializationBuilder,
  RefUpdatePolicy,
  NamedImportView,
  ImportView,
} from "./import-session-types.ts";

// ============================================================================
// PlanBuilder 内部类型
// ============================================================================

/**
 * 物化动作（内部存储）
 *
 * 记录每个 materialize() 调用产生的动作，用于 preview() 计算。
 */
interface MaterializationAction {
  readonly viewRefs: readonly RemoteRef[];
  readonly viewLabel?: string;
  readonly action: "namespace" | "branch" | "tag" | "head";
  readonly target: string;
  readonly policy: RefUpdatePolicy | undefined;
  readonly prune?: boolean;
  readonly detach?: boolean;
}

interface ResolvedMapping {
  readonly remoteRef: RemoteRef;
  readonly localRef: string;
  readonly policy: RefUpdatePolicy;
  readonly viewLabel?: string;
}

interface NamespaceOwnership {
  readonly pattern: string;
  readonly prefix: string;
  readonly currentRefs: Set<string>;
  viewLabel?: string;
  prune: boolean;
}

interface NamespaceSnapshotEntry {
  readonly refName: string;
  readonly expectedValue: string | null;
}

interface HeadRequest {
  readonly localRef: string;
  readonly detach: boolean;
  readonly viewLabel?: string;
}

// ============================================================================
// 内部工具函数
// ============================================================================

function clonePolicy(policy: RefUpdatePolicy): RefUpdatePolicy {
  return { ...policy };
}

function getViewLabel(view: ImportView): string | undefined {
  const candidate = view as Partial<NamedImportView>;
  return typeof candidate.label === "string" ? candidate.label : undefined;
}

function describeView(viewLabel?: string): string {
  return viewLabel ? `命名视图 "${viewLabel}"` : "当前视图";
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  const target = value as Record<PropertyKey, unknown>;
  for (const key of Reflect.ownKeys(target)) {
    deepFreeze(target[key]);
  }

  return Object.freeze(value);
}

function freezePreviewResult(
  preview: ImportPreview,
  advertisement: Readonly<RefAdvertisement>,
): ImportPreview {
  return deepFreeze({
    remoteSnapshot: advertisement,
    selectedRefs: preview.selectedRefs,
    objectRoots: preview.objectRoots,
    prefetchedObjects: preview.prefetchedObjects,
    localPreconditions: preview.localPreconditions,
    refOperations: preview.refOperations,
    headOperation: preview.headOperation,
    pruneOperations: preview.pruneOperations,
    diagnostics: preview.diagnostics,
    canApply: preview.canApply,
  });
}

/**
 * 快照某个 ownership 模式当前覆盖的全部 refs
 *
 * @param backend - 仓库后端
 * @param pattern - ownership 目标模式
 * @returns 已排序的原始 ref 值快照
 */
function snapshotOwnedRefs(
  backend: RepositoryBackend,
  pattern: string,
): readonly NamespaceSnapshotEntry[] {
  return backend.refs
    .listAll()
    .filter((refName) => matchRefGlob(pattern, refName))
    .sort((left, right) => left.localeCompare(right))
    .map((refName) => ({
      refName,
      expectedValue: backend.refs.read(refName),
    }));
}

/**
 * 校验 preview 冻结的本地前置条件仍然成立
 *
 * @param backend - 仓库后端
 * @param preconditions - preview 记录的前置条件
 * @returns 当前本地 hash 快照
 */
export function validateLocalPreconditions(
  backend: RepositoryBackend,
  preconditions: readonly LocalPrecondition[],
): Map<string, SHA1> {
  const currentLocalRefs = getLocalRefs(backend.refs);

  for (const pc of preconditions) {
    if (pc.namespacePattern !== undefined || pc.namespacePrefix !== undefined) {
      const pattern = pc.namespacePattern ?? `${pc.namespacePrefix!}*`;
      const currentRefs = snapshotOwnedRefs(backend, pattern);
      const expectedRefs = pc.expectedRefs ?? [];

      const sameLength = currentRefs.length === expectedRefs.length;
      const sameEntries =
        sameLength &&
        currentRefs.every((entry, idx) => {
          const expected = expectedRefs[idx];
          return (
            expected !== undefined &&
            entry.refName === expected.refName &&
            entry.expectedValue === expected.expectedValue
          );
        });

      if (!sameEntries) {
        throw new PreconditionCheckError(
          `前置条件校验失败：命名空间 "${pattern}" 在 preview() 后已变化。`,
        );
      }
      continue;
    }

    if (pc.expectedValue !== undefined) {
      const currentValue = backend.refs.read(pc.refName);
      if (currentValue !== pc.expectedValue) {
        throw new PreconditionCheckError(
          `前置条件校验失败：ref "${pc.refName}" 在 preview() 后已变化。` +
            `期望 ${pc.expectedValue ?? "(不存在)"}，实际 ${currentValue ?? "(不存在)"}。`,
        );
      }
      continue;
    }

    const currentHash = currentLocalRefs.get(pc.refName) ?? null;
    if (currentHash !== pc.expectedHash) {
      throw new PreconditionCheckError(
        `前置条件校验失败：ref "${pc.refName}" 在 preview() 后已变化。` +
          `期望 ${pc.expectedHash ?? "(不存在)"}，实际 ${currentHash ?? "(不存在)"}。`,
      );
    }
  }

  return currentLocalRefs;
}

// ============================================================================
// PlanBuilder 工厂
// ============================================================================

/**
 * 创建 ImportPlanBuilder
 *
 * 该 builder 负责 preview/apply 的完整执行语义。
 */
export function createPlanBuilder(
  backend: RepositoryBackend,
  advertisement: Readonly<RefAdvertisement>,
  source: RemoteSource,
  transportFactory?: (url: string) => UploadPackTransport,
  v2Transport?: V2GitServiceTransport,
): ImportPlanBuilder {
  const actions: MaterializationAction[] = [];
  let planVersion = 0;
  let lastPreview: { readonly version: number; readonly preview: ImportPreview } | null = null;

  /**
   * 计划动作变更后必须丢弃旧 preview，
   * 否则 apply() 可能基于过期计划执行。
   */
  function invalidatePreview(): void {
    planVersion += 1;
    lastPreview = null;
  }

  function inferNamespaceDefaultPolicy(targetPattern: string): RefUpdatePolicy | undefined {
    const headRegex = globToRegex("refs/heads/*");
    if (targetPattern === "refs/heads/*" || headRegex.test(targetPattern)) {
      return { mode: "fast-forward" };
    }
    const tagRegex = globToRegex("refs/tags/*");
    if (targetPattern === "refs/tags/*" || tagRegex.test(targetPattern)) {
      return { mode: "create-only" };
    }
    return undefined;
  }

  function captureLocalPreconditions(
    resolvedMappings: readonly ResolvedMapping[],
    headRequests: readonly HeadRequest[],
    namespaceOwnerships: ReadonlyMap<string, NamespaceOwnership>,
  ): readonly LocalPrecondition[] {
    const affectedRefNames = new Set<string>();
    for (const mapping of resolvedMappings) {
      affectedRefNames.add(mapping.localRef);
    }
    if (headRequests.length > 0) {
      affectedRefNames.add("HEAD");
    }

    const localRefs = getLocalRefs(backend.refs);
    const localPreconditions: LocalPrecondition[] = [];
    for (const refName of affectedRefNames) {
      const expectedValue = backend.refs.read(refName);
      localPreconditions.push({
        refName,
        expectedHash: localRefs.get(refName) ?? null,
        expectedValue,
      });
    }

    for (const ownership of namespaceOwnerships.values()) {
      if (!ownership.prune) {
        continue;
      }
      localPreconditions.push({
        refName: ownership.pattern,
        expectedHash: null,
        namespacePrefix: ownership.prefix,
        namespacePattern: ownership.pattern,
        expectedRefs: snapshotOwnedRefs(backend, ownership.pattern),
      });
    }

    return localPreconditions;
  }

  function createPreviewResult(params: {
    readonly selectedRefs: readonly PlannedRemoteRef[];
    readonly objectRoots: readonly SHA1[];
    readonly prefetchedObjects: number;
    readonly localPreconditions: readonly LocalPrecondition[];
    readonly refOperations: readonly PlannedRefOperation[];
    readonly headOperation?: PlannedHeadOperation;
    readonly pruneOperations: readonly PlannedRefDeletion[];
    readonly diagnostics: readonly ImportDiagnostic[];
  }): ImportPreview {
    const canApply = !params.diagnostics.some((diagnostic) => diagnostic.level === "error");
    return freezePreviewResult(
      {
        remoteSnapshot: advertisement,
        selectedRefs: params.selectedRefs,
        objectRoots: params.objectRoots,
        prefetchedObjects: params.prefetchedObjects,
        localPreconditions: params.localPreconditions,
        refOperations: params.refOperations,
        headOperation: params.headOperation,
        pruneOperations: params.pruneOperations,
        diagnostics: params.diagnostics,
        canApply,
      },
      advertisement,
    );
  }

  function buildPreviewSkeleton(): {
    readonly resolvedMappings: readonly ResolvedMapping[];
    readonly headRequests: readonly HeadRequest[];
    readonly namespaceOwnerships: ReadonlyMap<string, NamespaceOwnership>;
    readonly selectedRefs: readonly PlannedRemoteRef[];
    readonly objectRoots: readonly SHA1[];
    readonly localPreconditions: readonly LocalPrecondition[];
    readonly diagnostics: readonly ImportDiagnostic[];
    readonly conflictedTargets: ReadonlySet<string>;
  } {
    const resolvedMappings: ResolvedMapping[] = [];
    const headRequests: HeadRequest[] = [];
    const namespaceOwnerships = new Map<string, NamespaceOwnership>();
    const diagnostics: ImportDiagnostic[] = [];

    for (const act of actions) {
      let effectivePolicy: RefUpdatePolicy | undefined = act.policy;

      if (act.action === "namespace" && effectivePolicy === undefined) {
        effectivePolicy = inferNamespaceDefaultPolicy(act.target);
        if (effectivePolicy === undefined) {
          diagnostics.push({
            level: "error",
            message:
              `${describeView(act.viewLabel)}：命名空间 "${act.target}" 需要显式指定 policy 参数。` +
              `refs/heads/* 和 refs/tags/* 之外的命名空间必须显式声明 RefUpdatePolicy。`,
          });
          continue;
        }

        diagnostics.push({
          level: "info",
          message: `${describeView(act.viewLabel)}：命名空间 "${act.target}" 使用默认策略 ${effectivePolicy.mode}。`,
        });
      }

      if (effectivePolicy === undefined) {
        continue;
      }

      switch (act.action) {
        case "namespace": {
          if (act.prune && !act.target.includes("*")) {
            diagnostics.push({
              level: "error",
              message:
                `${describeView(act.viewLabel)}：toNamespace("${act.target}")：` +
                "prune 只允许用于带 * 的命名空间投影。",
            });
            break;
          }

          const targets = resolveNamespaceTargets(act.viewRefs, act.target);
          for (const target of targets) {
            resolvedMappings.push({
              remoteRef: target.remoteRef,
              localRef: target.localRef,
              policy: effectivePolicy,
              viewLabel: act.viewLabel,
            });
          }

          const namespacePrefix = getNamespacePatternPrefix(act.target);
          if (namespacePrefix !== null) {
            const ownership = namespaceOwnerships.get(act.target) ?? {
              pattern: act.target,
              prefix: namespacePrefix,
              currentRefs: new Set<string>(),
              prune: false,
              viewLabel: act.viewLabel,
            };
            for (const target of targets) {
              ownership.currentRefs.add(target.localRef);
            }
            ownership.prune = ownership.prune || (act.prune ?? false);
            ownership.viewLabel = act.viewLabel ?? ownership.viewLabel;
            namespaceOwnerships.set(act.target, ownership);
          }
          break;
        }

        case "branch": {
          if (act.viewRefs.length === 0) {
            diagnostics.push({
              level: "warn",
              message: `${describeView(act.viewLabel)}：toBranch("${act.target}")：view 为空，不会创建分支。`,
            });
            break;
          }

          if (act.viewRefs.length > 1) {
            diagnostics.push({
              level: "error",
              message:
                `${describeView(act.viewLabel)}：toBranch("${act.target}") 需要单一 ref 视图，` +
                `当前收到 ${act.viewRefs.length} 个 refs。`,
            });
            break;
          }

          resolvedMappings.push({
            remoteRef: act.viewRefs[0]!,
            localRef: act.target.startsWith("refs/heads/")
              ? act.target
              : `refs/heads/${act.target}`,
            policy: effectivePolicy,
            viewLabel: act.viewLabel,
          });
          break;
        }

        case "tag": {
          if (act.viewRefs.length === 0) {
            diagnostics.push({
              level: "warn",
              message: `${describeView(act.viewLabel)}：toTag("${act.target}")：view 为空，不会创建 tag。`,
            });
            break;
          }

          if (act.viewRefs.length > 1) {
            diagnostics.push({
              level: "error",
              message:
                `${describeView(act.viewLabel)}：toTag("${act.target}") 需要单一 ref 视图，` +
                `当前收到 ${act.viewRefs.length} 个 refs。`,
            });
            break;
          }

          resolvedMappings.push({
            remoteRef: act.viewRefs[0]!,
            localRef: act.target.startsWith("refs/tags/") ? act.target : `refs/tags/${act.target}`,
            policy: effectivePolicy,
            viewLabel: act.viewLabel,
          });
          break;
        }

        case "head": {
          if (act.viewRefs.length === 0) {
            diagnostics.push({
              level: "warn",
              message: `${describeView(act.viewLabel)}：setHead() 的 view 为空，HEAD 将被跳过。`,
            });
            break;
          }

          if (act.viewRefs.length > 1) {
            diagnostics.push({
              level: "error",
              message:
                `${describeView(act.viewLabel)}：setHead() 需要单一 ref 视图，` +
                `当前收到 ${act.viewRefs.length} 个 refs。`,
            });
            break;
          }

          const targetRemoteRef = act.viewRefs[0]!;
          const lastMapping = [...resolvedMappings]
            .reverse()
            .find((mapping) => isSameRemoteRef(mapping.remoteRef, targetRemoteRef));

          if (!lastMapping) {
            diagnostics.push({
              level: "warn",
              message:
                `${describeView(act.viewLabel)}：setHead() 找不到 view "${targetRemoteRef.name}" ` +
                "对应的前置物化结果，HEAD 将被跳过。",
            });
            break;
          }

          if (!lastMapping.localRef.startsWith("refs/heads/")) {
            diagnostics.push({
              level: "error",
              message:
                `${describeView(act.viewLabel)}：setHead() 只能指向 refs/heads/*。` +
                `当前目标为 "${lastMapping.localRef}"。`,
              refName: lastMapping.localRef,
            });
            break;
          }

          headRequests.push({
            localRef: lastMapping.localRef,
            detach: act.detach ?? false,
            viewLabel: act.viewLabel,
          });
          break;
        }
      }
    }

    const conflictedTargets = new Set<string>();
    const mappingsByLocalRef = new Map<string, ResolvedMapping[]>();
    for (const mapping of resolvedMappings) {
      const existing = mappingsByLocalRef.get(mapping.localRef) ?? [];
      existing.push(mapping);
      mappingsByLocalRef.set(mapping.localRef, existing);
    }
    for (const [localRef, mappings] of mappingsByLocalRef) {
      if (mappings.length <= 1) {
        continue;
      }

      conflictedTargets.add(localRef);
      diagnostics.push({
        level: "error",
        message:
          `本地 ref "${localRef}" 被多个物化动作同时写入：` +
          `${mappings
            .map((mapping) =>
              mapping.viewLabel
                ? `${mapping.remoteRef.name}（${mapping.viewLabel}）`
                : mapping.remoteRef.name,
            )
            .join(", ")}。`,
        refName: localRef,
      });
    }

    const selectedRefs = resolvedMappings.map<PlannedRemoteRef>((mapping) => ({
      remoteRef: mapping.remoteRef,
      localTarget: mapping.localRef,
      policy: mapping.policy,
      viewLabel: mapping.viewLabel,
    }));

    const objectRoots = [
      ...new Set(
        resolvedMappings
          .filter((mapping) => !conflictedTargets.has(mapping.localRef))
          .map((mapping) => mapping.remoteRef.hash)
          .filter((hash) => !backend.objects.exists(hash)),
      ),
    ] as SHA1[];

    const localPreconditions = captureLocalPreconditions(
      resolvedMappings,
      headRequests,
      namespaceOwnerships,
    );

    return {
      resolvedMappings,
      headRequests,
      namespaceOwnerships,
      selectedRefs,
      objectRoots,
      localPreconditions,
      diagnostics,
      conflictedTargets,
    };
  }

  async function fetchPreviewObjects(
    objectRoots: readonly SHA1[],
    localPreconditions: readonly LocalPrecondition[],
  ): Promise<number> {
    if (objectRoots.length === 0) {
      return 0;
    }

    const currentLocalRefs = getLocalRefs(backend.refs);
    const localHaveTips: SHA1[] = [];
    for (const [, hash] of currentLocalRefs) {
      if (!localHaveTips.some((existingHash) => existingHash === hash)) {
        localHaveTips.push(hash);
      }
    }

    if (v2Transport) {
      // v2 fetch：使用 Git Wire 协议 v2 获取对象并写入 store
      const v2Wants = objectRoots.map((h) => h);
      const v2Haves = localHaveTips.length > 0 ? localHaveTips.map((h) => h) : undefined;
      const { objectCount } = await v2FetchObjects(backend.objects, v2Transport, v2Wants, v2Haves);
      validateLocalPreconditions(backend, localPreconditions);
      return objectCount;
    }

    // v1 fetch fallback 已移除，仅支持 v2 fetch
    throw new PreconditionCheckError("v1 fetch is not supported. Use v2 Git Wire Protocol.");
  }

  function finalizePreview(
    skeleton: ReturnType<typeof buildPreviewSkeleton>,
    prefetchedObjects: number,
  ): ImportPreview {
    const diagnostics = [...skeleton.diagnostics];
    const refOperations: PlannedRefOperation[] = [];
    const validHeadTargets = new Set<string>();
    const localRefs = getLocalRefs(backend.refs);

    for (const mapping of skeleton.resolvedMappings) {
      if (skeleton.conflictedTargets.has(mapping.localRef)) {
        continue;
      }

      const existingValue = backend.refs.read(mapping.localRef);
      const existingHash = localRefs.get(mapping.localRef) ?? null;
      const refExists = existingValue !== null;

      if (!backend.objects.exists(mapping.remoteRef.hash)) {
        diagnostics.push({
          level: "error",
          message:
            `${describeView(mapping.viewLabel)}：对象 "${mapping.remoteRef.hash}" ` +
            "在 preview() 预取后仍不存在。",
          refName: mapping.localRef,
        });
        continue;
      }

      let targetHash = mapping.remoteRef.hash;
      if (mapping.localRef.startsWith("refs/heads/")) {
        try {
          targetHash = resolveBranchTargetHash(
            backend.objects,
            mapping.remoteRef.hash,
            mapping.localRef,
          );
        } catch (err: unknown) {
          diagnostics.push({
            level: "error",
            message: `${describeView(mapping.viewLabel)}：${err instanceof Error ? err.message : String(err)}`,
            refName: mapping.localRef,
          });
          continue;
        }
      }

      if (existingHash === targetHash) {
        diagnostics.push({
          level: "info",
          message: `${describeView(mapping.viewLabel)}："${mapping.localRef}" 已是最新，跳过。`,
          refName: mapping.localRef,
        });
        if (mapping.localRef.startsWith("refs/heads/")) {
          validHeadTargets.add(mapping.localRef);
        }
        continue;
      }

      if (refExists && mapping.policy.mode === "create-only") {
        diagnostics.push({
          level: "error",
          message: `${describeView(mapping.viewLabel)}："${mapping.localRef}" 已存在，create-only 策略拒绝更新。`,
          refName: mapping.localRef,
        });
        continue;
      }

      if (refExists && mapping.policy.mode === "fast-forward") {
        if (existingHash === null) {
          diagnostics.push({
            level: "error",
            message:
              `${describeView(mapping.viewLabel)}：ref "${mapping.localRef}" 当前存在，` +
              "但无法解析为可比较的提交哈希。",
            refName: mapping.localRef,
          });
          continue;
        }

        if (!isAncestor(backend.objects, existingHash, targetHash)) {
          diagnostics.push({
            level: "error",
            message:
              `${describeView(mapping.viewLabel)}：ref "${mapping.localRef}" 无法 fast-forward。` +
              `当前 ${existingHash}，目标 ${targetHash}。`,
            refName: mapping.localRef,
          });
          continue;
        }

        diagnostics.push({
          level: "info",
          message: `${describeView(mapping.viewLabel)}："${mapping.localRef}" 的 fast-forward 检查已通过。`,
          refName: mapping.localRef,
        });
      }

      if (refExists && mapping.policy.mode === "mirror") {
        diagnostics.push({
          level: "info",
          message:
            `${describeView(mapping.viewLabel)}："${mapping.localRef}" 将按 mirror 策略覆盖，` +
            "不执行 fast-forward 限制。",
          refName: mapping.localRef,
        });
      }

      refOperations.push({
        localRef: mapping.localRef,
        newHash: targetHash,
        policy: mapping.policy,
        viewLabel: mapping.viewLabel,
      });
      if (mapping.localRef.startsWith("refs/heads/")) {
        validHeadTargets.add(mapping.localRef);
      }
    }

    const pruneOperations: PlannedRefDeletion[] = [];
    const scheduledPruneRefs = new Set<string>();
    for (const ownership of skeleton.namespaceOwnerships.values()) {
      if (!ownership.prune) {
        continue;
      }

      for (const refName of backend.refs.listAll()) {
        if (
          matchRefGlob(ownership.pattern, refName) &&
          !ownership.currentRefs.has(refName) &&
          !scheduledPruneRefs.has(refName)
        ) {
          scheduledPruneRefs.add(refName);
          pruneOperations.push({
            refName,
            reason: `命名空间 "${ownership.pattern}" 的 prune 清理。`,
            namespacePattern: ownership.pattern,
            viewLabel: ownership.viewLabel,
          });
        }
      }
    }

    let headOperation: PlannedHeadOperation | undefined;
    if (skeleton.headRequests.length > 0) {
      const lastHead = skeleton.headRequests[skeleton.headRequests.length - 1]!;
      if (skeleton.conflictedTargets.has(lastHead.localRef)) {
        diagnostics.push({
          level: "error",
          message:
            `${describeView(lastHead.viewLabel)}：setHead() 目标 "${lastHead.localRef}" ` +
            "存在冲突，HEAD 无法确定。",
          refName: lastHead.localRef,
        });
      } else if (!validHeadTargets.has(lastHead.localRef)) {
        diagnostics.push({
          level: "error",
          message:
            `${describeView(lastHead.viewLabel)}：setHead() 目标 "${lastHead.localRef}" ` +
            "对应的 branch 物化未通过校验。",
          refName: lastHead.localRef,
        });
      } else {
        headOperation = {
          targetRef: lastHead.localRef,
          detach: lastHead.detach,
          viewLabel: lastHead.viewLabel,
        };
      }
    }

    if (skeleton.resolvedMappings.length > 0) {
      diagnostics.push({
        level: "info",
        message: `计划更新 ${refOperations.length} 个 ref，删除 ${pruneOperations.length} 个 ref。`,
      });
    }
    if (pruneOperations.length > 0) {
      diagnostics.push({
        level: "info",
        message: `prune 将删除 ${pruneOperations.length} 个陈旧 ref。`,
      });
    }

    return createPreviewResult({
      selectedRefs: skeleton.selectedRefs,
      objectRoots: skeleton.objectRoots,
      prefetchedObjects,
      localPreconditions: skeleton.localPreconditions,
      refOperations,
      headOperation,
      pruneOperations,
      diagnostics,
    });
  }

  const builder: ImportPlanBuilder = {
    materialize(view: ImportView): RefMaterializationBuilder {
      const viewRefs = view.refs;
      const viewLabel = getViewLabel(view);

      const matBuilder: RefMaterializationBuilder = {
        toNamespace(
          targetPattern: string,
          options?: { policy?: RefUpdatePolicy; prune?: boolean },
        ): ImportPlanBuilder {
          actions.push({
            viewRefs,
            viewLabel,
            action: "namespace",
            target: targetPattern,
            policy: options?.policy ? clonePolicy(options.policy) : undefined,
            prune: options?.prune,
          });
          invalidatePreview();
          return builder;
        },

        toBranch(branchName: string, options?: { policy?: RefUpdatePolicy }): ImportPlanBuilder {
          actions.push({
            viewRefs,
            viewLabel,
            action: "branch",
            target: branchName,
            policy: options?.policy ? clonePolicy(options.policy) : { mode: "fast-forward" },
          });
          invalidatePreview();
          return builder;
        },

        toTag(tagName: string, options?: { policy?: RefUpdatePolicy }): ImportPlanBuilder {
          actions.push({
            viewRefs,
            viewLabel,
            action: "tag",
            target: tagName,
            policy: options?.policy ? clonePolicy(options.policy) : { mode: "create-only" },
          });
          invalidatePreview();
          return builder;
        },

        setHead(options?: { detach?: boolean }): ImportPlanBuilder {
          actions.push({
            viewRefs,
            viewLabel,
            action: "head",
            target: "HEAD",
            policy: { mode: "replace" },
            detach: options?.detach,
          });
          invalidatePreview();
          return builder;
        },
      };

      return matBuilder;
    },

    async preview(): Promise<ImportPreview> {
      const currentVersion = planVersion;
      lastPreview = null;
      const skeleton = buildPreviewSkeleton();
      const hasStaticErrors = skeleton.diagnostics.some(
        (diagnostic) => diagnostic.level === "error",
      );

      let prefetchedObjects = 0;
      if (!hasStaticErrors) {
        try {
          prefetchedObjects = await fetchPreviewObjects(
            skeleton.objectRoots,
            skeleton.localPreconditions,
          );
        } catch (err: unknown) {
          if (err instanceof PreconditionCheckError) {
            const preview = createPreviewResult({
              selectedRefs: skeleton.selectedRefs,
              objectRoots: skeleton.objectRoots,
              prefetchedObjects,
              localPreconditions: skeleton.localPreconditions,
              refOperations: [],
              pruneOperations: [],
              diagnostics: [
                ...skeleton.diagnostics,
                {
                  level: "error",
                  message: err.message,
                },
              ],
            });
            lastPreview = null;
            return preview;
          }
          throw err;
        }
      }

      const preview = finalizePreview(skeleton, prefetchedObjects);
      if (preview.canApply && currentVersion === planVersion) {
        lastPreview = {
          version: currentVersion,
          preview,
        };
      } else {
        lastPreview = null;
      }
      return preview;
    },

    async apply(): Promise<ImportApplyResult> {
      const p =
        lastPreview !== null && lastPreview.version === planVersion
          ? lastPreview.preview
          : await builder.preview();

      if (!p.canApply) {
        const errorMessages = p.diagnostics
          .filter((d) => d.level === "error")
          .map((d) => d.message)
          .join("; ");
        throw new Error(
          `导入计划包含 ${p.diagnostics.filter((d) => d.level === "error").length} 个错误，无法执行。` +
            (errorMessages ? ` 错误：${errorMessages}` : ""),
        );
      }

      const currentLocalRefs = validateLocalPreconditions(backend, p.localPreconditions);

      if (
        p.refOperations.length === 0 &&
        p.objectRoots.length === 0 &&
        !p.headOperation &&
        p.pruneOperations.length === 0
      ) {
        return {
          importedObjects: p.prefetchedObjects,
          updatedRefs: new Map<string, SHA1>(),
          deletedRefs: [],
        };
      }

      const pendingWrites: Array<{ localRef: string; writeHash: SHA1 }> = [];
      for (const op of p.refOperations) {
        const currentValue = backend.refs.read(op.localRef);
        const refExists = currentValue !== null;
        const currentHash = currentLocalRefs.get(op.localRef) ?? null;
        if (!backend.objects.exists(op.newHash)) {
          throw new Error(`导入计划校验失败：对象 "${op.newHash}" 在本地对象库中不存在。`);
        }

        if (op.policy.mode === "create-only" && refExists) {
          throw new Error(
            `导入计划校验失败：ref "${op.localRef}" 已存在，create-only 策略拒绝更新。`,
          );
        }

        if (op.policy.mode === "fast-forward" && refExists) {
          if (currentHash === null) {
            throw new Error(
              `导入计划校验失败：ref "${op.localRef}" 当前存在，但无法解析为可比较的提交哈希。`,
            );
          }
          if (!isAncestor(backend.objects, currentHash, op.newHash)) {
            throw new Error(
              `导入计划校验失败：ref "${op.localRef}" 无法 fast-forward。` +
                `当前 ${currentHash}，目标 ${op.newHash}。`,
            );
          }
        }

        pendingWrites.push({
          localRef: op.localRef,
          writeHash: op.newHash,
        });
      }

      // 事务内执行所有 ref 写入（原子性保障）
      const hooks = backend.refTransactionHooks;
      const tx = backend.refs.beginTransaction(hooks);
      try {
        const updatedRefs = new Map<string, SHA1>();
        for (const op of pendingWrites) {
          tx.write(op.localRef, op.writeHash);
          updatedRefs.set(op.localRef, op.writeHash);
        }

        if (p.headOperation) {
          if (!p.headOperation.targetRef.startsWith("refs/heads/")) {
            throw new Error(
              `导入计划校验失败：setHead() 只能指向 refs/heads/*，当前为 "${p.headOperation.targetRef}"。`,
            );
          }

          if (p.headOperation.detach) {
            const detachedTarget = updatedRefs.get(p.headOperation.targetRef);
            const existingTarget = currentLocalRefs.get(p.headOperation.targetRef);
            const resolvedTarget = detachedTarget ?? existingTarget;

            if (!resolvedTarget) {
              throw new Error(
                `无法将 HEAD detached 到 "${p.headOperation.targetRef}"：目标 ref 不存在。`,
              );
            }

            tx.write("HEAD", resolvedTarget);
          } else {
            tx.write("HEAD", `ref: ${p.headOperation.targetRef}`);
          }
        }

        const deletedRefs: string[] = [];
        for (const op of p.pruneOperations) {
          try {
            tx.delete(op.refName);
            deletedRefs.push(op.refName);
          } catch {
            // 事务中 delete 可能因 RefNotFoundError 失败，忽略
          }
        }

        tx.commit();

        return {
          importedObjects: p.prefetchedObjects,
          updatedRefs,
          deletedRefs,
          headTarget: p.headOperation?.targetRef,
        };
      } catch (e) {
        tx.rollback();
        throw e;
      }
    },
  };

  return builder;
}
