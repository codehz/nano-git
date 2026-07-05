import { PreconditionCheckError } from "../../errors.ts";
import { tryReadObject } from "../../objects/raw.ts";
import { resolveRefHash } from "../../refs/resolve.ts";
import { v2FetchObjects } from "../../transport/client/upload-pack/fetch.ts";
import {
  collectReachable,
  isAncestor,
  peelTagChain,
} from "../../transport/protocol/object-graph.ts";
import { getLocalRefs } from "../../transport/protocol/ref-collection.ts";
import { resolveBranchTargetHash } from "../../transport/protocol/update-refs.ts";
import { formatGitCliShallowSince } from "./git-cli-shallow-since.ts";
import { matchRefGlob } from "./import-glob.ts";
import { snapshotOwnedRefs, validateLocalPreconditions } from "./import-plan-preconditions.ts";
import {
  deepFreeze,
  type CompiledImportPlanState,
  type LocalPrecondition,
  type PreparedImportPlanState,
  type ResolvedMapping,
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

function collectNegotiationLocalHaveTips(
  compiled: CompiledImportPlanState,
  options?: ImportPrepareOptions,
): SHA1[] {
  const refNames = compiled.backend.refs.listAll().filter((refName) => refName !== "HEAD");
  const headValue = compiled.backend.refs.read("HEAD");
  const headTarget =
    headValue !== null && headValue.startsWith("ref: ")
      ? headValue.slice("ref: ".length)
      : undefined;
  const orderedRefNames =
    options?.prioritizeHeadHaveTip !== false && headTarget && refNames.includes(headTarget)
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

function shouldApplyGitFetchExplicitSourceShallowRules(
  localShallowBoundaries: readonly SHA1[] | undefined,
  shallowUpdate: ShallowUpdate | undefined,
  options?: ImportPrepareOptions,
): boolean {
  return (
    options?.sourceShallowRefUpdateMode === "git-fetch-explicit" &&
    localShallowBoundaries === undefined &&
    options?.depth === undefined &&
    shallowUpdate !== undefined &&
    shallowUpdate.shallow.length > 0
  );
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

  if (options?.shallowSince !== undefined && !Number.isSafeInteger(options.shallowSince)) {
    throw new Error(
      `shallowSince 必须是有限整数秒级 Unix 时间戳，当前为 ${String(options.shallowSince)}。`,
    );
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

function isTagMapping(mapping: ResolvedMapping): boolean {
  return mapping.localRef.startsWith("refs/tags/");
}

function isAnnotatedTagMapping(mapping: ResolvedMapping): boolean {
  return isTagMapping(mapping) && mapping.remoteRef.peeled !== undefined;
}

function shouldFollowLightweightTagsImplicitly(options?: ImportPrepareOptions): boolean {
  return options?.skipExplicitLightweightTagsByImplicitFollow === true;
}

function shouldSkipExplicitFetchForLightweightTag(
  mapping: ResolvedMapping,
  branchFetchTargetHashes: ReadonlySet<SHA1>,
  options?: ImportPrepareOptions,
): boolean {
  if (
    !shouldFollowLightweightTagsImplicitly(options) ||
    !isTagMapping(mapping) ||
    isAnnotatedTagMapping(mapping)
  ) {
    return false;
  }

  return !branchFetchTargetHashes.has(mapping.remoteRef.hash);
}

function shouldFetchExistingMappingTarget(
  compiled: CompiledImportPlanState,
  mapping: ResolvedMapping,
  options?: ImportPrepareOptions,
): boolean {
  const currentHash = resolveRefHash(compiled.backend.refs, mapping.localRef);

  if (!isTagMapping(mapping)) {
    return true;
  }

  if (hasShallowFetchRequest(options)) {
    if (currentHash === null || currentHash !== mapping.remoteRef.hash) {
      return true;
    }

    return options?.refetchExistingTagTargetsInShallow === true;
  }

  return currentHash === null || currentHash !== mapping.remoteRef.hash;
}

function shouldIncludeTag(
  fetchMappings: readonly ResolvedMapping[],
  compiled: CompiledImportPlanState,
  options?: ImportPrepareOptions,
): boolean {
  if (options?.noTags === true) {
    return false;
  }

  if (
    options?.keepIncludeTagWithExplicitTags !== true &&
    fetchMappings.some((mapping) => isTagMapping(mapping))
  ) {
    return false;
  }

  if (
    options?.keepIncludeTagWithExplicitTags !== true &&
    (compiled.wantsExplicitTags || options?.requestedExplicitTags === true)
  ) {
    return false;
  }

  return true;
}

function createNegotiationFetchOptions(
  fetchMappings: readonly ResolvedMapping[],
  compiled: CompiledImportPlanState,
  options?: ImportPrepareOptions,
): {
  readonly includeTag: boolean;
  readonly shallow?: string[];
  readonly deepen?: number;
  readonly deepenRelative?: boolean;
  readonly deepenSince?: string;
  readonly deepenNot?: string[];
  readonly replayKnownCommonInFirstRound?: boolean;
  readonly deferAncestorExpansionUntilRelease?: boolean;
} {
  const shallow = resolveLocalShallowBoundaries(compiled)?.map((hash) => hash);
  const useUnshallow = options?.unshallow === true;

  return {
    includeTag: shouldIncludeTag(fetchMappings, compiled, options),
    shallow,
    deepen: useUnshallow ? INFINITE_DEPTH : (options?.depth ?? options?.deepen),
    deepenRelative: options?.deepen !== undefined,
    deepenSince:
      options?.shallowSince !== undefined
        ? formatGitCliShallowSince(options.shallowSince)
        : undefined,
    deepenNot: options?.shallowExclude ? [...options.shallowExclude] : undefined,
    replayKnownCommonInFirstRound: options?.replayKnownCommonInFirstRound,
    deferAncestorExpansionUntilRelease: options?.deferAncestorExpansionUntilRelease,
  };
}

function shouldUseKnownCommonAdvertisementRef(
  refName: string,
  options?: ImportPrepareOptions,
): boolean {
  if (
    options?.knownCommonAdvertisementPrefixes !== undefined &&
    !options.knownCommonAdvertisementPrefixes.some((prefix) => refName.startsWith(prefix))
  ) {
    return false;
  }

  if (refName === "HEAD" && options?.includeAdvertisementHeadInKnownCommon === false) {
    return false;
  }

  if (
    options?.noTags === true &&
    options?.requestedExplicitTags !== true &&
    refName.startsWith("refs/tags/")
  ) {
    return false;
  }

  return true;
}

function collectKnownCommonRefs(
  compiled: CompiledImportPlanState,
  localHaveTips: readonly SHA1[],
  options?: ImportPrepareOptions,
): SHA1[] {
  if (localHaveTips.length === 0) {
    return [];
  }

  const reachable = collectReachable(compiled.backend.objects, [...localHaveTips], "skip");
  const advertisedReachable: SHA1[] = [];
  const advertisedReachableSet = new Set<SHA1>();
  for (const ref of compiled.advertisement.refs) {
    if (!shouldUseKnownCommonAdvertisementRef(ref.name, options)) {
      continue;
    }

    const peeled = ref.peeled ?? peelTagChain(compiled.backend.objects, ref.hash);
    if (
      !compiled.backend.objects.exists(peeled) ||
      !reachable.has(peeled) ||
      advertisedReachableSet.has(peeled)
    ) {
      continue;
    }

    advertisedReachableSet.add(peeled);
    advertisedReachable.push(peeled);
  }

  if (options?.preferLocalHaveOrderForKnownCommon !== true) {
    return advertisedReachable;
  }

  const normalizedLocalHaveTips: SHA1[] = [];
  const normalizedLocalHaveTipSet = new Set<SHA1>();
  for (const hash of localHaveTips) {
    const peeled = peelTagChain(compiled.backend.objects, hash);
    if (!compiled.backend.objects.exists(peeled) || normalizedLocalHaveTipSet.has(peeled)) {
      continue;
    }
    normalizedLocalHaveTipSet.add(peeled);
    normalizedLocalHaveTips.push(peeled);
  }

  const localCandidateSet = new Set(
    normalizedLocalHaveTips.filter((hash) => advertisedReachableSet.has(hash)),
  );
  const localCandidates = [...localCandidateSet].map((hash, index) => {
    const commit = tryReadObject(compiled.backend.objects, hash);
    const timestamp = commit?.type === "commit" ? commit.committer.timestamp : 0;
    return { hash, timestamp, index };
  });
  localCandidates.sort((left, right) =>
    left.timestamp !== right.timestamp
      ? right.timestamp - left.timestamp
      : left.index - right.index,
  );

  const knownCommonRefs: SHA1[] = [];
  const knownCommonSeen = new Set<SHA1>();
  for (const candidate of localCandidates) {
    if (
      knownCommonRefs.some((selected) =>
        isAncestor(compiled.backend.objects, candidate.hash, selected),
      )
    ) {
      continue;
    }
    knownCommonSeen.add(candidate.hash);
    knownCommonRefs.push(candidate.hash);
  }

  for (const hash of advertisedReachable) {
    if (knownCommonSeen.has(hash)) {
      continue;
    }
    if (knownCommonRefs.some((selected) => isAncestor(compiled.backend.objects, hash, selected))) {
      continue;
    }
    knownCommonSeen.add(hash);
    knownCommonRefs.push(hash);
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
  fetchMappings: readonly ResolvedMapping[],
  wantSequence: readonly SHA1[],
  localPreconditions: readonly LocalPrecondition[],
  options?: ImportPrepareOptions,
): Promise<{ objectCount: number; shallowUpdate?: ShallowUpdate }> {
  if (wantSequence.length === 0) {
    return { objectCount: 0 };
  }

  const localHaveTips = collectNegotiationLocalHaveTips(compiled, options);
  const knownCommonRefs =
    options?.disableKnownCommonRefHints === true
      ? []
      : resolveLocalShallowBoundaries(compiled) === undefined && !hasShallowFetchRequest(options)
        ? collectKnownCommonRefs(compiled, localHaveTips, options)
        : [];

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
      createNegotiationFetchOptions(fetchMappings, compiled, options),
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
  branchFetchTargetHashes: ReadonlySet<SHA1>,
  options?: ImportPrepareOptions,
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
      if (shouldSkipExplicitFetchForLightweightTag(mapping, branchFetchTargetHashes, options)) {
        diagnostics.push({
          level: "info",
          message:
            `${describeView(mapping.viewLabel)}："${mapping.localRef}" 对应对象未在默认 fetch 中随分支历史带回，` +
            "跳过 tag 物化。",
          refName: mapping.localRef,
        });
        continue;
      }

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

  if (
    shouldApplyGitFetchExplicitSourceShallowRules(localShallowBoundaries, shallowUpdate, options)
  ) {
    const rejectedHeadOps = refOperations.filter((op) => op.localRef.startsWith("refs/heads/"));
    const rejectedNonHeadOps = refOperations.filter((op) => !op.localRef.startsWith("refs/heads/"));

    if (rejectedHeadOps.length > 0) {
      for (const op of rejectedHeadOps) {
        diagnostics.push({
          level: "error",
          message:
            `${describeView(op.viewLabel)}：source-shallow 拒绝更新 "${op.localRef}"，` +
            "官方 git fetch 在该路径下不会接受新的 shallow roots。",
          refName: op.localRef,
        });
      }
      refOperations.length = 0;
      validHeadTargets.clear();
      shallowUpdate = undefined;
    } else if (rejectedNonHeadOps.length > 0) {
      for (const op of rejectedNonHeadOps) {
        diagnostics.push({
          level: "warn",
          message:
            `${describeView(op.viewLabel)}：source-shallow 拒绝更新 "${op.localRef}"，` +
            "官方 git fetch 在该路径下会跳过该 ref。",
          refName: op.localRef,
        });
      }
      refOperations.length = 0;
      validHeadTargets.clear();
      shallowUpdate = undefined;
    }
  }

  if (
    options?.sourceShallowRefUpdateMode === "git-fetch-explicit" &&
    localShallowBoundaries === undefined &&
    refOperations.some((op) => !op.localRef.startsWith("refs/heads/"))
  ) {
    const effectiveShallow = shallowUpdate?.shallow
      ? new Set<SHA1>(shallowUpdate.shallow)
      : undefined;
    const incompleteNonHeadOps = refOperations.filter((op) => {
      if (op.localRef.startsWith("refs/heads/")) {
        return false;
      }

      try {
        collectReachable(compiled.backend.objects, [op.newHash], "throw", effectiveShallow);
        return false;
      } catch {
        return true;
      }
    });

    if (incompleteNonHeadOps.length > 0) {
      for (const op of incompleteNonHeadOps) {
        diagnostics.push({
          level: "error",
          message:
            `${describeView(op.viewLabel)}：source-shallow 拒绝更新 "${op.localRef}"，` +
            "远端未提供完整对象图，官方 git fetch 在该路径下会直接失败。",
          refName: op.localRef,
        });
      }
      refOperations.length = 0;
      validHeadTargets.clear();
      shallowUpdate = undefined;
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
  const branchFetchTargetHashes = new Set<SHA1>();
  for (const mapping of compiled.resolvedMappings) {
    if (compiled.conflictedTargets.has(mapping.localRef) || isTagMapping(mapping)) {
      continue;
    }

    if (!compiled.backend.objects.exists(mapping.remoteRef.hash)) {
      branchFetchTargetHashes.add(mapping.remoteRef.hash);
      continue;
    }

    if (
      shouldFetchExistingTargets &&
      shouldFetchExistingMappingTarget(compiled, mapping, options)
    ) {
      branchFetchTargetHashes.add(mapping.remoteRef.hash);
    }
  }

  const fetchMappings = compiled.resolvedMappings.filter((mapping) => {
    if (compiled.conflictedTargets.has(mapping.localRef)) {
      return false;
    }

    if (!compiled.backend.objects.exists(mapping.remoteRef.hash)) {
      if (shouldSkipExplicitFetchForLightweightTag(mapping, branchFetchTargetHashes, options)) {
        return false;
      }
      return true;
    }

    return (
      shouldFetchExistingTargets && shouldFetchExistingMappingTarget(compiled, mapping, options)
    );
  });
  const wantSequence = fetchMappings.map((mapping) => mapping.remoteRef.hash);
  const objectRoots = [...new Set(wantSequence)] as SHA1[];

  let prefetchedObjects = 0;
  let shallowUpdate: ShallowUpdate | undefined;
  try {
    const fetchPreview = await fetchPreviewObjects(
      compiled,
      fetchMappings,
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
    branchFetchTargetHashes,
    options,
  );
}
