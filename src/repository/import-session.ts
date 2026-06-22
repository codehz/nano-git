/**
 * Import Session 实现
 *
 * Phase 1：只读会话（advertisement 拉取、view 选择与命名）
 * Phase 2：完整的 PlanBuilder，支持真实的 preview()
 *
 * @see .drafts/import-session-rfc.md
 */

import { fetchPack } from "../transport/fetch-pack.ts";
import { isAncestor } from "../transport/object-graph.ts";
import { getLocalRefs } from "../transport/ref-collection.ts";
import { createUploadPackHttpClient } from "../transport/smart-http.ts";
import { applyRefUpdates, resolveBranchTargetHash } from "../transport/update-refs.ts";

import type { SHA1 } from "../core/types.ts";
import type {
  RemoteRef,
  RefAdvertisement,
  UploadPackTransport,
  RefUpdatePlanItem,
} from "../transport/types.ts";
import type { RepositoryBackend } from "./backend/types.ts";
import type {
  ImportSource,
  ImportView,
  NamedImportView,
  ImportSession,
  ImportPlanBuilder,
  ImportPreview,
  ImportApplyResult,
  ImportDiagnostic,
  LocalPrecondition,
  PlannedRemoteRef,
  PlannedRefOperation,
  PlannedRefDeletion,
  RefMaterializationBuilder,
  RefUpdatePolicy,
  OpenImportSessionOptions,
} from "./import-session-types.ts";

// ============================================================================
// Glob 模式匹配
// ============================================================================

/**
 * 将 glob 模式转换为正则表达式
 *
 * 只支持 `*` 通配符（匹配任意字符，包括 /）。
 * 其他字符按字面量匹配。
 *
 * @param pattern - glob 模式，如 "refs/heads/*"
 * @returns RegExp
 *
 * @example
 * ```ts
 * const re = globToRegex("refs/heads/*");
 * re.test("refs/heads/main"); // true
 * re.test("refs/tags/v1");    // false
 * ```
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexStr = escaped.replace(/\*/g, ".*");
  return new RegExp(`^${regexStr}$`);
}

/**
 * 判断 ref 名称是否匹配 glob 模式
 *
 * @param pattern - glob 模式
 * @param refName - ref 名称
 * @returns 是否匹配
 *
 * @example
 * ```ts
 * matchRefGlob("refs/heads/*", "refs/heads/main"); // true
 * matchRefGlob("refs/tags/v*", "refs/tags/v1.0");  // true
 * ```
 */
function matchRefGlob(pattern: string, refName: string): boolean {
  return globToRegex(pattern).test(refName);
}

// ============================================================================
// View 实现
// ============================================================================

/**
 * 创建 ImportView
 *
 * @param refs - 冻结的远端 ref 列表
 * @param label - 可选的视图标签
 * @returns ImportView 或 NamedImportView
 */
function createImportView(
  refs: readonly RemoteRef[],
  label?: string,
): ImportView | NamedImportView {
  const frozenRefs = Object.freeze([...refs]);

  const view = {
    get refs(): readonly RemoteRef[] {
      return frozenRefs;
    },

    where(predicate: (ref: RemoteRef) => boolean): ImportView {
      return createImportView(frozenRefs.filter(predicate)) as ImportView;
    },

    exclude(pattern: string): ImportView {
      const filtered = frozenRefs.filter((ref) => !matchRefGlob(pattern, ref.name));
      return createImportView(filtered) as ImportView;
    },

    union(other: ImportView): ImportView {
      const seen = new Set<string>();
      const merged: RemoteRef[] = [];

      for (const ref of frozenRefs) {
        if (!seen.has(ref.name)) {
          seen.add(ref.name);
          merged.push(ref);
        }
      }
      for (const ref of other.refs) {
        if (!seen.has(ref.name)) {
          seen.add(ref.name);
          merged.push(ref);
        }
      }

      return createImportView(merged) as ImportView;
    },

    name(n: string): NamedImportView {
      return createImportView(frozenRefs, n) as NamedImportView;
    },

    get label(): string | undefined {
      return label;
    },
  };

  return view;
}

// ============================================================================
// 路径前缀工具
// ============================================================================

/**
 * 计算多个 ref 名称的最长公共路径前缀
 *
 * 结果保证以 `/` 结尾。单个 ref 时取其目录前缀。
 *
 * @param names - ref 名称列表
 * @returns 最长公共路径前缀（含末尾 /），如 "refs/heads/"
 *
 * @example
 * ```ts
 * longestCommonRefPrefix(["refs/heads/main", "refs/heads/develop"]); // "refs/heads/"
 * longestCommonRefPrefix(["refs/heads/main", "refs/tags/v1"]);       // "refs/"
 * ```
 */
