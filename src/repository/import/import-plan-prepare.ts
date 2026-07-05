import { PreconditionCheckError } from "../../errors.ts";
import { resolveRefHash } from "../../refs/resolve.ts";
import { v2FetchObjects } from "../../transport/client/upload-pack/fetch.ts";
import {
  collectReachable,
  isAncestor,
  peelTagChain,
} from "../../transport/protocol/object-graph.ts";
import { getLocalRefs } from "../../transport/protocol/ref-collection.ts";
import { resolveBranchTargetHash } from "../../transport/protocol/update-refs.ts";
import { matchRefGlob } from "./import-glob.ts";
import { snapshotOwnedRefs, validateLocalPreconditions } from "./import-plan-preconditions.ts";
import {
  deepFreeze,
  type CompiledImportPlanState,
  type LocalPrecondition,
  type PreparedImportPlanState,
} from "./import-plan-types.ts";

import type { SHA1 } from "../../types/index.ts";
import type { ShallowUpdate } from "../../types/shallow.ts";
import type {
  ImportDiagnostic,
  ImportPrepareOptions,
  ImportPreparedPreview,
  PlannedHeadOperation,
  PlannedRefDeletion,
  PlannedRefOperation,
} from "./import-session-types.ts";

/** `git fetch --unshallow` 在协议层使用的无限深度常量 */
const INFINITE_DEPTH = 0x7fffffff;

function collectNegotiationLocalHaveTips(compiled: CompiledImportPlanState): SHA1[] {
  const refNames = compiled.backend.refs.listAll();
  const headValue = compiled.backend.refs.read("HEAD");
  const headTarget =
    headValue !== null && headValue.startsWith("ref: ")
      ? headValue.slice("ref: ".length)
      : undefined;
  const orderedRefNames =
    headTarget && refNames.includes(headTarget)
      ? [headTarget, ...refNames.filter((refName) => refName !== headTarget)]
      : refNames;
  const localHaveTips: SHA1[] = [];
  const seen = new Set<SHA1>();

  for (const refName of orderedRefNames) {
    const hash = resolveRefHash(compiled.backend.refs, refName);
    if (hash === null || seen.has(hash)) {
      continue;
    }
    seen.add(hash);
    localHaveTips.push(hash);
  }

  return localHaveTips;
}

function describeView(viewLabel?: string): string {
  return viewLabel ? `命名视图 "${viewLabel}"` : "当前视图";
}

function freezePreparedPreview(preview: ImportPreparedPreview): ImportPreparedPreview {
  return deepFreeze({
    remoteSnapshot: preview.remoteSnapshot,
    objectRoots: preview.objectRoots,
    prefetchedObjects: preview.prefetchedObjects,
    shallowUpdate: preview.shallowUpdate,
    refOperations: preview.refOperations,
    headOperation: preview.headOperation,
    pruneOperations: preview.pruneOperations,
    diagnostics: preview.diagnostics,
    canApply: preview.canApply,
  });
}

function createPreparedPreview(params: {
  readonly remoteSnapshot: CompiledImportPlanState["advertisement"];
  readonly objectRoots: readonly SHA1[];
  readonly prefetchedObjects: number;
  readonly shallowUpdate?: ShallowUpdate;
  readonly refOperations: readonly PlannedRefOperation[];
  readonly headOperation?: PlannedHeadOperation;
  readonly pruneOperations: readonly PlannedRefDeletion[];
  readonly diagnostics: readonly ImportDiagnostic[];
}): ImportPreparedPreview {
  return freezePreparedPreview({
    remoteSnapshot: params.remoteSnapshot,
    objectRoots: params.objectRoots,
    prefetchedObjects: params.prefetchedObjects,
    shallowUpdate: params.shallowUpdate,
    refOperations: params.refOperations,
    headOperation: params.headOperation,
    pruneOperations: params.pruneOperations,
    diagnostics: params.diagnostics,
    canApply: !params.diagnostics.some((diagnostic) => diagnostic.level === "error"),
  });
}

function resolveLocalShallowBoundaries(compiled: CompiledImportPlanState): SHA1[] | undefined {
  const localShallow = compiled.backend.shallow.read();
  return localShallow.length > 0 ? localShallow : undefined;
}

function hasShallowFetchRequest(options?: ImportPrepareOptions): boolean {
  return (
    options?.depth !== undefined ||
    options?.deepen !== undefined ||
    options?.shallowSince !== undefined ||
    (options?.shallowExclude?.length ?? 0) > 0 ||
    options?.unshallow === true
  );
}

