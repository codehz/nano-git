/**
 * Virtual Worktree 文件系统持久化实现
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

import { openVirtualWorktree } from "../engine/worktree.ts";
import { createRootDirectoryNode, type WorktreeNode } from "../model/nodes.ts";
import {
  parseChangeRecordFromManifest,
  serializeChangeRecordToManifest,
} from "./persist/change-codec.ts";
import { parseNodeOrigin } from "./persist/origin-codec.ts";
import {
  parseDirectoryOverlay,
  serializeDirectoryOverlayPayload,
} from "./persist/overlay-codec.ts";

import type { SHA1 } from "../../core/types.ts";
import type { ObjectDatabase } from "../../core/types/odb.ts";
import type { CreateVirtualWorktreeOptions, VirtualWorktree } from "../core.ts";
import type { NormalizedChangeRecord } from "../engine/change-index.ts";
import type { NodeId } from "../model/ids.ts";
import type { FileWorktreeManifest, PersistedFileNodeRecord } from "./persist/node-wire.ts";
import type { VirtualWorktreeStateStore } from "./state-store.ts";

const FILE_WORKTREE_MANIFEST_VERSION = 7;
const FILE_WORKTREE_TRANSACTION_SNAPSHOT_SUFFIX = ".txn-snapshot";

type FileSessionManifest = FileWorktreeManifest;
type FileNodeRecord = PersistedFileNodeRecord;

/** 打开文件系统 VirtualWorktree 的可选参数 */
export interface OpenFileVirtualWorktreeOptions extends CreateVirtualWorktreeOptions {
  /** 不存在时按 baseTree 初始化 */
  readonly create?: boolean;
}

/**
 * 打开基于目录持久化的 VirtualWorktree
 *
 * @example
 * ```ts
 * const worktree = openFileVirtualWorktree(repo.objects, "/tmp/worktree", {
 *   baseTree: tree,
 *   create: true,
 * });
 * expect(worktree.baseTree).toBe(tree);
 * ```
 */
export function openFileVirtualWorktree(
  source: ObjectDatabase,
  worktreeDir: string,
  options: OpenFileVirtualWorktreeOptions,
): VirtualWorktree {
  const store = createFileVirtualWorktreeStateStore(worktreeDir);
  if (!hasFileVirtualWorktree(worktreeDir)) {
    if (options.create !== true) {
      throw new Error(`Virtual worktree not found: ${worktreeDir}`);
    }
    store.reset(options.baseTree);
  }
  validateFileVirtualWorktreeIntegrity(worktreeDir);
  return openVirtualWorktree(source, store);
}

/**
 * 删除指定目录上的持久化 VirtualWorktree
 *
 * @example
 * ```ts
 * deleteFileVirtualWorktree("/tmp/worktree");
 * ```
 */
export function deleteFileVirtualWorktree(worktreeDir: string): void {
  if (!hasFileVirtualWorktree(worktreeDir)) {
    throw new Error(`Virtual worktree not found: ${worktreeDir}`);
  }
  rmSync(worktreeDir, { recursive: true, force: true });
}

/**
 * 创建单个文件系统 VirtualWorktree 的状态存储
 *
 * @example
 * ```ts
 * const store = createFileVirtualWorktreeStateStore("/tmp/worktree");
 * expect(store.kind).toBe("file");
 * ```
 */
