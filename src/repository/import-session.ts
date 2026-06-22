/**
 * Import Session 实现
 *
 * 包含 session 创建和仓库级别导入操作工厂。
 */

import { createUploadPackHttpClient } from "../transport/smart-http.ts";
import { matchRefGlob } from "./import-glob.ts";
import { createPlanBuilder } from "./import-plan-builder.ts";
import { createImportView } from "./import-view.ts";

import type { RemoteRef, RefAdvertisement, UploadPackTransport } from "../transport/types.ts";
import type { RepositoryBackend } from "./backend/types.ts";
import type {
  ImportSource,
  ImportView,
  ImportSession,
  ImportPlanBuilder,
} from "./import-session-types.ts";

// ============================================================================
// Session 实现
// ============================================================================

/**
 * 创建 ImportSession
 *
 * @param source - 导入源配置
 * @param backend - 仓库后端
 * @param advertisement - 已获取的远端广告快照
 * @returns ImportSession
 */
function createImportSession(
  source: ImportSource,
  backend: RepositoryBackend,
  advertisement: RefAdvertisement,
  transportFactory?: (url: string) => UploadPackTransport,
): ImportSession {
  const frozenSource = Object.freeze({
    url: source.url,
    token: source.token,
    headers: source.headers ? Object.freeze({ ...source.headers }) : undefined,
  }) as Readonly<ImportSource>;

  const frozenRefs = Object.freeze(advertisement.refs.map((ref) => Object.freeze({ ...ref })));

  // 冻结 advertisement 快照，确保会话级别不可变
  const frozenAdvertisement = Object.freeze({
    ...advertisement,
    refs: frozenRefs,
    capabilities: Object.freeze({ ...advertisement.capabilities }),
  }) as Readonly<RefAdvertisement>;

  const allRefs: readonly RemoteRef[] = frozenAdvertisement.refs;

  return {
    source: frozenSource,
    get advertisement(): RefAdvertisement {
      return frozenAdvertisement;
    },

    select(pattern: string): ImportView {
      const filtered = allRefs.filter((ref) => matchRefGlob(pattern, ref.name));
      return createImportView(filtered) as ImportView;
    },

    selectRefs(patterns: readonly string[]): ImportView {
      const seen = new Set<string>();
      const result: RemoteRef[] = [];

      for (const pattern of patterns) {
        for (const ref of allRefs) {
          if (matchRefGlob(pattern, ref.name) && !seen.has(ref.name)) {
            seen.add(ref.name);
            result.push(ref);
          }
        }
      }

      return createImportView(result) as ImportView;
    },

    defaultBranch(): ImportView {
      if (!frozenAdvertisement.defaultBranch) {
        return createImportView([]) as ImportView;
      }

      const ref = allRefs.find((r) => r.name === frozenAdvertisement.defaultBranch);
      return createImportView(ref ? [ref] : []) as ImportView;
    },

    headTarget(): ImportView {
      // HEAD 可能以 "HEAD" 名称出现在 refs 中，其 symrefTarget 指向目标 branch
      const headRef = allRefs.find((r) => r.name === "HEAD");
      if (!headRef?.symrefTarget) {
        return createImportView([]) as ImportView;
      }

      const target = allRefs.find((r) => r.name === headRef.symrefTarget);
      return createImportView(target ? [target] : []) as ImportView;
    },

    allRefs(): ImportView {
      // 排除 "HEAD" 本身（HEAD 不是真正的 ref）
      const refs = allRefs.filter((r) => r.name !== "HEAD");
      return createImportView(refs) as ImportView;
    },

    plan(): ImportPlanBuilder {
      return createPlanBuilder(backend, frozenAdvertisement, frozenSource, transportFactory);
    },
  };
}

// ============================================================================
// RepoImportOperations 工厂
// ============================================================================

/**
 * 创建仓库导入操作
 *
 * @param backend - 仓库后端
 * @returns RepoImportOperations
 */
export function createRepoImportOperations(
  backend: RepositoryBackend,
  transportFactory?: (url: string) => UploadPackTransport,
): import("./import-session-types.ts").RepoImportOperations {
  return {
    async openImportSession(source: ImportSource): Promise<ImportSession> {
      const createTransport =
        transportFactory ??
        ((url: string) =>
          createUploadPackHttpClient(url, {
            token: source.token,
            headers: source.headers,
          }));

      const transport = createTransport(source.url);
      const advertisement = await transport.advertise();

      return createImportSession(source, backend, advertisement, transportFactory);
    },
  };
}

// ============================================================================
// 导出
// ============================================================================

export { createImportSession };