function longestCommonRefPrefix(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) {
    const lastSlash = names[0]!.lastIndexOf("/");
    return lastSlash >= 0 ? names[0]!.slice(0, lastSlash + 1) : "";
  }

  let prefix = names[0]!;
  for (let i = 1; i < names.length; i++) {
    while (names[i]!.indexOf(prefix) !== 0) {
      prefix = prefix.slice(0, -1);
      if (prefix === "") return "";
    }
  }

  const lastSlash = prefix.lastIndexOf("/");
  return lastSlash >= 0 ? prefix.slice(0, lastSlash + 1) : "";
}

// ============================================================================
// PlanBuilder 实现（Phase 2）
// ============================================================================

/**
 * 物化动作（内部存储）
 *
 * 记录每个 materialize() 调用产生的动作，用于 preview() 计算。
 */
interface MaterializationAction {
  readonly viewRefs: readonly RemoteRef[];
  readonly action: "namespace" | "branch" | "tag" | "head";
  readonly target: string;
  readonly policy: RefUpdatePolicy | undefined;
  readonly prune?: boolean;
  readonly detach?: boolean;
}

/**
 * 解析命名空间物化：将 view 中的 refs 映射到目标命名空间
 *
 * 对每个 ref，计算其相对于 view 公共前缀的偏移，
 * 并用该偏移替换目标模式中的 `*`。
 *
 * @param refs - view 中的远端 refs
 * @param targetPattern - 目标模式，如 "refs/mirrors/upstream/*"
 * @returns 映射结果列表
 *
 * @example
 * ```ts
 * const targets = resolveNamespaceTargets(
 *   [refs/heads/main, refs/heads/develop],
 *   "refs/mirrors/upstream/*",
 * );
 * // => [{ localRef: "refs/mirrors/upstream/main" }, { localRef: "refs/mirrors/upstream/develop" }]
 * ```
 */
function resolveNamespaceTargets(
  refs: readonly RemoteRef[],
  targetPattern: string,
): Array<{ remoteRef: RemoteRef; localRef: string }> {
  if (refs.length === 0) return [];

  if (!targetPattern.includes("*")) {
    return refs.map((r) => ({ remoteRef: r, localRef: targetPattern }));
  }

  const [beforeStar, afterStar] = targetPattern.split("*", 2);
  const commonPrefix = longestCommonRefPrefix(refs.map((r) => r.name));
  const after = afterStar ?? "";

  return refs.map((r) => {
    const suffix = r.name.slice(commonPrefix.length);
    return { remoteRef: r, localRef: `${beforeStar}${suffix}${after}` };
  });
}

/**
 * 创建 ImportPlanBuilder
 *
 * Phase 2 实现完整的 preview()，但 apply() 仍为虚设（Phase 3）。
 */
