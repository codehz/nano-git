/**
 * Import Session 实现
 *
 * Phase 1-3：完整的 Import Session 流程
 *
 * 包含 advertisement 拉取、冻结 view、plan preview、
 * 对象导入、ref/HEAD 物化与 prune/ownership 校验。
 *
 * @see .drafts/import-session-rfc.md
 */

import { fetchPack } from "../transport/fetch-pack.ts";
import { isAncestor } from "../transport/object-graph.ts";
import { getLocalRefs } from "../transport/ref-collection.ts";
import { createUploadPackHttpClient } from "../transport/smart-http.ts";
import { resolveBranchTargetHash } from "../transport/update-refs.ts";

import type { SHA1 } from "../core/types.ts";
import type { RemoteRef, RefAdvertisement, UploadPackTransport } from "../transport/types.ts";
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
  const frozenRefs = Object.freeze(refs.map((ref) => Object.freeze({ ...ref })));

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

interface ResolvedMapping {
  readonly remoteRef: RemoteRef;
  readonly localRef: string;
  readonly policy: RefUpdatePolicy;
}

interface NamespaceOwnership {
  readonly pattern: string;
  readonly prefix: string;
  readonly currentRefs: Set<string>;
  prune: boolean;
}

interface NamespaceSnapshotEntry {
  readonly refName: string;
  readonly expectedValue: string | null;
}

function clonePolicy(policy: RefUpdatePolicy): RefUpdatePolicy {
  return { ...policy };
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
    localPreconditions: preview.localPreconditions,
    refOperations: preview.refOperations,
    headOperation: preview.headOperation,
    pruneOperations: preview.pruneOperations,
    diagnostics: preview.diagnostics,
    canApply: preview.canApply,
  });
}

/**
 * 判断两个远端 ref 是否表示同一条广告项
 *
 * @param left - 左侧 ref
 * @param right - 右侧 ref
 * @returns 是否相同
 */
function isSameRemoteRef(left: RemoteRef, right: RemoteRef): boolean {
  return (
    left.name === right.name &&
    left.hash === right.hash &&
    left.peeled === right.peeled &&
    left.symrefTarget === right.symrefTarget
  );
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
 * 截取命名空间目标模式的固定前缀
 *
 * @param targetPattern - 目标模式
 * @returns `*` 之前的固定前缀；无 `*` 时返回 null
 */
function getNamespacePatternPrefix(targetPattern: string): string | null {
  const starIdx = targetPattern.indexOf("*");
  return starIdx >= 0 ? targetPattern.slice(0, starIdx) : null;
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
function validateLocalPreconditions(
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
        throw new Error(`前置条件校验失败：命名空间 "${pattern}" 在 preview() 后已变化。`);
      }
      continue;
    }

    if (pc.expectedValue !== undefined) {
      const currentValue = backend.refs.read(pc.refName);
      if (currentValue !== pc.expectedValue) {
        throw new Error(
          `前置条件校验失败：ref "${pc.refName}" 在 preview() 后已变化。` +
            `期望 ${pc.expectedValue ?? "(不存在)"}，实际 ${currentValue ?? "(不存在)"}。`,
        );
      }
      continue;
    }

    const currentHash = currentLocalRefs.get(pc.refName) ?? null;
    if (currentHash !== pc.expectedHash) {
      throw new Error(
        `前置条件校验失败：ref "${pc.refName}" 在 preview() 后已变化。` +
          `期望 ${pc.expectedHash ?? "(不存在)"}，实际 ${currentHash ?? "(不存在)"}。`,
      );
    }
  }

  return currentLocalRefs;
}

/**
 * 创建 ImportPlanBuilder
 *
 * 该 builder 负责 preview/apply 的完整执行语义。
 */
