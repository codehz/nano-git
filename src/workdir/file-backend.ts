/**
 * Virtual Workdir 文件系统持久化实现
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { sha1 } from "../core/types.ts";
import { createRootDirectoryNode, type WorkdirNode } from "./nodes.ts";
import { openVirtualWorkdir } from "./workdir.ts";

import type { SHA1 } from "../core/types.ts";
import type { ObjectDatabase } from "../core/types/odb.ts";
import type { NormalizedChangeRecord } from "./change-index.ts";
import type { CreateVirtualWorkdirOptions, VirtualDiffSource, VirtualWorkdir } from "./core.ts";
import type { DirtyDirHashState, DirtyDirSummary } from "./dirty-dir.ts";
import type { NodeId } from "./ids.ts";
import type { VirtualWorkdirStateStore } from "./state-store.ts";

const FILE_WORKDIR_MANIFEST_VERSION = 5;
const FILE_WORKDIR_TRANSACTION_SNAPSHOT_SUFFIX = ".txn-snapshot";

interface FileSessionManifest {
  readonly formatVersion: number;
  readonly baseTree: string;
  readonly nodes: Readonly<Record<string, FileNodeRecord>>;
  readonly changeRecords: readonly FileChangeRecord[];
  readonly dirtyDirSummaries: readonly FileDirtyDirSummary[];
}

interface FileChangeRecord {
  readonly path: string;
  readonly previous: {
    readonly kind: "blob" | "tree" | "symlink";
    readonly mode: "100644" | "100755" | "040000" | "120000";
    readonly hash: string;
  } | null;
  readonly current: {
    readonly kind: "blob" | "tree" | "symlink";
    readonly mode: "100644" | "100755" | "040000" | "120000";
    readonly hash: string;
  } | null;
  /** move/copy 来源；`rename` 为旧版磁盘格式，读入时规范为 `move` */
  readonly source: {
    readonly kind: "move" | "copy" | "rename";
    readonly path: string;
  } | null;
}

interface FileDirtyDirSummary {
  readonly path: string;
  readonly isDirty: boolean;
  readonly dirtyEntryCount: number;
  readonly dirtyDescendantCount: number;
  readonly affectedNames: readonly string[];
  readonly currentTreeHash: string | null;
  readonly hashState: DirtyDirHashState;
}

interface FileNodeRecord {
  readonly id: string;
  readonly origin:
    | { readonly kind: "none" }
    | { readonly kind: "repo-tree"; readonly hash: string }
    | {
        readonly kind: "repo-blob";
        readonly mode: "100644" | "100755" | "120000";
        readonly hash: string;
      };
  readonly state:
    | {
        readonly kind: "directory";
        readonly overlay: {
          readonly addedEntries: Array<[string, string]>;
          readonly deletedNames: string[];
        };
      }
    | {
        readonly kind: "file";
        readonly mode: "100644" | "100755";
        readonly contentRef: string | null;
      }
    | {
        readonly kind: "symlink";
        readonly mode: "120000";
        readonly targetRef: string | null;
      };
}

/** 打开文件系统 VirtualWorkdir 的可选参数 */
export interface OpenFileVirtualWorkdirOptions extends CreateVirtualWorkdirOptions {
  /** 不存在时按 baseTree 初始化 */
  readonly create?: boolean;
}

/**
 * 打开基于目录持久化的 VirtualWorkdir
 *
 * @example
 * ```ts
 * const workdir = openFileVirtualWorkdir(repo.objects, "/tmp/workdir", {
 *   baseTree: tree,
 *   create: true,
 * });
 * expect(workdir.baseTree).toBe(tree);
 * ```
 */
export function openFileVirtualWorkdir(
  source: ObjectDatabase,
  workdirDir: string,
  options: OpenFileVirtualWorkdirOptions,
): VirtualWorkdir {
  const store = createFileVirtualWorkdirStateStore(workdirDir);
  if (!hasFileVirtualWorkdir(workdirDir)) {
    if (options.create !== true) {
      throw new Error(`Virtual workdir not found: ${workdirDir}`);
    }
    store.reset(options.baseTree);
  }
  validateFileVirtualWorkdirIntegrity(workdirDir);
  return openVirtualWorkdir(source, store);
}

/**
 * 删除指定目录上的持久化 VirtualWorkdir
 *
 * @example
 * ```ts
 * deleteFileVirtualWorkdir("/tmp/workdir");
 * ```
 */
