import { globToRegex } from "./import-glob.ts";
import { createPreparedImportPlan } from "./import-plan-apply.ts";
import {
  deepFreeze,
  type CompiledImportPlanState,
  type HeadRequest,
  type ImportMaterializationIntent,
  type NamespaceOwnership,
  type PreparedImportPlanState,
  type ResolvedMapping,
} from "./import-plan-types.ts";
import {
  getNamespacePatternPrefix,
  isSameRemoteRef,
  resolveNamespaceTargets,
} from "./import-view.ts";

import type { RepositoryBackend } from "../../backend/types.ts";
import type { V2GitServiceTransport } from "../../transport/client/upload-pack/types.ts";
import type { RefAdvertisement } from "../../transport/protocol/types.ts";
import type {
  ImportDiagnostic,
  ImportPlan,
  ImportPlanInspection,
  ImportView,
  NamedImportView,
  PlannedRemoteRef,
  RefUpdatePolicy,
} from "./import-session-types.ts";

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

function freezeInspectionResult(inspection: ImportPlanInspection): ImportPlanInspection {
  return deepFreeze({
    selectedRefs: inspection.selectedRefs,
    diagnostics: inspection.diagnostics,
    canPrepare: inspection.canPrepare,
  });
}

function compileImportPlanState(
  backend: RepositoryBackend,
  advertisement: Readonly<RefAdvertisement>,
  v2Transport: V2GitServiceTransport | undefined,
  actions: readonly ImportMaterializationIntent[],
): CompiledImportPlanState {
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
            "refs/heads/* 和 refs/tags/* 之外的命名空间必须显式声明 RefUpdatePolicy。",
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
          localRef: act.target.startsWith("refs/heads/") ? act.target : `refs/heads/${act.target}`,
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

  return {
    backend,
    advertisement,
    v2Transport,
    resolvedMappings,
    headRequests,
    namespaceOwnerships,
    selectedRefs,
    diagnostics,
    conflictedTargets,
  };
}

export function createImportPlan(
  backend: RepositoryBackend,
  advertisement: Readonly<RefAdvertisement>,
  v2Transport: V2GitServiceTransport | undefined,
  actions: readonly ImportMaterializationIntent[],
  prepare: (compiled: CompiledImportPlanState) => Promise<PreparedImportPlanState>,
): ImportPlan {
  const compiled = compileImportPlanState(backend, advertisement, v2Transport, actions);
  const inspection = freezeInspectionResult({
    selectedRefs: compiled.selectedRefs,
    diagnostics: compiled.diagnostics,
    canPrepare: !compiled.diagnostics.some((diagnostic) => diagnostic.level === "error"),
  });

  return {
    inspect(): ImportPlanInspection {
      return inspection;
    },

    async prepare() {
      return createPreparedImportPlan(backend, await prepare(compiled));
    },
  };
}

export function createMaterializationIntent(
  view: ImportView,
  action: ImportMaterializationIntent["action"],
  target: string,
  policy: RefUpdatePolicy | undefined,
  options?: Pick<ImportMaterializationIntent, "prune" | "detach">,
): ImportMaterializationIntent {
  return {
    viewRefs: view.refs,
    viewLabel: getViewLabel(view),
    action,
    target,
    policy: policy ? clonePolicy(policy) : undefined,
    prune: options?.prune,
    detach: options?.detach,
  };
}
