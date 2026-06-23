/**
 * 仓库 fetch 内部编排
 *
 * 将 repo.fetch(url) 委托给 ImportSession 完成实际工作。
 */

import { parseRefSpec } from "../transport/shared/refspec.ts";

import type { RepositoryBackend } from "./backend/types.ts";
import type {
  RepositoryFetchOptions,
  RepositoryFetchResult,
  FetchRefUpdateResult,
} from "./fetch-types.ts";
import type { ImportSession } from "./import-session-types.ts";

/**
 * 按 URL fetch
 */
export async function runFetchToUrl(
  backend: RepositoryBackend,
  url: string,
  options?: RepositoryFetchOptions,
): Promise<RepositoryFetchResult> {
  // 创建 ImportSession（内部会拉取 advertisement）
  const { createRepoImportOperations } = await import("./import-session.ts");
  const ops = createRepoImportOperations(backend);
  const source: import("./import-session-types.ts").ImportSource = {
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

/**
 * 默认 fetch 映射：远端所有 refs → 本地同名 refs + HEAD 更新
 */
async function applyDefaultMapping(
  session: ImportSession,
  options?: RepositoryFetchOptions,
): Promise<RepositoryFetchResult> {
  const plan = session.plan();

  // 所有远端分支 → refs/heads/*（fast-forward）
  const branches = session.select("refs/heads/*");
  if (branches.refs.length > 0) {
    plan.materialize(branches).toNamespace("refs/heads/*", {
      policy: { mode: "fast-forward" },
      prune: options?.prune,
    });
  }

  // 标签（除非 noTags）
  if (!options?.noTags) {
    const tags = session.select("refs/tags/*");
    if (tags.refs.length > 0) {
      plan.materialize(tags).toNamespace("refs/tags/*", {
        policy: { mode: "fast-forward" },
      });
    }
  }

  // HEAD → 跟随默认分支
  const head = session.headTarget();
  if (head.refs.length > 0) {
    plan.materialize(head).setHead();
  }

  const result = await plan.apply();
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

  const result = await plan.apply();
  return convertToFetchResult(result);
}

function convertToFetchResult(
  result: import("./import-session-types.ts").ImportApplyResult,
): RepositoryFetchResult {
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