function validateImportPrepareOptions(
  compiled: CompiledImportPlanState,
  options?: ImportPrepareOptions,
): void {
  if (options?.depth !== undefined && options.depth < 1) {
    throw new Error(`depth 必须是正整数，当前为 ${options.depth}。`);
  }

  if (options?.deepen !== undefined && options.deepen < 1) {
    throw new Error(`deepen 必须是正整数，当前为 ${options.deepen}。`);
  }

  if (options?.depth !== undefined && options?.deepen !== undefined) {
    throw new Error("depth 与 deepen 不能同时指定。");
  }

  if (options?.depth !== undefined && options?.unshallow) {
    throw new Error("depth 与 unshallow 不能同时指定。");
  }

  if (options?.unshallow && resolveLocalShallowBoundaries(compiled) === undefined) {
    throw new Error("unshallow 仅适用于 shallow 仓库。");
  }
}

function createNegotiationFetchOptions(
  compiled: CompiledImportPlanState,
  options?: ImportPrepareOptions,
): {
  readonly includeTag: boolean;
  readonly shallow?: string[];
  readonly deepen?: number;
  readonly deepenRelative?: boolean;
  readonly deepenSince?: number;
  readonly deepenNot?: string[];
} {
  const shallow = resolveLocalShallowBoundaries(compiled)?.map((hash) => hash);
  const useUnshallow = options?.unshallow === true;

  return {
    includeTag: !compiled.wantsExplicitTags,
    shallow,
    deepen: useUnshallow ? INFINITE_DEPTH : (options?.depth ?? options?.deepen),
    deepenRelative: options?.deepen !== undefined,
    deepenSince: options?.shallowSince,
    deepenNot: options?.shallowExclude ? [...options.shallowExclude] : undefined,
  };
}

function collectKnownCommonRefs(
  compiled: CompiledImportPlanState,
  localHaveTips: readonly SHA1[],
): SHA1[] {
  if (localHaveTips.length === 0) {
    return [];
  }

  const reachable = collectReachable(compiled.backend.objects, [...localHaveTips], "skip");
  const knownCommonRefs: SHA1[] = [];
  const knownCommonSeen = new Set<SHA1>();

  for (const ref of compiled.advertisement.refs) {
    const peeled = ref.peeled ?? peelTagChain(compiled.backend.objects, ref.hash);
    if (
      !compiled.backend.objects.exists(peeled) ||
      !reachable.has(peeled) ||
      knownCommonSeen.has(peeled)
    ) {
      continue;
    }

    knownCommonSeen.add(peeled);
    knownCommonRefs.push(peeled);
  }

  return knownCommonRefs;
}

function captureLocalPreconditions(
  compiled: CompiledImportPlanState,
): readonly LocalPrecondition[] {
  const affectedRefNames = new Set<string>();
  for (const mapping of compiled.resolvedMappings) {
    affectedRefNames.add(mapping.localRef);
  }
  if (compiled.headRequests.length > 0) {
    affectedRefNames.add("HEAD");
  }

  const localRefs = getLocalRefs(compiled.backend.refs);
  const localPreconditions: LocalPrecondition[] = [];
  for (const refName of affectedRefNames) {
    const expectedValue = compiled.backend.refs.read(refName);
    localPreconditions.push({
      refName,
      expectedHash: localRefs.get(refName) ?? null,
      expectedValue,
    });
  }

  for (const ownership of compiled.namespaceOwnerships.values()) {
    if (!ownership.prune) {
      continue;
    }
    localPreconditions.push({
      refName: ownership.pattern,
      expectedHash: null,
      namespacePrefix: ownership.prefix,
      namespacePattern: ownership.pattern,
      expectedRefs: snapshotOwnedRefs(compiled.backend, ownership.pattern),
    });
  }

  return localPreconditions;
}

async function fetchPreviewObjects(
  compiled: CompiledImportPlanState,
  wantSequence: readonly SHA1[],
  localPreconditions: readonly LocalPrecondition[],
  options?: ImportPrepareOptions,
): Promise<{ objectCount: number; shallowUpdate?: ShallowUpdate }> {
  if (wantSequence.length === 0) {
    return { objectCount: 0 };
  }

  const localHaveTips = collectNegotiationLocalHaveTips(compiled);
  const knownCommonRefs = collectKnownCommonRefs(compiled, localHaveTips);

  if (compiled.v2Transport) {
    const v2Wants = wantSequence.map((hash) => hash);
    const v2Haves = localHaveTips.length > 0 ? localHaveTips.map((hash) => hash) : undefined;
    const { objectCount, shallowUpdate } = await v2FetchObjects(
      compiled.backend.objects,
      compiled.v2Transport,
      v2Wants,
      v2Haves,
      compiled.fetchFeatures ? [...compiled.fetchFeatures] : undefined,
      knownCommonRefs,
      createNegotiationFetchOptions(compiled, options),
    );
    validateLocalPreconditions(compiled.backend, localPreconditions);
    return { objectCount, shallowUpdate };
  }

  throw new PreconditionCheckError("v1 fetch is not supported. Use v2 Git Wire Protocol.");
}

