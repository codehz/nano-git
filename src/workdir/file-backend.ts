/**
 * Virtual Workdir 文件系统 backend
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

import { createRootDirectoryNode, type SessionNode } from "./nodes.ts";
import { createVirtualWorkdirSessionId } from "./session-id.ts";
import { openVirtualWorkdirSession } from "./session.ts";

import type { SHA1 } from "../core/types.ts";
import type { ObjectDatabase } from "../core/types/odb.ts";
import type { InternalChangeRecord } from "./change-log.ts";
import type {
  CreateVirtualWorkdirSessionOptions,
  VirtualWorkdirBackend,
  VirtualWorkdirSession,
  VirtualWorkdirSessionId,
} from "./core.ts";
import type { NodeId } from "./ids.ts";
import type { VirtualWorkdirStateStore } from "./state-store.ts";

const FILE_WORKDIR_MANIFEST_VERSION = 1;
const FILE_WORKDIR_TRANSACTION_SNAPSHOT_SUFFIX = ".txn-snapshot";

interface FileSessionManifest {
  readonly formatVersion: number;
  readonly baseTree: string;
  readonly changes: readonly InternalChangeRecord[];
  readonly nodes: Readonly<Record<string, FileNodeRecord>>;
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

/** 创建文件系统 Virtual Workdir backend 的可选参数 */
export interface CreateFileVirtualWorkdirBackendOptions {
  /** session 根目录名，默认 `sessions` */
  readonly sessionsDirName?: string;
}

/**
 * 创建基于文件系统目录的 Virtual Workdir backend
 *
 * @example
 * ```ts
 * const backend = createFileVirtualWorkdirBackend("/tmp/workdirs");
 * const sessionId = backend.createSession({ baseTree: tree });
 * const session = backend.openSession(repo.objects, sessionId);
 * expect(session.baseTree).toBe(tree);
 * ```
 */
