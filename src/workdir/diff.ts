/**
 * Virtual Workdir 最终状态 diff 计算
 */

import { hashObject } from "../core/hash.ts";
import { readRepoTree, readRepoBlobContent } from "./origin.ts";
import { VIRTUAL_ROOT_PATH } from "./path.ts";
import { listDirectoryChildren } from "./session-internal.ts";

import type { SHA1, TreeEntry } from "../core/types.ts";
import type { ObjectSource } from "../core/types/odb.ts";
import type { VirtualDiffEntry, VirtualDiffType } from "./core.ts";
import type { SessionNode } from "./nodes.ts";
import type { VirtualWorkdirStateStore } from "./state-store.ts";

interface SnapshotEntry {
  readonly path: string;
  readonly mode: "100644" | "100755" | "120000";
  readonly hash: SHA1;
  readonly originSignature: string | null;
}

interface CopySourceMatch {
  readonly path: string;
  readonly entry: SnapshotEntry;
}

/**
 * 计算当前 session 相对 baseTree 的最终 diff。
 *
 * @example
 * ```ts
 * const diff = computeVirtualDiff(repo.objects, state);
 * expect(diff.map((entry) => entry.path)).toEqual(["hello.txt"]);
 * ```
 */
export function computeVirtualDiff(
  source: ObjectSource,
  state: VirtualWorkdirStateStore,
): VirtualDiffEntry[] {
  const baseEntries = snapshotBaseTree(source, state.readBaseTree(), VIRTUAL_ROOT_PATH);
  const currentEntries = snapshotCurrentTree(source, state);

  const baseByPath = new Map(baseEntries.map((entry) => [entry.path, entry]));
  const currentByPath = new Map(currentEntries.map((entry) => [entry.path, entry]));

  const deletes = new Map<string, VirtualDiffEntry>();
  const adds = new Map<string, VirtualDiffEntry>();
  const out: VirtualDiffEntry[] = [];

  const allPaths = new Set<string>([...baseByPath.keys(), ...currentByPath.keys()]);
  for (const path of Array.from(allPaths).sort()) {
    const previous = baseByPath.get(path) ?? null;
    const current = currentByPath.get(path) ?? null;

    if (previous !== null && current !== null) {
      const type = diffTypeForSamePath(previous, current);
      if (type !== null) {
        out.push(toDiffEntry(type, path, previous, current));
      }
      continue;
    }

    if (previous !== null) {
      deletes.set(path, toDiffEntry("delete", path, previous, null));
      continue;
    }

    if (current !== null) {
      adds.set(path, toDiffEntry("add", path, null, current));
    }
  }

  const unmatchedDeletesBySignature = indexDeletesBySignature(deletes);
  const matchedDeletePaths = new Set<string>();

  for (const [path] of Array.from(adds.entries()).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const current = currentByPath.get(path);
    if (current === undefined || current.originSignature === null) {
      continue;
    }

    const deleteCandidates = unmatchedDeletesBySignature.get(current.originSignature) ?? [];
    const renameFrom = deleteCandidates.find(
      (candidate) => !matchedDeletePaths.has(candidate.path),
    );
    if (renameFrom !== undefined) {
      matchedDeletePaths.add(renameFrom.path);
      adds.delete(path);
      deletes.delete(renameFrom.path);
      out.push(
        toDiffEntry(
          "rename",
          path,
          baseByPath.get(renameFrom.path) ?? null,
          current,
          renameFrom.path,
        ),
      );
      continue;
    }

    const copyFrom = findCopySource(baseEntries, current);
    if (copyFrom !== null) {
      adds.delete(path);
      out.push(toDiffEntry("copy", path, copyFrom.entry, current, copyFrom.path));
    }
  }

  out.push(...deletes.values(), ...adds.values());
  return out.sort((left, right) => left.path.localeCompare(right.path));
}

function diffTypeForSamePath(
  previous: SnapshotEntry,
  current: SnapshotEntry,
): Exclude<VirtualDiffType, "add" | "delete" | "rename" | "copy"> | null {
  const previousKind = modeKind(previous.mode);
  const currentKind = modeKind(current.mode);
  if (previousKind !== currentKind) {
    return "typechange";
  }
  if (previous.mode !== current.mode || previous.hash !== current.hash) {
    return "modify";
  }
  return null;
}

function toDiffEntry(
  type: VirtualDiffType,
  path: string,
  previous: SnapshotEntry | null,
  current: SnapshotEntry | null,
  oldPath?: string,
): VirtualDiffEntry {
  return {
    type,
    path,
    oldPath,
    previousMode: previous?.mode ?? null,
    currentMode: current?.mode ?? null,
    previousHash: previous?.hash ?? null,
    currentHash: current?.hash ?? null,
  };
}

