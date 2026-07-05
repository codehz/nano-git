/**
 * 仓库 fetch 内部编排
 *
 * 将 repo.fetch(url) 委托给 ImportSession 完成实际工作。
 */

import { parseRefSpec } from "../../transport/protocol/refspec.ts";
import { createRepoImportOperations } from "../import/import-session.ts";

import type { RepositoryBackend } from "../../backend/types.ts";
import type { RemoteSource } from "../../remote/types.ts";
import type {
  ImportPrepareOptions,
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
    token: options?.token,
    headers: options?.headers,
  };
  const session = await ops.openImportSession(source);

  if (options?.refSpecs) {
    return applyCustomRefSpecs(session, options);
  }

  return applyDefaultMapping(session, options);
}

function createImportPrepareOptions(
  options?: RepositoryFetchOptions,
): ImportPrepareOptions | undefined {
  if (
    options?.noTags !== true &&
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
    depth: options?.depth,
    deepen: options?.deepen,
    shallowSince: options?.shallowSince,
    shallowExclude: options?.shallowExclude,
    unshallow: options?.unshallow,
  };
}

/**
 * 默认 fetch 映射：远端所有 refs → 本地同名 refs + HEAD 更新
 */
async function applyDefaultMapping(
  session: ImportSession,
  options?: RepositoryFetchOptions,
): Promise<RepositoryFetchResult> {
  const plan = session.plan();
  const prepareOptions = createImportPrepareOptions(options);
  const selectedRefs = options?.refPatterns
    ? session.selectRefs(options.refPatterns)
    : session.allRefs();

  // 所有远端分支 → refs/heads/*（fast-forward）
  const branches = selectedRefs.where((ref) => ref.name.startsWith("refs/heads/"));
  if (branches.refs.length > 0) {
    plan.materialize(branches).toNamespace("refs/heads/*", {
      policy: { mode: "fast-forward" },
      prune: options?.prune,
    });
  }

  // 标签（除非 noTags）
  if (!options?.noTags) {
    const tags = selectedRefs.where((ref) => ref.name.startsWith("refs/tags/"));
    if (tags.refs.length > 0) {
      plan.materialize(tags).toNamespace("refs/tags/*", {
        policy: { mode: "fast-forward" },
      });
    }
  }

  // HEAD → 跟随默认分支
  const defaultBranch = session.defaultBranch();
  if (
    defaultBranch.refs.length > 0 &&
    branches.refs.some((ref) => ref.name === defaultBranch.refs[0]?.name)
  ) {
    plan.materialize(defaultBranch).setHead();
  }

  const result = await (await plan.build().prepare(prepareOptions)).apply();
  return convertToFetchResult(result);
}

/**
 * 自定义 refSpec 映射
 */
async function applyCustomRefSpecs(
  session: ImportSession,
  options: RepositoryFetchOptions,
): Promise<RepositoryFetchResult> {
  const plan = session.plan();
  const prepareOptions = createImportPrepareOptions(options);

  for (const specStr of options.refSpecs ?? []) {
    const spec = parseRefSpec(specStr);
    const srcPattern = spec.isWildcard ? `${spec.srcPattern}*` : spec.srcPattern;
    const dstPattern = spec.isWildcard ? `${spec.dstPattern}*` : spec.dstPattern;

    // 处理 + 前缀的 force
    const isForce = specStr.startsWith("+") || spec.force || options.force;

    const view = session.select(srcPattern);
    if (view.refs.length > 0) {
      const policy = isForce ? { mode: "replace" as const } : { mode: "fast-forward" as const };

      plan.materialize(view).toNamespace(dstPattern, { policy });
    }
  }

  const result = await (await plan.build().prepare(prepareOptions)).apply();
  return convertToFetchResult(result);
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