function finalizePreparedState(
  compiled: CompiledImportPlanState,
  objectRoots: readonly SHA1[],
  prefetchedObjects: number,
  shallowUpdate: ShallowUpdate | undefined,
  localPreconditions: readonly LocalPrecondition[],
): PreparedImportPlanState {
  const diagnostics = [...compiled.diagnostics];
  const refOperations: PlannedRefOperation[] = [];
  const validHeadTargets = new Set<string>();
  const localRefs = getLocalRefs(compiled.backend.refs);
  const localShallowBoundaries = resolveLocalShallowBoundaries(compiled);
  const localShallowSet =
    localShallowBoundaries !== undefined ? new Set<SHA1>(localShallowBoundaries) : undefined;

  for (const mapping of compiled.resolvedMappings) {
    if (compiled.conflictedTargets.has(mapping.localRef)) {
      continue;
    }

    const existingValue = compiled.backend.refs.read(mapping.localRef);
    const existingHash = localRefs.get(mapping.localRef) ?? null;
    const refExists = existingValue !== null;

    if (!compiled.backend.objects.exists(mapping.remoteRef.hash)) {
      diagnostics.push({
        level: "error",
        message:
          `${describeView(mapping.viewLabel)}：对象 "${mapping.remoteRef.hash}" ` +
          "在 prepare() 预取后仍不存在。",
        refName: mapping.localRef,
      });
      continue;
    }

    let targetHash = mapping.remoteRef.hash;
    if (mapping.localRef.startsWith("refs/heads/")) {
      try {
        targetHash = resolveBranchTargetHash(
          compiled.backend.objects,
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

      if (!isAncestor(compiled.backend.objects, existingHash, targetHash, localShallowSet)) {
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
  for (const ownership of compiled.namespaceOwnerships.values()) {
    if (!ownership.prune) {
      continue;
    }

    for (const refName of compiled.backend.refs.listAll()) {
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
  if (compiled.headRequests.length > 0) {
    const lastHead = compiled.headRequests[compiled.headRequests.length - 1]!;
    if (compiled.conflictedTargets.has(lastHead.localRef)) {
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

  if (compiled.resolvedMappings.length > 0) {
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

  return {
    preview: createPreparedPreview({
      remoteSnapshot: compiled.advertisement,
      objectRoots,
      prefetchedObjects,
      shallowUpdate,
      refOperations,
      headOperation,
      pruneOperations,
      diagnostics,
    }),
    shallowUpdate,
    preconditions: localPreconditions,
    refOperations,
    headOperation,
    pruneOperations,
  };
}

export async function prepareImportPlan(
  compiled: CompiledImportPlanState,
  options?: ImportPrepareOptions,
): Promise<PreparedImportPlanState> {
  if (compiled.diagnostics.some((diagnostic) => diagnostic.level === "error")) {
    return {
      preview: createPreparedPreview({
        remoteSnapshot: compiled.advertisement,
        objectRoots: [],
        prefetchedObjects: 0,
        shallowUpdate: undefined,
        refOperations: [],
        pruneOperations: [],
        diagnostics: compiled.diagnostics,
      }),
      preconditions: [],
      refOperations: [],
      pruneOperations: [],
    };
  }

  validateImportPrepareOptions(compiled, options);

  const localPreconditions = captureLocalPreconditions(compiled);
  const shouldFetchExistingTargets = hasShallowFetchRequest(options);
  const wantSequence = compiled.resolvedMappings
    .filter((mapping) => !compiled.conflictedTargets.has(mapping.localRef))
    .map((mapping) => mapping.remoteRef.hash)
    .filter((hash) => shouldFetchExistingTargets || !compiled.backend.objects.exists(hash));
  const objectRoots = [...new Set(wantSequence)] as SHA1[];

  let prefetchedObjects = 0;
  let shallowUpdate: ShallowUpdate | undefined;
  try {
    const fetchPreview = await fetchPreviewObjects(
      compiled,
      wantSequence,
      localPreconditions,
      options,
    );
    prefetchedObjects = fetchPreview.objectCount;
    shallowUpdate = fetchPreview.shallowUpdate;
  } catch (err: unknown) {
    if (err instanceof PreconditionCheckError) {
      return {
        preview: createPreparedPreview({
          remoteSnapshot: compiled.advertisement,
          objectRoots,
          prefetchedObjects,
          shallowUpdate,
          refOperations: [],
          pruneOperations: [],
          diagnostics: [
            ...compiled.diagnostics,
            {
              level: "error",
              message: err.message,
            },
          ],
        }),
        shallowUpdate,
        preconditions: localPreconditions,
        refOperations: [],
        pruneOperations: [],
      };
    }
    throw err;
  }

  return finalizePreparedState(
    compiled,
    objectRoots,
    prefetchedObjects,
    shallowUpdate,
    localPreconditions,
  );
}