export function createFileVirtualWorktreeStateStore(
  worktreeDir: string,
): VirtualWorktreeStateStore {
  const manifestPath = getManifestPath(worktreeDir);
  const contentDir = getContentDir(worktreeDir);

  return {
    kind: "file",

    transact<T>(fn: () => T): T {
      const snapshotDir = `${worktreeDir}${FILE_WORKTREE_TRANSACTION_SNAPSHOT_SUFFIX}`;
      rmSync(snapshotDir, { recursive: true, force: true });

      if (existsSync(worktreeDir)) {
        copyDirectoryRecursive(worktreeDir, snapshotDir);
      }

      try {
        const result = fn();
        rmSync(snapshotDir, { recursive: true, force: true });
        return result;
      } catch (error) {
        rmSync(worktreeDir, { recursive: true, force: true });
        if (existsSync(snapshotDir)) {
          renameSync(snapshotDir, worktreeDir);
        }
        throw error;
      }
    },

    readBaseTree(): SHA1 {
      return readManifest(manifestPath).baseTree as SHA1;
    },

    writeBaseTree(baseTree: SHA1): void {
      updateManifest(worktreeDir, (manifest) => ({ ...manifest, baseTree }));
    },

    getNode(id: NodeId): WorktreeNode | null {
      const manifest = readManifest(manifestPath);
      const record = manifest.nodes[id];
      if (record === undefined) {
        return null;
      }
      return restoreNode(record, contentDir);
    },

    setNode(node: WorktreeNode): void {
      updateManifest(worktreeDir, (manifest) => {
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
      updateManifest(worktreeDir, (manifest) => {
        if (manifest.nodes[id] === undefined) {
          return manifest;
        }
        const { [id]: _deleted, ...rest } = manifest.nodes;
        return { ...manifest, nodes: rest };
      });
    },

    listChangeRecords(): readonly NormalizedChangeRecord[] {
      return readManifest(manifestPath).changeRecords.map(parseChangeRecordFromManifest);
    },

    getChangeRecord(path: string): NormalizedChangeRecord | null {
      return (
        readManifest(manifestPath)
          .changeRecords.map(parseChangeRecordFromManifest)
          .find((record) => record.path === path) ?? null
      );
    },

    setChangeRecord(record: NormalizedChangeRecord): void {
      updateManifest(worktreeDir, (manifest) => {
        const others = manifest.changeRecords.filter((item) => item.path !== record.path);
        return {
          ...manifest,
          changeRecords: [...others, serializeChangeRecordToManifest(record)].sort((left, right) =>
            left.path.localeCompare(right.path),
          ),
        };
      });
    },

    deleteChangeRecord(path: string): void {
      updateManifest(worktreeDir, (manifest) => ({
        ...manifest,
        changeRecords: manifest.changeRecords.filter((item) => item.path !== path),
      }));
    },

    reset(baseTree: SHA1): void {
      rmSync(worktreeDir, { recursive: true, force: true });
      ensureWorktreeDirs(worktreeDir, contentDir);
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

function hasFileVirtualWorktree(worktreeDir: string): boolean {
  return existsSync(getManifestPath(worktreeDir));
}

export function validateFileVirtualWorktreeIntegrity(worktreeDir: string): void {
  const manifest = readManifest(getManifestPath(worktreeDir));
  const root = manifest.nodes.root;
  if (root === undefined) {
    throw new Error(`Virtual worktree is corrupted: missing root node for ${worktreeDir}`);
  }
  const rootNode = restoreNode(root, getContentDir(worktreeDir));
  if (rootNode.state.kind !== "directory") {
    throw new Error(
      `Virtual worktree is corrupted: root node is not a directory for ${worktreeDir}`,
    );
  }
  for (const record of Object.values(manifest.nodes)) {
    restoreNode(record, getContentDir(worktreeDir));
  }
}

function getManifestPath(worktreeDir: string): string {
  return join(worktreeDir, "manifest.json");
}

function getContentDir(worktreeDir: string): string {
  return join(worktreeDir, "content");
}

function getContentPath(contentDir: string, payloadRef: string): string {
  return join(contentDir, `${encodePathToken(payloadRef)}.bin`);
}

function ensureWorktreeDirs(worktreeDir: string, contentDir: string): void {
  mkdirSync(worktreeDir, { recursive: true });
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
    formatVersion: FILE_WORKTREE_MANIFEST_VERSION,
    baseTree,
    nodes,
    changeRecords: [],
  };
}

function updateManifest(
  worktreeDir: string,
  updater: (manifest: FileSessionManifest) => FileSessionManifest,
): void {
  const manifestPath = getManifestPath(worktreeDir);
  const contentDir = getContentDir(worktreeDir);
  ensureWorktreeDirs(worktreeDir, contentDir);
  const next = updater(readManifest(manifestPath));
  writeManifestAtomic(manifestPath, next);
}

function writeManifestAtomic(path: string, manifest: FileSessionManifest): void {
  writeJsonAtomic(path, manifest);
}

function readManifest(manifestPath: string): FileSessionManifest {
  if (!existsSync(manifestPath)) {
    throw new Error(`Virtual worktree manifest not found: ${manifestPath}`);
  }
  const manifest = readJson<FileSessionManifest>(manifestPath);
  validateManifest(manifest);
  return manifest;
}

function validateManifest(manifest: FileSessionManifest): void {
  if (typeof manifest.baseTree !== "string" || manifest.baseTree.length === 0) {
    throw new Error("Invalid virtual worktree manifest baseTree");
  }
  if (
    typeof manifest.nodes !== "object" ||
    manifest.nodes === null ||
    Array.isArray(manifest.nodes)
  ) {
    throw new Error("Invalid virtual worktree manifest nodes");
  }
  if (!Array.isArray(manifest.changeRecords)) {
    throw new Error("Invalid virtual worktree manifest changeRecords");
  }
  if (manifest.formatVersion !== FILE_WORKTREE_MANIFEST_VERSION) {
    throw new Error(
      `Unsupported virtual worktree file manifest version: expected ${FILE_WORKTREE_MANIFEST_VERSION}, got ${manifest.formatVersion}`,
    );
  }
}

function persistNode(contentDir: string, node: WorktreeNode): FileNodeRecord {
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

function serializeDirectoryNode(node: WorktreeNode): FileNodeRecord {
  if (node.state.kind !== "directory") {
    throw new Error("serializeDirectoryNode: node is not a directory");
  }
  return {
    id: node.id,
    origin: node.origin,
    state: {
      kind: "directory",
      overlay: serializeDirectoryOverlayPayload(node.state.overlay),
    },
  };
}

function persistPayload(contentDir: string, nodeId: NodeId, payload: Buffer): string {
  mkdirSync(contentDir, { recursive: true });
  const payloadRef = `${nodeId}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  writeBufferAtomic(getContentPath(contentDir, payloadRef), payload);
  return payloadRef;
}

function restoreNode(record: FileNodeRecord, contentDir: string): WorktreeNode {
  const origin = parseNodeOrigin(record.origin);
  if (record.state.kind === "directory") {
    return {
      id: record.id as NodeId,
      origin,
      state: {
        kind: "directory",
        overlay: parseDirectoryOverlay(record.state.overlay),
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
      throw new Error(`Invalid file worktree node state mode: ${String(mode)}`);
    }
    const contentRef = rawState.contentRef;
    if (contentRef !== undefined && contentRef !== null && typeof contentRef !== "string") {
      throw new Error("Invalid file worktree node content ref");
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
    throw new Error(`Invalid file worktree node state kind: ${String(rawState.kind)}`);
  }

  const targetRef = rawState.targetRef;
  if (targetRef !== undefined && targetRef !== null && typeof targetRef !== "string") {
    throw new Error("Invalid file worktree node target ref");
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

function readPayload(contentDir: string, payloadRef: string): Buffer {
  const path = getContentPath(contentDir, payloadRef);
  if (!existsSync(path)) {
    throw new Error(`Virtual worktree payload not found: ${payloadRef}`);
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
