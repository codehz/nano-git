/**
 * 仓库 fetch 内部编排
 *
 * 将 repo.fetch(url) 委托给 ImportSession 完成实际工作。
 */

import { ImportError } from "../../errors.ts";
import { parseRefSpec } from "../../transport/protocol/refspec.ts";
import { globToRegex } from "../import/import-glob.ts";
import { createRepoImportOperations } from "../import/import-session.ts";

import type { RepositoryBackend } from "../../backend/types.ts";
import type { RemoteSource } from "../../remote/types.ts";
import type { RemoteRef } from "../../transport/protocol/types.ts";
import type {
  ImportPrepareOptions,
  ImportPreparedPreview,
  ImportView,
  ImportSession,
  ImportApplyResult,
} from "../import/import-session-types.ts";
import type {
  RepositoryFetchOptions,
  RepositoryFetchResult,
  FetchRefUpdateResult,
} from "./fetch-types.ts";

/**
 * 按 URL fetch
 */
export async function runFetchToUrl(
  backend: RepositoryBackend,
  url: string,
  options?: RepositoryFetchOptions,
): Promise<RepositoryFetchResult> {
  // 创建 ImportSession（内部会拉取 advertisement）
  const ops = createRepoImportOperations(backend);
  const source: RemoteSource = {
    url,
    auth: options?.auth,
    headers: options?.headers,
  };
  const session = await ops.openImportSession(source);

  if (options?.refSpecs) {
    return applyCustomRefSpecs(backend, session, options);
  }

  return applyDefaultMapping(backend, session, options, shouldMaterializeDefaultTags(options));
}

function hasShallowFetchRequest(options?: RepositoryFetchOptions): boolean {
  return (
    options?.depth !== undefined ||
    options?.deepen !== undefined ||
    options?.shallowSince !== undefined ||
    (options?.shallowExclude?.length ?? 0) > 0 ||
    options?.unshallow === true
  );
}

const TAG_REF_MATCH_PROBE = "refs/tags/__nano_git_probe__";

function patternMaySelectTagRefs(pattern: string): boolean {
  if (pattern.startsWith("refs/tags/")) {
    return true;
  }

  return globToRegex(pattern).test(TAG_REF_MATCH_PROBE);
}

function refPatternsRequestExplicitTags(patterns?: readonly string[]): boolean {
  return patterns?.some((pattern) => patternMaySelectTagRefs(pattern)) ?? false;
}

function isCanonicalHeadsAndTagsRefPatterns(patterns?: readonly string[]): boolean {
  if (patterns === undefined) {
    return false;
  }

  const uniquePatterns = new Set(patterns);
  return (
    uniquePatterns.size === 2 &&
    uniquePatterns.has("refs/heads/*") &&
    uniquePatterns.has("refs/tags/*")
  );
}

function refSpecsRequestExplicitTags(refSpecs?: readonly string[]): boolean {
  return (
    refSpecs?.some((refSpecStr) => {
      const spec = parseRefSpec(refSpecStr);
      const sourcePattern = spec.isWildcard ? `${spec.srcPattern}*` : spec.srcPattern;
      return patternMaySelectTagRefs(sourcePattern);
    }) ?? false
  );
}

function shouldUseCreateOnlyForRefSpecTarget(targetPattern: string): boolean {
  return patternMaySelectTagRefs(targetPattern);
}

function shouldMaterializeDefaultTags(options?: RepositoryFetchOptions): boolean {
  if (options?.noTags === true) {
    return false;
  }

  if (options?.refPatterns !== undefined) {
    return true;
  }

  if (hasShallowFetchRequest(options)) {
    return false;
  }

  return true;
}