function createPlanBuilder(
  backend: RepositoryBackend,
  advertisement: Readonly<RefAdvertisement>,
  source: ImportSource,
  transportFactory?: (url: string) => UploadPackTransport,
): ImportPlanBuilder {
  const actions: MaterializationAction[] = [];

  let lastPreview: ImportPreview | null = null;

  const builder: ImportPlanBuilder = {
    materialize(view: ImportView): RefMaterializationBuilder {
      const viewRefs = view.refs;

      const matBuilder: RefMaterializationBuilder = {
        toNamespace(
          targetPattern: string,
          options?: { policy?: RefUpdatePolicy; prune?: boolean },
        ): ImportPlanBuilder {
          actions.push({
            viewRefs,
            action: "namespace",
            target: targetPattern,
            policy: options?.policy,
            prune: options?.prune,
          });
          return builder;
        },

        toBranch(branchName: string, options?: { policy?: RefUpdatePolicy }): ImportPlanBuilder {
          actions.push({
            viewRefs,
            action: "branch",
            target: branchName,
            policy: options?.policy ?? { mode: "fast-forward" },
          });
          return builder;
        },

        toTag(tagName: string, options?: { policy?: RefUpdatePolicy }): ImportPlanBuilder {
          actions.push({
            viewRefs,
            action: "tag",
            target: tagName,
            policy: options?.policy ?? { mode: "create-only" },
          });
          return builder;
        },

        setHead(options?: { detach?: boolean }): ImportPlanBuilder {
          actions.push({
            viewRefs,
            action: "head",
            target: "HEAD",
            policy: { mode: "replace" },
            detach: options?.detach,
          });
          return builder;
        },
      };

      return matBuilder;
    },

    preview(): ImportPreview {
      // Step 1: 解析所有物化动作，计算完整的 ref 映射
      const resolvedMappings: Array<{
        remoteRef: RemoteRef;
        localRef: string;
        policy: RefUpdatePolicy;
      }> = [];

      const headMappings: Array<{ localRef: string }> = [];
      const pruneNamespaces: Array<{ prefix: string; currentRefs: Set<string> }> = [];
      const diagnostics: ImportDiagnostic[] = [];

      // 辅助函数：根据目标模式推断命名空间默认策略
      const inferNamespaceDefaultPolicy = (targetPattern: string): RefUpdatePolicy | undefined => {
        const headRegex = globToRegex("refs/heads/*");
        if (targetPattern === "refs/heads/*" || headRegex.test(targetPattern)) {
          return { mode: "fast-forward" };
        }
        const tagRegex = globToRegex("refs/tags/*");
        if (targetPattern === "refs/tags/*" || tagRegex.test(targetPattern)) {
          return { mode: "create-only" };
        }
        return undefined;
      };

      for (const act of actions) {
        let effectivePolicy: RefUpdatePolicy | undefined = act.policy;

        // namespace action 且未显式指定 policy 时推断默认策略
        if (act.action === "namespace" && effectivePolicy === undefined) {
          effectivePolicy = inferNamespaceDefaultPolicy(act.target);

          if (effectivePolicy === undefined) {
            diagnostics.push({
              level: "error",
              message:
                `命名空间 "${act.target}" 需要显式指定 policy 参数。` +
                `refs/heads/* 和 refs/tags/* 之外的命名空间必须显式声明 RefUpdatePolicy。`,
            });
            continue; // 跳过整个 namespace action
          }

          diagnostics.push({
            level: "info",
            message: `命名空间 "${act.target}" 使用默认策略 ${effectivePolicy.mode}。`,
          });
        }

        if (effectivePolicy === undefined) {
          // 不应发生：branch/tag/head 都有硬编码默认值
          continue;
        }

        switch (act.action) {
          case "namespace": {
            const targets = resolveNamespaceTargets(act.viewRefs, act.target);

            for (const t of targets) {
              resolvedMappings.push({
                remoteRef: t.remoteRef,
                localRef: t.localRef,
                policy: effectivePolicy,
              });
            }

            if (act.prune && targets.length > 0) {
              const starIdx = act.target.indexOf("*");
              const prefix = starIdx >= 0 ? act.target.slice(0, starIdx) : act.target;
              const localRefs = new Set(targets.map((t) => t.localRef));
              pruneNamespaces.push({ prefix, currentRefs: localRefs });
            }
            break;
          }

          case "branch": {
            if (act.viewRefs.length === 0) {
              diagnostics.push({
                level: "warn",
                message: `toBranch("${act.target}")：view 为空，不会创建分支。`,
              });
              break;
            }

            if (act.viewRefs.length > 1) {
              diagnostics.push({
                level: "warn",
                message: `toBranch("${act.target}")：view 包含 ${act.viewRefs.length} 个 refs，将使用第一个 ref "${act.viewRefs[0]!.name}"。`,
              });
            }

            const branchRef = act.target.startsWith("refs/heads/")
              ? act.target
              : `refs/heads/${act.target}`;
            resolvedMappings.push({
              remoteRef: act.viewRefs[0]!,
              localRef: branchRef,
              policy: effectivePolicy,
            });
            break;
          }

          case "tag": {
            if (act.viewRefs.length === 0) {
              diagnostics.push({
                level: "warn",
                message: `toTag("${act.target}")：view 为空，不会创建 tag。`,
              });
              break;
            }

            if (act.viewRefs.length > 1) {
              diagnostics.push({
                level: "warn",
                message: `toTag("${act.target}")：view 包含 ${act.viewRefs.length} 个 refs，将使用第一个 ref "${act.viewRefs[0]!.name}"。`,
              });
            }

            const tagRef = act.target.startsWith("refs/tags/")
              ? act.target
              : `refs/tags/${act.target}`;
            resolvedMappings.push({
              remoteRef: act.viewRefs[0]!,
              localRef: tagRef,
              policy: effectivePolicy,
            });
            break;
          }

          case "head": {
            if (resolvedMappings.length > 0) {
              const lastMapping = resolvedMappings[resolvedMappings.length - 1]!;
              headMappings.push({ localRef: lastMapping.localRef });
            } else {
              diagnostics.push({
                level: "warn",
                message: "setHead() 时没有前置的物化操作，HEAD 将被跳过。",
              });
            }
            break;
          }
        }
      }

      // Step 2: 捕获本地前置条件（冻结 affected refs 的当前状态）
      const localRefs = getLocalRefs(backend.refs);
      const affectedRefNames = new Set<string>();

      for (const m of resolvedMappings) {
        affectedRefNames.add(m.localRef);
      }
      for (const p of pruneNamespaces) {
        for (const [refName] of localRefs) {
          if (refName.startsWith(p.prefix)) {
            affectedRefNames.add(refName);
          }
        }
      }

      const localPreconditions: LocalPrecondition[] = [];
      for (const refName of affectedRefNames) {
        const hash = localRefs.get(refName) ?? null;
        localPreconditions.push({ refName, expectedHash: hash });
      }

      // Step 3: 计算 ref 操作与对象根
      const refOperations: PlannedRefOperation[] = [];
      const selectedRefs: PlannedRemoteRef[] = [];
      const objectRootsSet = new Set<string>();

      for (const m of resolvedMappings) {
        const existingHash = localRefs.get(m.localRef);

        if (existingHash === m.remoteRef.hash) {
          diagnostics.push({
            level: "info",
            message: `"${m.localRef}" 已是最新，跳过。`,
            refName: m.localRef,
          });
          continue;
        }

        if (existingHash !== undefined) {
          if (m.policy.mode === "create-only") {
            diagnostics.push({
              level: "error",
              message: `"${m.localRef}" 已存在，create-only 策略拒绝更新。`,
              refName: m.localRef,
            });
            continue;
          }

          if (m.policy.mode === "fast-forward") {
            diagnostics.push({
              level: "info",
              message: `"${m.localRef}" 将执行 fast-forward 检查。`,
              refName: m.localRef,
            });
          }
        }

        refOperations.push({
          localRef: m.localRef,
          newHash: m.remoteRef.hash,
          policy: m.policy,
        });

        selectedRefs.push({
          remoteRef: m.remoteRef,
          localTarget: m.localRef,
          policy: m.policy,
        });

        objectRootsSet.add(m.remoteRef.hash);
      }

      // Step 4: 计算 prune 操作
      const pruneOperations: PlannedRefDeletion[] = [];
      for (const ns of pruneNamespaces) {
        for (const [refName] of localRefs) {
          if (refName.startsWith(ns.prefix) && !ns.currentRefs.has(refName)) {
            pruneOperations.push({
              refName,
              reason: `命名空间 "${ns.prefix}*" 的 prune 清理。`,
            });
          }
        }
      }

      // Step 5: HEAD 操作
      let headOperation: { targetRef: string; detach: boolean } | undefined;

      if (headMappings.length > 0) {
        const lastHead = headMappings[headMappings.length - 1]!;
        headOperation = {
          targetRef: lastHead.localRef,
          detach: false,
        };
      }

      // Step 6: 总览诊断
      if (resolvedMappings.length > 0) {
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

      const objectRoots = [...objectRootsSet];

      // canApply: 不存在 error 级别诊断时计划可用
      const canApply = !diagnostics.some((d) => d.level === "error");

      const _previewResult = {
        remoteSnapshot: advertisement,
        selectedRefs,
        objectRoots: objectRoots as import("../core/types.ts").SHA1[],
        localPreconditions,
        refOperations,
        pruneOperations,
        headOperation,
        diagnostics,
        canApply,
      };
      lastPreview = _previewResult;
      return _previewResult;
    },

    async apply(): Promise<ImportApplyResult> {
      // Step 1: 使用缓存的 preview 结果校验前置条件
      const p = lastPreview ?? builder.preview();

      // 若 preview 指示计划不可执行，则提前失败
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

      if (p.refOperations.length === 0 && !p.headOperation && p.pruneOperations.length === 0) {
        return {
          importedObjects: 0,
          updatedRefs: new Map<string, SHA1>(),
          deletedRefs: [],
        };
      }

      // Step 2: 校验前置条件 — 当前本地 refs 与 preview 快照一致
      const currentLocalRefs = getLocalRefs(backend.refs);
      for (const pc of p.localPreconditions) {
        const currentHash = currentLocalRefs.get(pc.refName) ?? null;
        if (currentHash !== pc.expectedHash) {
          throw new Error(
            `前置条件校验失败：ref "${pc.refName}" 在 preview() 后已变化。` +
              `期望 ${pc.expectedHash ?? "(不存在)"}，实际 ${currentHash ?? "(不存在)"}。`,
          );
        }
      }

      // Step 3: 拉取对象（仅拉取本地缺失的）
      let importedObjects = 0;
      const unresolvedWants = p.objectRoots.filter((h) => !backend.objects.exists(h));

      if (unresolvedWants.length > 0) {
        const createTransportImpl =
          transportFactory ??
          ((url: string) =>
            createUploadPackHttpClient(url, {
              token: source.token,
              headers: source.headers,
            }));
        const transport = createTransportImpl(source.url);

        // 收集本地已有 commit tips 作为 have 候选
        const localHaveTips: SHA1[] = [];
        for (const [, hash] of currentLocalRefs) {
          if (!localHaveTips.some((h) => h === hash)) {
            localHaveTips.push(hash);
          }
        }

        const packResult = await fetchPack(backend.objects, transport, advertisement, {
          wants: unresolvedWants,
          haves: localHaveTips.length > 0 ? localHaveTips : undefined,
        });
        importedObjects = packResult.objectCount;
      }

      // Step 4: 策略预校验 — 在进入 ref 物化之前完成全部策略校验
      for (const op of p.refOperations) {
        const currentHash = currentLocalRefs.get(op.localRef) ?? null;

        // refs/heads/* 的 commit 类型校验（仅校验存在且可读的对象）
        if (op.localRef.startsWith("refs/heads/") && backend.objects.exists(op.newHash)) {
          resolveBranchTargetHash(backend.objects, op.newHash, op.localRef);
        }

        // fast-forward 策略校验：有本地值且非 replace 时检查祖先关系
        if (op.policy.mode === "fast-forward" && currentHash !== null) {
          if (!isAncestor(backend.objects, currentHash, op.newHash)) {
            throw new Error(
              `导入计划校验失败：ref "${op.localRef}" 无法 fast-forward。` +
                `当前 ${currentHash}，目标 ${op.newHash}。`,
            );
          }
        }
      }

      // Step 4: 写 ref
      const updatedRefs = new Map<string, SHA1>();

      if (p.refOperations.length > 0) {
        const refUpdates: RefUpdatePlanItem[] = p.refOperations.map((op) => {
          const precond = p.localPreconditions.find((pc) => pc.refName === op.localRef);
          return {
            remoteRef: { hash: op.newHash, name: op.localRef },
            localRef: op.localRef,
            currentLocalHash: precond?.expectedHash ?? undefined,
            force: op.policy.mode === "replace",
            hashEqual: false,
          } as RefUpdatePlanItem;
        });

        const refResult = applyRefUpdates(backend.objects, backend.refs, refUpdates);

        for (const [ref, hash] of refResult.updatedRefs) {
          updatedRefs.set(ref, hash);
        }
      }

      // Step 5: 设置 HEAD
      if (p.headOperation) {
        backend.refs.write("HEAD", `ref: ${p.headOperation.targetRef}`);
      }

      // Step 6: 执行 prune
      const deletedRefs: string[] = [];
      for (const op of p.pruneOperations) {
        try {
          backend.refs.delete(op.refName);
          deletedRefs.push(op.refName);
        } catch {
          // ref 可能已被删除，忽略
        }
      }

      return {
        importedObjects,
        updatedRefs,
        deletedRefs,
        headTarget: p.headOperation?.targetRef,
      };
    },
  };

  return builder;
}

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
  // 冻结 advertisement 快照，确保会话级别不可变
  const frozenAdvertisement = Object.freeze({
    ...advertisement,
    refs: Object.freeze([...advertisement.refs]),
    capabilities: { ...advertisement.capabilities },
  }) as Readonly<RefAdvertisement>;

  const allRefs: readonly RemoteRef[] = frozenAdvertisement.refs;

  return {
    source,
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
      if (!advertisement.defaultBranch) {
        return createImportView([]) as ImportView;
      }

      const ref = allRefs.find((r) => r.name === advertisement.defaultBranch);
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
      return createPlanBuilder(backend, frozenAdvertisement, source, transportFactory);
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
): import("./import-session-types.ts").RepoImportOperations {
  return {
    async openImportSession(
      source: ImportSource,
      options?: OpenImportSessionOptions,
    ): Promise<ImportSession> {
      const createTransport =
        options?.transportFactory ??
        ((url: string) =>
          createUploadPackHttpClient(url, {
            token: options?.token ?? source.token,
            headers: options?.headers ?? source.headers,
          }));

      const transport = createTransport(source.url);
      const advertisement = await transport.advertise();

      return createImportSession(source, backend, advertisement, options?.transportFactory);
    },
  };
}

// 若 preview 指示计划不可执行，则提前失败
// ============================================================================
// 导出
// ============================================================================

export { createImportSession, createImportView, matchRefGlob };