function snapshotBaseTree(source: ObjectSource, treeHash: SHA1, dirPath: string): SnapshotEntry[] {
  const tree = readRepoTree(source, treeHash, dirPath);
  const out: SnapshotEntry[] = [];

  for (const entry of tree.entries) {
    const path = dirPath === VIRTUAL_ROOT_PATH ? entry.name : `${dirPath}/${entry.name}`;
    if (entry.mode === "40000") {
      out.push(...snapshotBaseTree(source, entry.hash, path));
      continue;
    }
    const mode = normalizeBlobMode(entry.mode);
    out.push({
      path,
      mode,
      hash: entry.hash,
      originSignature: buildOriginSignature(mode, entry.hash),
    });
  }

  return out;
}

function snapshotCurrentTree(
  source: ObjectSource,
  state: VirtualWorkdirStateStore,
): SnapshotEntry[] {
  const root = state.getNode("root" as SessionNode["id"]);
  if (root === null) {
    throw new Error("Virtual workdir session is missing root node");
  }
  return snapshotCurrentNode(source, state, root, VIRTUAL_ROOT_PATH);
}

function snapshotCurrentNode(
  source: ObjectSource,
  state: VirtualWorkdirStateStore,
  node: SessionNode,
  path: string,
): SnapshotEntry[] {
  if (node.state.kind === "directory") {
    const children = listDirectoryChildren(source, state, node, path);
    const out: SnapshotEntry[] = [];
    for (const child of children) {
      const childNode = state.getNode(child.nodeId);
      if (childNode === null) {
        continue;
      }
      const childPath = path === VIRTUAL_ROOT_PATH ? child.name : `${path}/${child.name}`;
      out.push(...snapshotCurrentNode(source, state, childNode, childPath));
    }
    return out;
  }

  const mode = node.state.mode;
  const hash = currentNodeHash(source, node, path);
  return [
    {
      path,
      mode,
      hash,
      originSignature:
        node.origin.kind === "repo-blob"
          ? buildOriginSignature(node.origin.mode, node.origin.hash)
          : null,
    },
  ];
}

function currentNodeHash(source: ObjectSource, node: SessionNode, path: string): SHA1 {
  if (node.state.kind === "file") {
    if (node.state.content !== undefined) {
      return hashObject("blob", node.state.content);
    }
    if (node.origin.kind === "repo-blob") {
      return node.origin.hash;
    }
  }

  if (node.state.kind === "symlink") {
    if (node.state.target !== undefined) {
      return hashObject("blob", node.state.target);
    }
    if (node.origin.kind === "repo-blob") {
      return node.origin.hash;
    }
  }

  if (node.origin.kind === "repo-blob") {
    const content = readRepoBlobContent(source, node.origin.hash, path);
    return hashObject("blob", content);
  }

  throw new Error(`Virtual workdir diff cannot resolve hash for path: ${path}`);
}

function normalizeBlobMode(mode: string): "100644" | "100755" | "120000" {
  if (mode === "100755" || mode === "120000") {
    return mode;
  }
  return "100644";
}

function buildOriginSignature(mode: "100644" | "100755" | "120000", hash: SHA1): string {
  return `${mode}:${hash}`;
}

function indexDeletesBySignature(
  deletes: ReadonlyMap<string, VirtualDiffEntry>,
): ReadonlyMap<string, VirtualDiffEntry[]> {
  const out = new Map<string, VirtualDiffEntry[]>();
  for (const entry of deletes.values()) {
    if (entry.previousMode === null || entry.previousHash === null) {
      continue;
    }
    const signature = buildOriginSignature(
      normalizeBlobMode(entry.previousMode),
      entry.previousHash,
    );
    const list = out.get(signature) ?? [];
    list.push(entry);
    out.set(signature, list);
  }
  return out;
}

function findCopySource(
  baseEntries: readonly SnapshotEntry[],
  current: SnapshotEntry,
): CopySourceMatch | null {
  if (current.originSignature === null) {
    return null;
  }

  const source = baseEntries
    .filter((entry) => entry.originSignature === current.originSignature)
    .sort((left, right) => left.path.localeCompare(right.path))[0];
  if (source === undefined) {
    return null;
  }
  return { path: source.path, entry: source };
}

function modeKind(mode: TreeEntry["mode"]): "blob" | "symlink" {
  return mode === "120000" ? "symlink" : "blob";
}