function createImportPrepareOptions(
  options?: RepositoryFetchOptions,
  keepIncludeTagWithExplicitTags = false,
  requestedExplicitTags = false,
  skipExplicitLightweightTagsByImplicitFollow = false,
  refetchExistingTagTargetsInShallow = false,
  prioritizeHeadHaveTip = true,
  preferLocalHaveOrderForKnownCommon = false,
  replayKnownCommonInFirstRound = false,
  disableKnownCommonRefHints = false,
  knownCommonAdvertisementPrefixes?: readonly string[],
  includeAdvertisementHeadInKnownCommon = true,
  deferAncestorExpansionUntilRelease = false,
  enforceGitFetchSourceShallowRefRules = false,
): ImportPrepareOptions | undefined {
  if (
    options?.noTags !== true &&
    keepIncludeTagWithExplicitTags !== true &&
    requestedExplicitTags !== true &&
    skipExplicitLightweightTagsByImplicitFollow !== true &&
    refetchExistingTagTargetsInShallow !== true &&
    prioritizeHeadHaveTip !== false &&
    preferLocalHaveOrderForKnownCommon !== true &&
    replayKnownCommonInFirstRound !== true &&
    disableKnownCommonRefHints !== true &&
    knownCommonAdvertisementPrefixes === undefined &&
    includeAdvertisementHeadInKnownCommon !== false &&
    deferAncestorExpansionUntilRelease !== true &&
    enforceGitFetchSourceShallowRefRules !== true &&
    options?.depth === undefined &&
    options?.deepen === undefined &&
    options?.shallowSince === undefined &&
    (options?.shallowExclude?.length ?? 0) === 0 &&
    options?.unshallow !== true
  ) {
    return undefined;
  }

  return {
    noTags: options?.noTags,
    keepIncludeTagWithExplicitTags: keepIncludeTagWithExplicitTags || undefined,
    requestedExplicitTags: requestedExplicitTags || undefined,
    skipExplicitLightweightTagsByImplicitFollow:
      skipExplicitLightweightTagsByImplicitFollow || undefined,
    refetchExistingTagTargetsInShallow: refetchExistingTagTargetsInShallow || undefined,
    prioritizeHeadHaveTip: prioritizeHeadHaveTip === false ? false : undefined,
    preferLocalHaveOrderForKnownCommon: preferLocalHaveOrderForKnownCommon || undefined,
    replayKnownCommonInFirstRound: replayKnownCommonInFirstRound || undefined,
    disableKnownCommonRefHints: disableKnownCommonRefHints || undefined,
    knownCommonAdvertisementPrefixes,
    includeAdvertisementHeadInKnownCommon:
      includeAdvertisementHeadInKnownCommon === false ? false : undefined,
    deferAncestorExpansionUntilRelease: deferAncestorExpansionUntilRelease || undefined,
    sourceShallowRefUpdateMode: enforceGitFetchSourceShallowRefRules
      ? "git-fetch-explicit"
      : undefined,
    depth: options?.depth,
    deepen: options?.deepen,
    shallowSince: options?.shallowSince,
    shallowExclude: options?.shallowExclude,
    unshallow: options?.unshallow,
  };
}

/**
 * 默认 fetch 映射：远端分支 → 本地同名分支；HEAD 仅在远端广告 symref 时更新
 *
 * 默认行为贴近官方 Git：
 * - 分支会物化到本地 `refs/heads/*`
 * - 本地 HEAD 仅当 ls-refs 返回带 symref-target 的 HEAD 时才跟随远端默认分支
 * - 默认 full fetch 会像 `git fetch` 一样把远端可达 tag 物化到本地
 * - 显式 branch-only 的 `refPatterns/refSpecs` 也会像 `git fetch <refspec>` 一样自动跟随可达 tag
 * - 默认 `repo.fetch()` 的显式 shallow 请求下，tag 仅通过协议层 `include-tag` 自动跟随可达对象，
 *   不默认创建本地 `refs/tags/*`
 * - 若调用方通过 `refPatterns` 显式请求 tag，则按请求物化到本地 `refs/tags/*`
 */