export function createFileVirtualWorkdirBackend(
  rootDir: string,
  options: CreateFileVirtualWorkdirBackendOptions = {},
): VirtualWorkdirBackend {
  const sessionsRoot = join(rootDir, options.sessionsDirName ?? "sessions");
  mkdirSync(sessionsRoot, { recursive: true });

  return {
    kind: "file",

    createSession(options: CreateVirtualWorkdirSessionOptions): VirtualWorkdirSessionId {
      const sessionId = createVirtualWorkdirSessionId();
      const store = createFileVirtualWorkdirStateStore(sessionsRoot, sessionId);
      store.reset(options.baseTree);
      return sessionId;
    },

    openSession(source: ObjectDatabase, sessionId: VirtualWorkdirSessionId): VirtualWorkdirSession {
      if (!hasSession(sessionsRoot, sessionId)) {
        throw new Error(`Virtual workdir session not found: ${sessionId}`);
      }
      validateSessionIntegrity(sessionsRoot, sessionId);
      return openVirtualWorkdirSession(
        source,
        createFileVirtualWorkdirStateStore(sessionsRoot, sessionId),
      );
    },

    deleteSession(sessionId: VirtualWorkdirSessionId): void {
      if (!hasSession(sessionsRoot, sessionId)) {
        throw new Error(`Virtual workdir session not found: ${sessionId}`);
      }
      rmSync(getSessionDir(sessionsRoot, sessionId), { recursive: true, force: true });
    },

    listSessions(): VirtualWorkdirSessionId[] {
      if (!existsSync(sessionsRoot)) {
        return [];
      }
      return readdirSync(sessionsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .filter((entry) => !entry.name.endsWith(FILE_WORKDIR_TRANSACTION_SNAPSHOT_SUFFIX))
        .filter((entry) => existsSync(getManifestPath(join(sessionsRoot, entry.name))))
        .map((entry) => decodePathToken(entry.name) as VirtualWorkdirSessionId)
        .filter((sessionId) => {
          try {
            validateSessionIntegrity(sessionsRoot, sessionId);
            return true;
          } catch {
            return false;
          }
        })
        .sort();
    },
  };
}

/**
 * 创建单个 session 的文件系统状态存储
 *
 * @example
 * ```ts
 * const store = createFileVirtualWorkdirStateStore("/tmp/workdirs/sessions", sessionId);
 * expect(store.kind).toBe("file");
 * ```
 */
export function createFileVirtualWorkdirStateStore(
  sessionsRoot: string,
  sessionId: VirtualWorkdirSessionId,
): VirtualWorkdirStateStore {
  const sessionDir = getSessionDir(sessionsRoot, sessionId);
  const manifestPath = getManifestPath(sessionDir);
  const contentDir = getContentDir(sessionDir);

  return {
    kind: "file",

    transact<T>(fn: () => T): T {
      const snapshotDir = `${sessionDir}${FILE_WORKDIR_TRANSACTION_SNAPSHOT_SUFFIX}`;
      rmSync(snapshotDir, { recursive: true, force: true });

      if (existsSync(sessionDir)) {
        copyDirectoryRecursive(sessionDir, snapshotDir);
      }

      try {
        const result = fn();
        rmSync(snapshotDir, { recursive: true, force: true });
        return result;
      } catch (error) {
        rmSync(sessionDir, { recursive: true, force: true });
        if (existsSync(snapshotDir)) {
          renameSync(snapshotDir, sessionDir);
        }
        throw error;
      }
    },

    readBaseTree(): SHA1 {
      return readManifest(manifestPath).baseTree as SHA1;
    },

    writeBaseTree(baseTree: SHA1): void {
      updateManifest(sessionDir, (manifest) => ({ ...manifest, baseTree }));
    },

    getNode(id: NodeId): SessionNode | null {
      const manifest = readManifest(manifestPath);
      const record = manifest.nodes[id];
      if (record === undefined) {
        return null;
      }
      return restoreNode(record, contentDir);
    },

    setNode(node: SessionNode): void {
      updateManifest(sessionDir, (manifest) => {
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
      updateManifest(sessionDir, (manifest) => {
        if (manifest.nodes[id] === undefined) {
          return manifest;
        }
        const { [id]: _deleted, ...rest } = manifest.nodes;
        return { ...manifest, nodes: rest };
      });
    },

    appendChange(record: InternalChangeRecord): void {
      updateManifest(sessionDir, (manifest) => ({
        ...manifest,
        changes: [...manifest.changes, record],
      }));
    },

    listChangeRecords(): readonly InternalChangeRecord[] {
      return readManifest(manifestPath).changes;
    },

    clearChanges(): void {
      updateManifest(sessionDir, (manifest) => ({ ...manifest, changes: [] }));
    },

    reset(baseTree: SHA1): void {
      rmSync(sessionDir, { recursive: true, force: true });
      ensureSessionDirs(sessionDir, contentDir);
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

function hasSession(sessionsRoot: string, sessionId: VirtualWorkdirSessionId): boolean {
  return existsSync(getManifestPath(getSessionDir(sessionsRoot, sessionId)));
}

function validateSessionIntegrity(sessionsRoot: string, sessionId: VirtualWorkdirSessionId): void {
  const sessionDir = getSessionDir(sessionsRoot, sessionId);
  const manifest = readManifest(getManifestPath(sessionDir));
  const root = manifest.nodes.root;
  if (root === undefined) {
    throw new Error(`Virtual workdir session is corrupted: missing root node for ${sessionId}`);
  }
  const rootNode = restoreNode(root, getContentDir(sessionDir));
  if (rootNode.state.kind !== "directory") {
    throw new Error(
      `Virtual workdir session is corrupted: root node is not a directory for ${sessionId}`,
    );
  }
  for (const record of Object.values(manifest.nodes)) {
    restoreNode(record, getContentDir(sessionDir));
  }
}

function getSessionDir(sessionsRoot: string, sessionId: VirtualWorkdirSessionId): string {
  return join(sessionsRoot, encodePathToken(sessionId));
}

function getManifestPath(sessionDir: string): string {
  return join(sessionDir, "manifest.json");
}

function getContentDir(sessionDir: string): string {
  return join(sessionDir, "content");
}

function getContentPath(contentDir: string, payloadRef: string): string {
  return join(contentDir, `${encodePathToken(payloadRef)}.bin`);
}

function ensureSessionDirs(sessionDir: string, contentDir: string): void {
  mkdirSync(sessionDir, { recursive: true });
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
    changes: [],
    nodes,
  };
}

function updateManifest(
  sessionDir: string,
  updater: (manifest: FileSessionManifest) => FileSessionManifest,
): void {
  const manifestPath = getManifestPath(sessionDir);
  const contentDir = getContentDir(sessionDir);
  ensureSessionDirs(sessionDir, contentDir);
  const next = updater(readManifest(manifestPath));
  writeManifestAtomic(manifestPath, next);
}

function writeManifestAtomic(path: string, manifest: FileSessionManifest): void {
  writeJsonAtomic(path, manifest);
}

function readManifest(manifestPath: string): FileSessionManifest {
  if (!existsSync(manifestPath)) {
    throw new Error(`Virtual workdir session manifest not found: ${manifestPath}`);
  }
  const manifest = readJson<FileSessionManifest>(manifestPath);
  validateManifest(manifest);
  return manifest;
}

function validateManifest(manifest: FileSessionManifest): void {
  if (typeof manifest.baseTree !== "string" || manifest.baseTree.length === 0) {
    throw new Error("Invalid virtual workdir manifest baseTree");
  }
  if (!Array.isArray(manifest.changes)) {
    throw new Error("Invalid virtual workdir manifest changes");
  }
  if (
    typeof manifest.nodes !== "object" ||
    manifest.nodes === null ||
    Array.isArray(manifest.nodes)
  ) {
    throw new Error("Invalid virtual workdir manifest nodes");
  }
  if (manifest.formatVersion !== FILE_WORKDIR_MANIFEST_VERSION) {
    throw new Error(
      `Unsupported virtual workdir file manifest version: expected ${FILE_WORKDIR_MANIFEST_VERSION}, got ${manifest.formatVersion}`,
    );
  }
}

function persistNode(contentDir: string, node: SessionNode): FileNodeRecord {
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

function serializeDirectoryNode(node: SessionNode): FileNodeRecord {
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

function restoreNode(record: FileNodeRecord, contentDir: string): SessionNode {
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

function restoreOrigin(record: FileNodeRecord["origin"]): SessionNode["origin"] {
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

function decodePathToken(value: string): string {
  return decodeURIComponent(value);
}
