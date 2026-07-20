import { PreconditionCheckError } from "../../errors.ts";
import { getLocalRefs } from "../../transport/protocol/ref-collection.ts";
import { matchRefGlob } from "./import-glob.ts";

import type { RepositoryBackend } from "../../backend/types.ts";
import type { SHA1 } from "../../types/index.ts";
import type { LocalPrecondition, NamespaceSnapshotEntry } from "./import-plan-types.ts";

export function snapshotOwnedRefs(
  backend: RepositoryBackend,
  pattern: string,
): readonly NamespaceSnapshotEntry[] {
  return backend.refs
    .listAll()
    .filter((refName) => matchRefGlob(pattern, refName))
    .sort((left, right) => left.localeCompare(right))
    .map((refName) => ({
      refName,
      expectedValue: backend.refs.read(refName),
    }));
}

export function validateLocalPreconditions(
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
        throw new PreconditionCheckError(
          `前置条件校验失败：命名空间 "${pattern}" 在 prepare() 生成的预览后已变化。`,
          { namespacePattern: pattern },
        );
      }
      continue;
    }

    if (pc.expectedValue !== undefined) {
      const currentValue = backend.refs.read(pc.refName);
      if (currentValue !== pc.expectedValue) {
        throw new PreconditionCheckError(
          `前置条件校验失败：ref "${pc.refName}" 在 prepare() 生成的预览后已变化。` +
            `期望 ${pc.expectedValue ?? "(不存在)"}，实际 ${currentValue ?? "(不存在)"}。`,
          {
            refName: pc.refName,
            expected: pc.expectedValue,
            actual: currentValue,
          },
        );
      }
      continue;
    }

    const currentHash = currentLocalRefs.get(pc.refName) ?? null;
    if (currentHash !== pc.expectedHash) {
      throw new PreconditionCheckError(
        `前置条件校验失败：ref "${pc.refName}" 在 prepare() 生成的预览后已变化。` +
          `期望 ${pc.expectedHash ?? "(不存在)"}，实际 ${currentHash ?? "(不存在)"}。`,
        {
          refName: pc.refName,
          expected: pc.expectedHash ?? null,
          actual: currentHash,
        },
      );
    }
  }

  return currentLocalRefs;
}