async function applyDefaultMapping(
  backend: RepositoryBackend,
  session: ImportSession,
  options?: RepositoryFetchOptions,
  materializeDefaultTags = false,
): Promise<RepositoryFetchResult> {
  const selectedRefs = options?.refPatterns
    ? session.selectRefs(options.refPatterns)
    : session.allRefs();
  const branches = selectedRefs.where((ref) => ref.name.startsWith("refs/heads/"));
  const selectedTags = selectedRefs.where((ref) => ref.name.startsWith("refs/tags/"));
  const requestedExplicitTags = refPatternsRequestExplicitTags(options?.refPatterns);
  const shouldNarrowTagOnlyNegotiation = !hasShallowFetchRequest(options);

  if (
    isCanonicalHeadsAndTagsRefPatterns(options?.refPatterns) &&
    !hasShallowFetchRequest(options)
  ) {
    return applyCustomRefSpecs(backend, session, {
      ...options,
      refSpecs: ["refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"],
    });
  }

  if (options?.refPatterns !== undefined && requestedExplicitTags && options?.noTags === true) {
    return applyDefaultRefProjection(
      session,
      selectedRefs,
      branches,
      options,
      true,
      false,
      true,
      false,
      true,
      branches.refs.length === 0,
      branches.refs.length === 0,
      false,
      false,
      branches.refs.length === 0 && shouldNarrowTagOnlyNegotiation ? ["refs/tags/"] : undefined,
      true,
      shouldNarrowTagOnlyNegotiation,
    );
  }

  if (options?.refPatterns !== undefined && requestedExplicitTags && branches.refs.length === 0) {
    return applyDefaultRefProjection(
      session,
      selectedRefs,
      branches,
      options,
      true,
      options?.noTags !== true && selectedTags.refs.length > 0,
      true,
      false,
      true,
      true,
      false,
      false,
      false,
      shouldNarrowTagOnlyNegotiation ? ["refs/tags/"] : undefined,
      true,
      shouldNarrowTagOnlyNegotiation,
    );
  }

  if (!materializeDefaultTags) {
    return applyDefaultRefProjection(
      session,
      selectedRefs,
      branches,
      options,
      materializeDefaultTags,
      false,
      requestedExplicitTags,
      false,
      false,
      true,
      false,
      false,
      false,
    );
  }

  if (options?.refPatterns !== undefined && requestedExplicitTags) {
    return applyDefaultRefProjection(
      session,
      selectedRefs,
      branches,
      options,
      true,
      false,
      true,
      false,
      true,
      false,
      false,
      false,
      false,
    );
  }

  const tagRefs =
    options?.refPatterns !== undefined
      ? session.select("refs/tags/*")
      : selectedRefs.where((ref) => ref.name.startsWith("refs/tags/"));
  const branchProjectionHashes = new Set(branches.refs.map((ref) => ref.hash));
  const initialDefaultTags = collectInitialDefaultTags(
    backend,
    tagRefs.refs,
    branchProjectionHashes,
  );

  const primaryPlan = session.plan();
  materializeBranches(primaryPlan, branches, options);
  materializeTags(primaryPlan, tagRefs, initialDefaultTags);
  materializeHead(primaryPlan, session, branches);

  const primaryResult = await (
    await primaryPlan
      .build()
      .prepare(
        createImportPrepareOptions(
          options,
          initialDefaultTags.length > 0,
          false,
          initialDefaultTags.length > 0,
          false,
          options?.refPatterns !== undefined ? false : true,
          false,
          false,
          false,
          undefined,
          options?.refPatterns !== undefined ? false : true,
          false,
          options?.refPatterns !== undefined,
        ),
      )
  ).apply();

  const backfillTags = collectBackfillDefaultTags(backend, tagRefs.refs);
  if (backfillTags.length === 0) {
    return convertToFetchResult(primaryResult);
  }

  const tagPlan = session.plan();
  materializeTags(tagPlan, tagRefs, backfillTags);
  const tagResult = await (
    await tagPlan
      .build()
      .prepare(
        createImportPrepareOptions(
          options,
          true,
          false,
          true,
          false,
          options?.refPatterns !== undefined ? false : true,
          false,
          false,
          false,
          undefined,
          options?.refPatterns !== undefined ? false : true,
          options?.refPatterns !== undefined,
        ),
      )
  ).apply();

  return mergeFetchResults(convertToFetchResult(primaryResult), convertToFetchResult(tagResult));
}

async function applyDefaultRefProjection(
  session: ImportSession,
  selectedRefs: ImportView,
  branches: ImportView,
  options?: RepositoryFetchOptions,
  materializeTagsBySelection = false,
  keepIncludeTagWithExplicitTags = false,
  requestedExplicitTags = false,
  skipExplicitLightweightTagsByImplicitFollow = false,
  refetchExistingTagTargetsInShallow = false,
  prioritizeHeadHaveTip = true,
  preferLocalHaveOrderForKnownCommon = false,
  replayKnownCommonInFirstRound = false,
  disableKnownCommonRefHints = false,
  knownCommonAdvertisementPrefixes?: readonly string[],
  includeAdvertisementHeadInKnownCommon = true,
  deferAncestorExpansionUntilRelease = false,
): Promise<RepositoryFetchResult> {
  const plan = session.plan();
  const prepareOptions = createImportPrepareOptions(
    options,
    keepIncludeTagWithExplicitTags,
    requestedExplicitTags,
    skipExplicitLightweightTagsByImplicitFollow,
    refetchExistingTagTargetsInShallow,
    prioritizeHeadHaveTip,
    preferLocalHaveOrderForKnownCommon,
    replayKnownCommonInFirstRound,
    disableKnownCommonRefHints,
    knownCommonAdvertisementPrefixes,
    includeAdvertisementHeadInKnownCommon,
    deferAncestorExpansionUntilRelease,
    options?.refPatterns !== undefined,
  );

  // 所有远端分支 → refs/heads/*（fast-forward）
  materializeBranches(plan, branches, options);

  // 默认 full fetch 会像官方 git fetch 一样把可达 tag 物化到本地。
  // 显式 shallow 请求或 noTags 已在上游判定里关闭。
  if (materializeTagsBySelection) {
    const tags = selectedRefs.where((ref) => ref.name.startsWith("refs/tags/"));
    materializeTags(plan, tags, tags.refs);
  }

  // HEAD → 仅当远端广告了 HEAD symref 时跟随
  materializeHead(plan, session, branches);

  const result = await (await plan.build().prepare(prepareOptions)).apply();
  return convertToFetchResult(result);
}