function createPlanBuilder(
  backend: RepositoryBackend,
  advertisement: Readonly<RefAdvertisement>,
  source: ImportSource,
  transportFactory?: (url: string) => UploadPackTransport,
): ImportPlanBuilder {
  const actions: MaterializationAction[] = [];

  let lastPreview: ImportPreview | null = null;

  /**
   * 计划动作变更后必须丢弃旧 preview，
   * 否则 apply() 可能基于过期计划执行。
   */
  function invalidatePreview(): void {
    lastPreview = null;
  }

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
            policy: options?.policy ? clonePolicy(options.policy) : undefined,
            prune: options?.prune,
          });
          invalidatePreview();
          return builder;
        },

        toBranch(branchName: string, options?: { policy?: RefUpdatePolicy }): ImportPlanBuilder {
          actions.push({
            viewRefs,
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

    preview(): ImportPreview {
      // Step 1: 解析所有物化动作，计算完整的 ref 映射
      const resolvedMappings: ResolvedMapping[] = [];

      const headMappings: Array<{ localRef: string; detach: boolean }> = [];
      const namespaceOwnerships = new Map<string, NamespaceOwnership>();
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
            if (act.prune && !act.target.includes("*")) {
              diagnostics.push({
                level: "error",
                message: `toNamespace("${act.target}")：prune 只允许用于带 * 的命名空间投影。`,
              });
              break;
            }

            const targets = resolveNamespaceTargets(act.viewRefs, act.target);

            for (const t of targets) {
              resolvedMappings.push({
                remoteRef: t.remoteRef,
                localRef: t.localRef,
                policy: effectivePolicy,
              });
            }

            const namespacePrefix = getNamespacePatternPrefix(act.target);
            if (namespacePrefix !== null) {
              const ownership = namespaceOwnerships.get(act.target) ?? {
                pattern: act.target,
                prefix: namespacePrefix,
                currentRefs: new Set<string>(),
                prune: false,
              };

              for (const t of targets) {
                ownership.currentRefs.add(t.localRef);
              }
              ownership.prune = ownership.prune || (act.prune ?? false);
              namespaceOwnerships.set(act.target, ownership);
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
                level: "error",
                message: `toBranch("${act.target}") 需要单一 ref 视图，当前收到 ${act.viewRefs.length} 个 refs。`,
              });
              break;
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
                level: "error",
                message: `toTag("${act.target}") 需要单一 ref 视图，当前收到 ${act.viewRefs.length} 个 refs。`,
              });
              break;
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
            if (act.viewRefs.length === 0) {
              diagnostics.push({
                level: "warn",
                message: "setHead() 的 view 为空，HEAD 将被跳过。",
              });
              break;
            }

            if (act.viewRefs.length > 1) {
              diagnostics.push({
                level: "error",
                message: `setHead() 需要单一 ref 视图，当前收到 ${act.viewRefs.length} 个 refs。`,
              });
              break;
            }

            const targetRemoteRef = act.viewRefs[0]!;
            const lastMapping = [...resolvedMappings]
              .reverse()
              .find((mapping) => isSameRemoteRef(mapping.remoteRef, targetRemoteRef));

            if (lastMapping) {
              headMappings.push({
                localRef: lastMapping.localRef,
                detach: act.detach ?? false,
              });
            } else {
              diagnostics.push({
                level: "warn",
                message: `setHead() 找不到 view "${targetRemoteRef.name}" 对应的前置物化结果，HEAD 将被跳过。`,
              });
            }
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
            `${mappings.map((m) => m.remoteRef.name).join(", ")}。`,
          refName: localRef,
        });
      }

      // Step 2: 捕获本地前置条件（冻结 affected refs 的当前状态）
      const localRefs = getLocalRefs(backend.refs);
      const affectedRefNames = new Set<string>();

      for (const m of resolvedMappings) {
        affectedRefNames.add(m.localRef);
      }
      if (headMappings.length > 0) {
        affectedRefNames.add("HEAD");
      }

      const localPreconditions: LocalPrecondition[] = [];
      for (const refName of affectedRefNames) {
        const expectedValue = backend.refs.read(refName);
        const hash = localRefs.get(refName) ?? null;
        localPreconditions.push({
          refName,
          expectedHash: hash,
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

      // Step 3: 计算 ref 操作与对象根
      const refOperations: PlannedRefOperation[] = [];
      const selectedRefs: PlannedRemoteRef[] = [];
      const objectRootsSet = new Set<string>();

      for (const m of resolvedMappings) {
        const existingValue = backend.refs.read(m.localRef);
        const existingHash = localRefs.get(m.localRef) ?? null;
        const refExists = existingValue !== null;
        const hasObject = backend.objects.exists(m.remoteRef.hash);

        selectedRefs.push({
          remoteRef: m.remoteRef,
          localTarget: m.localRef,
          policy: m.policy,
        });

        if (conflictedTargets.has(m.localRef)) {
          continue;
        }

        if (existingHash === m.remoteRef.hash) {
          diagnostics.push({
            level: "info",
            message: `"${m.localRef}" 已是最新，跳过。`,
            refName: m.localRef,
          });
          if (!hasObject) {
            objectRootsSet.add(m.remoteRef.hash);
          }
          continue;
        }

        if (refExists && m.policy.mode === "create-only") {
          diagnostics.push({
            level: "error",
            message: `"${m.localRef}" 已存在，create-only 策略拒绝更新。`,
            refName: m.localRef,
          });
          if (!hasObject) {
            objectRootsSet.add(m.remoteRef.hash);
          }
          continue;
        }

        if (refExists && m.policy.mode === "fast-forward") {
          diagnostics.push({
            level: "info",
            message: `"${m.localRef}" 将执行 fast-forward 检查。`,
            refName: m.localRef,
          });
        }

        refOperations.push({
          localRef: m.localRef,
          newHash: m.remoteRef.hash,
          policy: m.policy,
        });

        if (!hasObject) {
          objectRootsSet.add(m.remoteRef.hash);
        }
      }

      // Step 4: 计算 prune 操作
      const pruneOperations: PlannedRefDeletion[] = [];
      const scheduledPruneRefs = new Set<string>();
      for (const ns of namespaceOwnerships.values()) {
        if (!ns.prune) {
          continue;
        }

        for (const refName of backend.refs.listAll()) {
          if (
            matchRefGlob(ns.pattern, refName) &&
            !ns.currentRefs.has(refName) &&
            !scheduledPruneRefs.has(refName)
          ) {
            scheduledPruneRefs.add(refName);
            pruneOperations.push({
              refName,
              reason: `命名空间 "${ns.pattern}" 的 prune 清理。`,
            });
          }
        }
      }

      // Step 5: HEAD 操作
      let headOperation: { targetRef: string; detach: boolean } | undefined;

      if (headMappings.length > 0) {
        const lastHead = headMappings[headMappings.length - 1]!;
        if (conflictedTargets.has(lastHead.localRef)) {
          diagnostics.push({
            level: "error",
            message: `setHead() 目标 "${lastHead.localRef}" 存在冲突，HEAD 无法确定。`,
            refName: lastHead.localRef,
          });
        } else {
          headOperation = {
            targetRef: lastHead.localRef,
            detach: lastHead.detach,
          };
        }
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

      const _previewResult = freezePreviewResult(
        {
          remoteSnapshot: advertisement,
          selectedRefs,
          objectRoots: objectRoots as import("../core/types.ts").SHA1[],
          localPreconditions,
          refOperations,
          pruneOperations,
          headOperation,
          diagnostics,
          canApply,
        },
        advertisement,
      );
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

      // Step 2: 校验前置条件 — 当前本地 refs 与 preview 快照一致
      let currentLocalRefs = validateLocalPreconditions(backend, p.localPreconditions);

      if (
        p.refOperations.length === 0 &&
        p.objectRoots.length === 0 &&
        !p.headOperation &&
        p.pruneOperations.length === 0
      ) {
        return {
          importedObjects: 0,
          updatedRefs: new Map<string, SHA1>(),
          deletedRefs: [],
        };
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

        // fetch-pack 是异步阶段，结束后需要重新校验一次本地前置条件，
        // 防止 preview 与 ref 写入之间出现并发漂移。
        currentLocalRefs = validateLocalPreconditions(backend, p.localPreconditions);
      }

      // Step 4: 策略预校验 — 在进入 ref 物化之前完成全部策略校验
      const pendingWrites: Array<{ localRef: string; writeHash: SHA1 }> = [];
      for (const op of p.refOperations) {
        const currentValue = backend.refs.read(op.localRef);
        const refExists = currentValue !== null;
        const currentHash = currentLocalRefs.get(op.localRef) ?? null;
        const targetHash = op.localRef.startsWith("refs/heads/")
          ? resolveBranchTargetHash(backend.objects, op.newHash, op.localRef)
          : op.newHash;

        if (!backend.objects.exists(targetHash)) {
          throw new Error(`导入计划校验失败：对象 "${targetHash}" 在本地对象库中不存在。`);
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
          if (!isAncestor(backend.objects, currentHash, targetHash)) {
            throw new Error(
              `导入计划校验失败：ref "${op.localRef}" 无法 fast-forward。` +
                `当前 ${currentHash}，目标 ${targetHash}。`,
            );
          }
        }

        pendingWrites.push({
          localRef: op.localRef,
          writeHash: targetHash,
        });
      }

      // Step 5: 写 ref
      const updatedRefs = new Map<string, SHA1>();
      for (const op of pendingWrites) {
        backend.refs.write(op.localRef, op.writeHash);
        updatedRefs.set(op.localRef, op.writeHash);
      }

      // Step 6: 设置 HEAD
      if (p.headOperation) {
        if (p.headOperation.detach) {
          const detachedTarget = updatedRefs.get(p.headOperation.targetRef);
          const existingTarget = currentLocalRefs.get(p.headOperation.targetRef);
          const resolvedTarget = detachedTarget ?? existingTarget;

          if (!resolvedTarget) {
            throw new Error(
              `无法将 HEAD detached 到 "${p.headOperation.targetRef}"：目标 ref 不存在。`,
            );
          }

          backend.refs.write("HEAD", resolvedTarget);
        } else {
          backend.refs.write("HEAD", `ref: ${p.headOperation.targetRef}`);
        }
      }

      // Step 7: 执行 prune
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
): import("./import-session-types.ts").RepoImportOperations {
  return {
    async openImportSession(
      source: ImportSource,
      options?: OpenImportSessionOptions,
    ): Promise<ImportSession> {
      const sessionSource: ImportSource = {
        url: source.url,
        token: options?.token ?? source.token,
        headers: options?.headers ?? source.headers,
      };

      const createTransport =
        options?.transportFactory ??
        ((url: string) =>
          createUploadPackHttpClient(url, {
            token: sessionSource.token,
            headers: sessionSource.headers,
          }));

      const transport = createTransport(source.url);
      const advertisement = await transport.advertise();

      return createImportSession(sessionSource, backend, advertisement, options?.transportFactory);
    },
  };
}

// 若 preview 指示计划不可执行，则提前失败
// ============================================================================
// 导出
// ============================================================================

export { createImportSession, createImportView, matchRefGlob };