export function deleteFileVirtualWorkdir(workdirDir: string): void {
  if (!hasFileVirtualWorkdir(workdirDir)) {
    throw new Error(`Virtual workdir not found: ${workdirDir}`);
  }
  rmSync(workdirDir, { recursive: true, force: true });
}

/**
 * 创建单个文件系统 VirtualWorkdir 的状态存储
 *
 * @example
 * ```ts
 * const store = createFileVirtualWorkdirStateStore("/tmp/workdir");
 * expect(store.kind).toBe("file");
 * ```
 */
export function createFileVirtualWorkdirStateStore(workdirDir: string): VirtualWorkdirStateStore {
  const manifestPath = getManifestPath(workdirDir);
  const contentDir = getContentDir(workdirDir);

  return {
    kind: "file",

    transact<T>(fn: () => T): T {
      const snapshotDir = `${workdirDir}${FILE_WORKDIR_TRANSACTION_SNAPSHOT_SUFFIX}`;
      rmSync(snapshotDir, { recursive: true, force: true });

      if (existsSync(workdirDir)) {
        copyDirectoryRecursive(workdirDir, snapshotDir);
      }

      try {
        const result = fn();
        rmSync(snapshotDir, { recursive: true, force: true });
        return result;
      } catch (error) {
        rmSync(workdirDir, { recursive: true, force: true });
        if (existsSync(snapshotDir)) {
          renameSync(snapshotDir, workdirDir);
        }
        throw error;
      }
    },

    readBaseTree(): SHA1 {
      return readManifest(manifestPath).baseTree as SHA1;
    },

    writeBaseTree(baseTree: SHA1): void {
      updateManifest(workdirDir, (manifest) => ({ ...manifest, baseTree }));
    },

    getNode(id: NodeId): WorkdirNode | null {
      const manifest = readManifest(manifestPath);
      const record = manifest.nodes[id];
      if (record === undefined) {
        return null;
      }
      return restoreNode(record, contentDir);
    },

    setNode(node: WorkdirNode): void {
      updateManifest(workdirDir, (manifest) => {
        const record = persistNode(contentDir, node);
        return {
          ...manifest,
          nodes: {
            ...manifest.nodes,
            [node.id]: record,
          },
        };
      });
    },

    deleteNode(id: NodeId): void {
      updateManifest(workdirDir, (manifest) => {
        if (manifest.nodes[id] === undefined) {
          return manifest;
        }
        const { [id]: _deleted, ...rest } = manifest.nodes;
        return { ...manifest, nodes: rest };
      });
    },

    listChangeRecords(): readonly NormalizedChangeRecord[] {
      return readManifest(manifestPath).changeRecords.map(restoreChangeRecord);
    },

    getChangeRecord(path: string): NormalizedChangeRecord | null {
      return (
        readManifest(manifestPath)
          .changeRecords.map(restoreChangeRecord)
          .find((record) => record.path === path) ?? null
      );
    },

    setChangeRecord(record: NormalizedChangeRecord): void {
      updateManifest(workdirDir, (manifest) => {
        const others = manifest.changeRecords.filter((item) => item.path !== record.path);
        return {
          ...manifest,
          changeRecords: [...others, serializeChangeRecord(record)].sort((left, right) =>
            left.path.localeCompare(right.path),
          ),
        };
      });
    },

    deleteChangeRecord(path: string): void {
      updateManifest(workdirDir, (manifest) => ({
        ...manifest,
        changeRecords: manifest.changeRecords.filter((item) => item.path !== path),
      }));
    },

    listDirtyDirSummaries(): readonly DirtyDirSummary[] {
      return readManifest(manifestPath).dirtyDirSummaries.map(restoreDirtyDirSummary);
    },

    getDirtyDirSummary(path: string): DirtyDirSummary | null {
      return (
        readManifest(manifestPath)
          .dirtyDirSummaries.map(restoreDirtyDirSummary)
          .find((summary) => summary.path === path) ?? null
      );
    },

    setDirtyDirSummary(summary: DirtyDirSummary): void {
      updateManifest(workdirDir, (manifest) => {
        const others = manifest.dirtyDirSummaries.filter((item) => item.path !== summary.path);
        return {
          ...manifest,
          dirtyDirSummaries: [...others, serializeDirtyDirSummary(summary)].sort((left, right) =>
            left.path.localeCompare(right.path),
          ),
        };
      });
    },

    deleteDirtyDirSummary(path: string): void {
      updateManifest(workdirDir, (manifest) => ({
        ...manifest,
        dirtyDirSummaries: manifest.dirtyDirSummaries.filter((item) => item.path !== path),
      }));
    },

    reset(baseTree: SHA1): void {
      rmSync(workdirDir, { recursive: true, force: true });
      ensureWorkdirDirs(workdirDir, contentDir);
      writeManifestAtomic(
        manifestPath,
        createManifest(baseTree, {
          [createRootDirectoryNode(baseTree).id]: serializeDirectoryNode(
            createRootDirectoryNode(baseTree),
          ),
        }),
      );
    },
  };
}