/**
 * 自定义 refSpec 映射
 */
async function applyCustomRefSpecs(
  backend: RepositoryBackend,
  session: ImportSession,
  options: RepositoryFetchOptions,
): Promise<RepositoryFetchResult> {
  const explicitTagRefSpecs = refSpecsRequestExplicitTags(options.refSpecs);
  const plan = session.plan();
  const selectedRemoteRefs: RemoteRef[] = [];

  for (const specStr of options.refSpecs ?? []) {
    const spec = parseRefSpec(specStr);
    const srcPattern = spec.isWildcard ? `${spec.srcPattern}*` : spec.srcPattern;
    const dstPattern = spec.isWildcard ? `${spec.dstPattern}*` : spec.dstPattern;

    // 处理 + 前缀的 force
    const isForce = specStr.startsWith("+") || spec.force || options.force;

    const view = session.select(srcPattern);
    if (view.refs.length > 0) {
      selectedRemoteRefs.push(...view.refs);
      const policy = isForce
        ? { mode: "replace" as const }
        : shouldUseCreateOnlyForRefSpecTarget(dstPattern)
          ? { mode: "create-only" as const }
          : { mode: "fast-forward" as const };

      plan.materialize(view).toNamespace(dstPattern, { policy });
    }
  }

  const shouldFollowImplicitTags = options.noTags !== true && !explicitTagRefSpecs;
  const tagRefs = shouldFollowImplicitTags ? session.select("refs/tags/*") : undefined;
  const fetchedTargetHashes = new Set(selectedRemoteRefs.map((ref) => ref.hash));
  const initialDefaultTags =
    shouldFollowImplicitTags && tagRefs
      ? collectInitialDefaultTags(backend, tagRefs.refs, fetchedTargetHashes)
      : [];
  if (tagRefs) {
    materializeTags(plan, tagRefs, initialDefaultTags);
  }
  const deferAncestorExpansionUntilRelease =
    !hasShallowFetchRequest(options) &&
    explicitTagRefSpecs &&
    selectedRemoteRefs.length > 0 &&
    selectedRemoteRefs.every((ref) => ref.name.startsWith("refs/tags/"));

  const prepareOptions = createImportPrepareOptions(
    options,
    explicitTagRefSpecs || initialDefaultTags.length > 0,
    explicitTagRefSpecs,
    initialDefaultTags.length > 0,
    explicitTagRefSpecs,
    false,
    false,
    false,
    false,
    deferAncestorExpansionUntilRelease ? ["refs/tags/"] : undefined,
    false,
    deferAncestorExpansionUntilRelease,
    true,
  );
  const prepared = await plan.build().prepare(prepareOptions);
  if (prepared.preview.canApply) {
    const result = await prepared.apply();
    if (
      !shouldFollowImplicitTags ||
      !tagRefs ||
      previewHasSourceShallowRefRejection(prepared.preview)
    ) {
      return convertToFetchResult(result);
    }

    const backfillTags = collectBackfillDefaultTags(backend, tagRefs.refs);
    if (backfillTags.length === 0) {
      return convertToFetchResult(result);
    }

    const tagPlan = session.plan();
    materializeTags(tagPlan, tagRefs, backfillTags);
    const tagResult = await (
      await tagPlan
        .build()
        .prepare(
          createImportPrepareOptions(options, true, false, true, false, true, false, false, false),
        )
    ).apply();

    return mergeFetchResults(convertToFetchResult(result), convertToFetchResult(tagResult));
  }

  if (canApplyCustomRefSpecsPartially(prepared.preview)) {
    await prepared.applyPartial();
  }

  throw createPreparedPreviewError(prepared.preview);
}

