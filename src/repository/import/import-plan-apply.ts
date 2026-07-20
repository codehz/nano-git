import { ImportError, ObjectNotFoundError } from "../../errors.ts";
import { isAncestor } from "../../transport/protocol/object-graph.ts";
import { validateLocalPreconditions } from "./import-plan-preconditions.ts";

import type { RepositoryBackend } from "../../backend/types.ts";
import type { SHA1 } from "../../types/index.ts";
import type { PreparedImportPlanState } from "./import-plan-types.ts";
import type { ImportApplyResult, PreparedImportPlan } from "./import-session-types.ts";

export function createPreparedImportPlan(
  backend: RepositoryBackend,
  preparedState: PreparedImportPlanState,
): PreparedImportPlan {
  let consumed = false;
  const localShallow = backend.shallow.read();
  const localShallowSet = localShallow.length > 0 ? new Set<SHA1>(localShallow) : undefined;
  const hasShallowUpdate =
    preparedState.shallowUpdate !== undefined &&
    (preparedState.shallowUpdate.shallow.length > 0 ||
      preparedState.shallowUpdate.unshallow.length > 0);

  async function runApply(allowPartial: boolean): Promise<ImportApplyResult> {
    if (consumed) {
      throw new ImportError("Prepared import plan has already been consumed.", { phase: "apply" });
    }
    consumed = true;

    const preview = preparedState.preview;
    if (!preview.canApply) {
      const errorMessages = preview.diagnostics
        .filter((diagnostic) => diagnostic.level === "error")
        .map((diagnostic) => diagnostic.message)
        .join("; ");
      const hasExecutableOperations =
        preparedState.refOperations.length > 0 ||
        preparedState.pruneOperations.length > 0 ||
        preparedState.headOperation !== undefined ||
        hasShallowUpdate;

      if (!allowPartial || !hasExecutableOperations) {
        throw new ImportError(
          `导入计划包含 ${preview.diagnostics.filter((d) => d.level === "error").length} 个错误，无法执行。` +
            (errorMessages ? ` 错误：${errorMessages}` : ""),
          { phase: "apply" },
        );
      }
    }

    const currentLocalRefs = validateLocalPreconditions(backend, preparedState.preconditions);

    if (
      preparedState.refOperations.length === 0 &&
      preview.objectRoots.length === 0 &&
      !preparedState.headOperation &&
      preparedState.pruneOperations.length === 0
    ) {
      if (hasShallowUpdate) {
        backend.shallow.applyUpdate(preparedState.shallowUpdate!);
      }
      return {
        importedObjects: preview.prefetchedObjects,
        shallowUpdate: preparedState.shallowUpdate,
        updatedRefs: new Map<string, SHA1>(),
        deletedRefs: [],
      };
    }

    const pendingWrites: Array<{ localRef: string; writeHash: SHA1 }> = [];
    for (const op of preparedState.refOperations) {
      const currentValue = backend.refs.read(op.localRef);
      const refExists = currentValue !== null;
      const currentHash = currentLocalRefs.get(op.localRef) ?? null;
      if (!backend.objects.exists(op.newHash)) {
        throw new ObjectNotFoundError(op.newHash, {
          operation: "read",
          message: `导入计划校验失败：对象 "${op.newHash}" 在本地对象库中不存在。`,
        });
      }

      if (op.policy.mode === "create-only" && refExists) {
        throw new ImportError(
          `导入计划校验失败：ref "${op.localRef}" 已存在，create-only 策略拒绝更新。`,
          { phase: "apply" },
        );
      }

      if (op.policy.mode === "fast-forward" && refExists) {
        if (currentHash === null) {
          throw new ImportError(
            `导入计划校验失败：ref "${op.localRef}" 当前存在，但无法解析为可比较的提交哈希。`,
            { phase: "apply" },
          );
        }
        if (!isAncestor(backend.objects, currentHash, op.newHash, localShallowSet)) {
          throw new ImportError(
            `导入计划校验失败：ref "${op.localRef}" 无法 fast-forward。` +
              `当前 ${currentHash}，目标 ${op.newHash}。`,
            { phase: "apply" },
          );
        }
      }

      pendingWrites.push({
        localRef: op.localRef,
        writeHash: op.newHash,
      });
    }

    const hooks = backend.refTransactionHooks;
    const tx = backend.refs.beginTransaction(hooks);
    try {
      const updatedRefs = new Map<string, SHA1>();
      for (const op of pendingWrites) {
        tx.write(op.localRef, op.writeHash);
        updatedRefs.set(op.localRef, op.writeHash);
      }

      if (preparedState.headOperation) {
        if (!preparedState.headOperation.targetRef.startsWith("refs/heads/")) {
          throw new ImportError(
            `导入计划校验失败：setHead() 只能指向 refs/heads/*，当前为 "${preparedState.headOperation.targetRef}"。`,
            { phase: "apply" },
          );
        }

        if (preparedState.headOperation.detach) {
          const detachedTarget = updatedRefs.get(preparedState.headOperation.targetRef);
          const existingTarget = currentLocalRefs.get(preparedState.headOperation.targetRef);
          const resolvedTarget = detachedTarget ?? existingTarget;

          if (!resolvedTarget) {
            throw new ImportError(
              `无法将 HEAD detached 到 "${preparedState.headOperation.targetRef}"：目标 ref 不存在。`,
              { phase: "apply" },
            );
          }

          tx.write("HEAD", resolvedTarget);
        } else {
          tx.write("HEAD", `ref: ${preparedState.headOperation.targetRef}`);
        }
      }

      const deletedRefs: string[] = [];
      for (const op of preparedState.pruneOperations) {
        try {
          tx.delete(op.refName);
          deletedRefs.push(op.refName);
        } catch {
          // 事务中 delete 可能因 RefNotFoundError 失败，忽略
        }
      }

      tx.commit();
      if (hasShallowUpdate) {
        backend.shallow.applyUpdate(preparedState.shallowUpdate!);
      }

      return {
        importedObjects: preview.prefetchedObjects,
        shallowUpdate: preparedState.shallowUpdate,
        updatedRefs,
        deletedRefs,
        headTarget: preparedState.headOperation?.targetRef,
      };
    } catch (error) {
      tx.rollback();
      throw error;
    }
  }

  return {
    preview: preparedState.preview,

    async apply() {
      return runApply(false);
    },

    async applyPartial() {
      return runApply(true);
    },
  };
}