function hasFileVirtualWorkdir(workdirDir: string): boolean {
  return existsSync(getManifestPath(workdirDir));
}

export function validateFileVirtualWorkdirIntegrity(workdirDir: string): void {
  const manifest = readManifest(getManifestPath(workdirDir));
  const root = manifest.nodes.root;
  if (root === undefined) {
    throw new Error(`Virtual workdir is corrupted: missing root node for ${workdirDir}`);
  }
  const rootNode = restoreNode(root, getContentDir(workdirDir));
  if (rootNode.state.kind !== "directory") {
    throw new Error(`Virtual workdir is corrupted: root node is not a directory for ${workdirDir}`);
  }
  for (const record of Object.values(manifest.nodes)) {
    restoreNode(record, getContentDir(workdirDir));
  }
}

function getManifestPath(workdirDir: string): string {
  return join(workdirDir, "manifest.json");
}

function getContentDir(workdirDir: string): string {
  return join(workdirDir, "content");
}

function getContentPath(contentDir: string, payloadRef: string): string {
  return join(contentDir, `${encodePathToken(payloadRef)}.bin`);
}

function ensureWorkdirDirs(workdirDir: string, contentDir: string): void {
  mkdirSync(workdirDir, { recursive: true });
  mkdirSync(contentDir, { recursive: true });
}

function copyDirectoryRecursive(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryRecursive(sourcePath, targetPath);
      continue;
    }

    writeFileSync(targetPath, readFileSync(sourcePath));
  }
}

function createManifest(
  baseTree: SHA1,
  nodes: Readonly<Record<string, FileNodeRecord>>,
): FileSessionManifest {
  return {
    formatVersion: FILE_WORKDIR_MANIFEST_VERSION,
    baseTree,
    nodes,
    changeRecords: [],
    dirtyDirSummaries: [],
  };
}

function updateManifest(
  workdirDir: string,
  updater: (manifest: FileSessionManifest) => FileSessionManifest,
): void {
  const manifestPath = getManifestPath(workdirDir);
  const contentDir = getContentDir(workdirDir);
  ensureWorkdirDirs(workdirDir, contentDir);
  const next = updater(readManifest(manifestPath));
  writeManifestAtomic(manifestPath, next);
}

function writeManifestAtomic(path: string, manifest: FileSessionManifest): void {
  writeJsonAtomic(path, manifest);
}

function readManifest(manifestPath: string): FileSessionManifest {
  if (!existsSync(manifestPath)) {
    throw new Error(`Virtual workdir manifest not found: ${manifestPath}`);
  }
  const manifest = readJson<FileSessionManifest>(manifestPath);
  validateManifest(manifest);
  return manifest;
}

function validateManifest(manifest: FileSessionManifest): void {
  if (typeof manifest.baseTree !== "string" || manifest.baseTree.length === 0) {
    throw new Error("Invalid virtual workdir manifest baseTree");
  }
  if (
    typeof manifest.nodes !== "object" ||
    manifest.nodes === null ||
    Array.isArray(manifest.nodes)
  ) {
    throw new Error("Invalid virtual workdir manifest nodes");
  }
  if (!Array.isArray(manifest.changeRecords)) {
    throw new Error("Invalid virtual workdir manifest changeRecords");
  }
  if (!Array.isArray(manifest.dirtyDirSummaries)) {
    throw new Error("Invalid virtual workdir manifest dirtyDirSummaries");
  }
  if (manifest.formatVersion !== FILE_WORKDIR_MANIFEST_VERSION) {
    throw new Error(
      `Unsupported virtual workdir file manifest version: expected ${FILE_WORKDIR_MANIFEST_VERSION}, got ${manifest.formatVersion}`,
    );
  }
}