function canApplyCustomRefSpecsPartially(preview: ImportPreparedPreview): boolean {
  return (
    preview.refOperations.length > 0 &&
    preview.headOperation === undefined &&
    preview.diagnostics
      .filter((diagnostic) => diagnostic.level === "error")
      .every((diagnostic) => diagnostic.refName !== undefined)
  );
}

function createPreparedPreviewError(preview: ImportPreparedPreview): ImportError {
  const errors = preview.diagnostics.filter((diagnostic) => diagnostic.level === "error");
  const errorMessages = errors.map((diagnostic) => diagnostic.message).join("; ");
  return new ImportError(
    `导入计划包含 ${errors.length} 个错误，无法执行。` +
      (errorMessages ? ` 错误：${errorMessages}` : ""),
    { phase: "prepare" },
  );
}

function convertToFetchResult(result: ImportApplyResult): RepositoryFetchResult {
  const updatedRefs: FetchRefUpdateResult[] = [];

  for (const [refName, newHash] of result.updatedRefs) {
    updatedRefs.push({
      refName,
      oldHash: null,
      newHash,
      success: true,
      forced: false,
    });
  }

  for (const refName of result.deletedRefs) {
    updatedRefs.push({
      refName,
      oldHash: null,
      newHash: null,
      success: true,
      forced: false,
    });
  }

  return {
    updatedRefs,
    objectCount: result.importedObjects,
    progress: [],
  };
}

function materializeBranches(
  plan: ReturnType<ImportSession["plan"]>,
  branches: ImportView,
  options?: RepositoryFetchOptions,
): void {
  if (branches.refs.length === 0) {
    return;
  }

  plan.materialize(branches).toNamespace("refs/heads/*", {
    policy: { mode: "fast-forward" },
    prune: options?.prune,
  });
}

function materializeTags(
  plan: ReturnType<ImportSession["plan"]>,
  allTags: ImportView,
  refs: readonly RemoteRef[],
): void {
  if (refs.length === 0) {
    return;
  }

  const selectedNames = new Set(refs.map((ref) => ref.name));
  const selectedView = allTags.where((ref) => selectedNames.has(ref.name));
  if (selectedView.refs.length === 0) {
    return;
  }

  plan.materialize(selectedView).toNamespace("refs/tags/*", {
    policy: { mode: "create-only" },
  });
}

function materializeHead(
  plan: ReturnType<ImportSession["plan"]>,
  session: ImportSession,
  branches: ImportView,
): void {
  const headTarget = session.headTarget();
  if (
    headTarget.refs.length > 0 &&
    branches.refs.some((ref) => ref.name === headTarget.refs[0]?.name)
  ) {
    plan.materialize(headTarget).setHead();
  }
}

function collectInitialDefaultTags(
  backend: RepositoryBackend,
  refs: readonly RemoteRef[],
  branchProjectionHashes: ReadonlySet<string>,
): RemoteRef[] {
  return refs.filter((ref) => {
    if (backend.refs.read(ref.name) !== null) {
      return false;
    }

    if (ref.peeled !== undefined) {
      return (
        backend.objects.exists(ref.hash) ||
        backend.objects.exists(ref.peeled) ||
        branchProjectionHashes.has(ref.peeled)
      );
    }

    return backend.objects.exists(ref.hash) || branchProjectionHashes.has(ref.hash);
  });
}

function collectBackfillDefaultTags(
  backend: RepositoryBackend,
  refs: readonly RemoteRef[],
): RemoteRef[] {
  return refs.filter((ref) => {
    if (backend.refs.read(ref.name) !== null) {
      return false;
    }

    const targetHash = ref.peeled ?? ref.hash;
    return backend.objects.exists(ref.hash) || backend.objects.exists(targetHash);
  });
}

function mergeFetchResults(
  primary: RepositoryFetchResult,
  secondary: RepositoryFetchResult,
): RepositoryFetchResult {
  return {
    updatedRefs: [...primary.updatedRefs, ...secondary.updatedRefs],
    objectCount: primary.objectCount + secondary.objectCount,
    progress: [...primary.progress, ...secondary.progress],
  };
}

function previewHasSourceShallowRefRejection(preview: ImportPreparedPreview): boolean {
  return preview.diagnostics.some((diagnostic) =>
    diagnostic.message.includes("source-shallow 拒绝更新"),
  );
}