function persistNode(contentDir: string, node: WorkdirNode): FileNodeRecord {
  if (node.state.kind === "directory") {
    return serializeDirectoryNode(node);
  }

  if (node.state.kind === "file") {
    const contentRef =
      node.state.content === undefined
        ? null
        : persistPayload(contentDir, node.id, node.state.content);
    return {
      id: node.id,
      origin: node.origin,
      state: {
        kind: "file",
        mode: node.state.mode,
        contentRef,
      },
    };
  }

  const targetRef =
    node.state.target === undefined ? null : persistPayload(contentDir, node.id, node.state.target);
  return {
    id: node.id,
    origin: node.origin,
    state: {
      kind: "symlink",
      mode: "120000",
      targetRef,
    },
  };
}

function serializeDirectoryNode(node: WorkdirNode): FileNodeRecord {
  if (node.state.kind !== "directory") {
    throw new Error("serializeDirectoryNode: node is not a directory");
  }
  return {
    id: node.id,
    origin: node.origin,
    state: {
      kind: "directory",
      overlay: {
        addedEntries: Array.from(node.state.overlay.addedEntries.entries()),
        deletedNames: Array.from(node.state.overlay.deletedNames.values()),
      },
    },
  };
}

function persistPayload(contentDir: string, nodeId: NodeId, payload: Buffer): string {
  mkdirSync(contentDir, { recursive: true });
  const payloadRef = `${nodeId}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  writeBufferAtomic(getContentPath(contentDir, payloadRef), payload);
  return payloadRef;
}

function restoreNode(record: FileNodeRecord, contentDir: string): WorkdirNode {
  const origin = restoreOrigin(record.origin);
  if (record.state.kind === "directory") {
    return {
      id: record.id as NodeId,
      origin,
      state: {
        kind: "directory",
        overlay: readDirectoryOverlayRecord(record.state.overlay),
      },
    };
  }

  const rawState = record.state as {
    readonly kind?: string;
    readonly mode?: string;
    readonly contentRef?: string | null;
    readonly targetRef?: string | null;
  };

  if (rawState.kind === "file") {
    const mode = rawState.mode;
    if (mode !== "100644" && mode !== "100755") {
      throw new Error(`Invalid file workdir node state mode: ${String(mode)}`);
    }
    const contentRef = rawState.contentRef;
    if (contentRef !== undefined && contentRef !== null && typeof contentRef !== "string") {
      throw new Error("Invalid file workdir node content ref");
    }
    return {
      id: record.id as NodeId,
      origin,
      state: {
        kind: "file",
        mode,
        content:
          contentRef === undefined || contentRef === null
            ? undefined
            : readPayload(contentDir, contentRef),
      },
    };
  }

  if (rawState.kind !== "symlink") {
    throw new Error(`Invalid file workdir node state kind: ${String(rawState.kind)}`);
  }

  const targetRef = rawState.targetRef;
  if (targetRef !== undefined && targetRef !== null && typeof targetRef !== "string") {
    throw new Error("Invalid file workdir node target ref");
  }

  return {
    id: record.id as NodeId,
    origin,
    state: {
      kind: "symlink",
      mode: "120000",
      target:
        targetRef === undefined || targetRef === null
          ? undefined
          : readPayload(contentDir, targetRef),
    },
  };
}

function readDirectoryOverlayRecord(value: unknown): {
  readonly addedEntries: Map<string, NodeId>;
  readonly deletedNames: Set<string>;
} {
  if (!isFileDirectoryOverlayPayload(value)) {
    throw new Error("Invalid file workdir directory overlay payload");
  }

  return {
    addedEntries: new Map(
      value.addedEntries.map(([name, nodeId]: [string, string]) => [name, nodeId as NodeId]),
    ),
    deletedNames: new Set(value.deletedNames),
  };
}

function isFileDirectoryOverlayPayload(
  value: unknown,
): value is { addedEntries: Array<[string, string]>; deletedNames: string[] } {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const maybe = value as {
    addedEntries?: unknown;
    deletedNames?: unknown;
  };
  if (!Array.isArray(maybe.addedEntries) || !Array.isArray(maybe.deletedNames)) {
    return false;
  }

  const hasValidAddedEntries = maybe.addedEntries.every(
    (entry) =>
      Array.isArray(entry) &&
      entry.length === 2 &&
      typeof entry[0] === "string" &&
      typeof entry[1] === "string",
  );
  const hasValidDeletedNames = maybe.deletedNames.every((name) => typeof name === "string");
  return hasValidAddedEntries && hasValidDeletedNames;
}

function restoreOrigin(record: FileNodeRecord["origin"]): WorkdirNode["origin"] {
  const origin = record as
    | { readonly kind: "none" }
    | { readonly kind: "repo-tree"; readonly hash: string }
    | { readonly kind: "repo-blob"; readonly mode: string; readonly hash: string }
    | { readonly kind: string; readonly mode?: string; readonly hash?: string };

  if (origin.kind === "none") {
    return { kind: "none" };
  }
  if (origin.kind === "repo-tree") {
    if (typeof origin.hash !== "string" || origin.hash.length === 0) {
      throw new Error("Invalid file workdir node: repo-tree origin is missing hash");
    }
    return { kind: "repo-tree", hash: origin.hash as SHA1 };
  }
  if (origin.kind !== "repo-blob") {
    throw new Error(`Invalid file workdir node origin kind: ${String(origin.kind)}`);
  }
  if (typeof origin.hash !== "string" || origin.hash.length === 0) {
    throw new Error("Invalid file workdir node: repo-blob origin is missing hash");
  }
  if (origin.mode !== "100644" && origin.mode !== "100755" && origin.mode !== "120000") {
    throw new Error(`Invalid file workdir node origin mode: ${String(origin.mode)}`);
  }
  return {
    kind: "repo-blob",
    mode: origin.mode,
    hash: origin.hash as SHA1,
  };
}

function serializeChangeRecord(record: NormalizedChangeRecord): FileChangeRecord {
  return {
    path: record.path,
    previous: record.previous,
    current: record.current,
    source: record.source,
  };
}

function restoreChangeRecord(record: FileChangeRecord): NormalizedChangeRecord {
  return {
    path: record.path,
    previous:
      record.previous === null ? null : { ...record.previous, hash: record.previous.hash as SHA1 },
    current:
      record.current === null ? null : { ...record.current, hash: record.current.hash as SHA1 },
    source: record.source === null ? null : readFileDiffSource(record.source),
  };
}

function readFileDiffSource(source: NonNullable<FileChangeRecord["source"]>): VirtualDiffSource {
  if (source.kind === "copy") {
    return { kind: "copy", path: source.path };
  }
  if (source.kind === "move" || source.kind === "rename") {
    return { kind: "move", path: source.path };
  }
  throw new Error(`Invalid file workdir diff source kind: ${String(source.kind)}`);
}

function serializeDirtyDirSummary(summary: DirtyDirSummary): FileDirtyDirSummary {
  return {
    path: summary.path,
    isDirty: summary.isDirty,
    dirtyEntryCount: summary.dirtyEntryCount,
    dirtyDescendantCount: summary.dirtyDescendantCount,
    affectedNames: [...summary.affectedNames],
    currentTreeHash: summary.currentTreeHash,
    hashState: summary.hashState,
  };
}

function restoreDirtyDirSummary(summary: FileDirtyDirSummary): DirtyDirSummary {
  return {
    path: summary.path,
    isDirty: summary.isDirty,
    dirtyEntryCount: readDirtyDirCount(summary.dirtyEntryCount, "dirtyEntryCount"),
    dirtyDescendantCount: readDirtyDirCount(summary.dirtyDescendantCount, "dirtyDescendantCount"),
    affectedNames: readDirtyDirAffectedNames(summary.affectedNames),
    currentTreeHash: summary.currentTreeHash === null ? null : sha1(summary.currentTreeHash),
    hashState: readDirtyDirHashState(summary.hashState),
  };
}

function readDirtyDirCount(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new Error(`Invalid file workdir dirty dir summary ${field}`);
  }
  return raw;
}

function readDirtyDirAffectedNames(raw: unknown): readonly string[] {
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
    throw new Error("Invalid file workdir dirty dir summary affectedNames");
  }
  const names = raw as string[];
  return [...names].sort((left, right) => left.localeCompare(right));
}

function readDirtyDirHashState(raw: unknown): DirtyDirHashState {
  if (raw === "stale" || raw === "materialized") {
    return raw;
  }
  throw new Error(`Invalid file workdir dirty dir summary hashState: ${String(raw)}`);
}

function readPayload(contentDir: string, payloadRef: string): Buffer {
  const path = getContentPath(contentDir, payloadRef);
  if (!existsSync(path)) {
    throw new Error(`Virtual workdir payload not found: ${payloadRef}`);
  }
  return readFileSync(path);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function writeJsonAtomic(path: string, value: unknown): void {
  writeBufferAtomic(path, Buffer.from(JSON.stringify(value), "utf-8"));
}

function writeBufferAtomic(path: string, value: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, value);
  renameSync(tempPath, path);
}

function encodePathToken(value: string): string {
  return encodeURIComponent(value);
}
