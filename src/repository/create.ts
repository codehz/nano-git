/**
 * 仓库实例创建逻辑
 */

import type {
  RepositoryBackend,
  RepositoryGCOptions,
  RepositoryRepackOptions,
} from "./backend/index.ts";
import { hashObject } from "../core/hash.ts";
import {
  resolveRefHash,
  resolveSymbolicRef,
  resolveTargetHash,
  branchNameToRef,
  tagNameToRef,
  HEAD_REF,
  HEADS_PREFIX,
  TAGS_PREFIX,
} from "../refs/index.ts";
import type {
  GitObject,
  GitBlob,
  GitTree,
  GitCommit,
  GitAuthor,
  TreeEntry,
  SHA1,
  ObjectType,
  GitTag,
} from "../core/types.ts";
import type { Repository } from "./types.ts";
import { listReachableObjects } from "./reachability.ts";
import { writeTreeRecursive } from "./tree-writer.ts";
import { readFileSync } from "node:fs";

function ensureRefDoesNotExist(
  backend: RepositoryBackend,
  ref: string,
  kind: "Branch" | "Tag",
  name: string,
): void {
  if (backend.refs.readRaw(ref) !== null) {
    throw new Error(`${kind} already exists: ${name}`);
  }
}

function listShortRefs(backend: RepositoryBackend, prefix: string): string[] {
  return backend.refs.listRaw(prefix).map((ref) => ref.slice(prefix.length));
}

/**
 * 基于显式后端创建仓库实例
 *
 * Repository 不负责拼装 ObjectStore / RefStore，
 * 调用方需要显式提供统一的 RepositoryBackend。
 *
 * @param backend - 仓库后端
 * @returns 仓库实例
 *
 * @example
 * ```ts
 * const backend = createMemoryRepositoryBackend();
 * const repo = createRepository(backend);
 * ```
 */
export function createRepository(backend: RepositoryBackend): Repository {
  const { objects, refs, packs, gitDir } = backend;

  return {
    backend,
    objects,
    refs,
    packs,
    gitDir,

    hashObject(data: Buffer): SHA1 {
      return hashObject("blob", data);
    },

    writeBlob(data: Buffer): SHA1 {
      const blob: GitBlob = { type: "blob", content: data };
      return objects.write(blob);
    },

    writeBlobFile(filePath: string): SHA1 {
      const content = readFileSync(filePath);
      return this.writeBlob(content);
    },

    catFile(hash: SHA1): GitObject {
      return objects.read(hash);
    },

    catFileType(hash: SHA1): string {
      const obj = objects.read(hash);
      return obj.type;
    },

    listObjects(): SHA1[] {
      return objects.list();
    },

    writeTree(dirPath: string): SHA1 {
      return writeTreeRecursive(objects, dirPath);
    },

    createTree(entries: TreeEntry[]): SHA1 {
      const tree: GitTree = { type: "tree", entries };
      return objects.write(tree);
    },

    createCommit(
      tree: SHA1,
      parents: SHA1[],
      message: string,
      author: GitAuthor,
      committer?: GitAuthor,
    ): SHA1 {
      const commit: GitCommit = {
        type: "commit",
        tree,
        parents,
        author,
        committer: committer ?? author,
        message,
      };
      return objects.write(commit);
    },

    updateRef(ref: string, hash: SHA1): void {
      refs.writeRaw(ref, hash);
    },

    readRef(ref: string): SHA1 | null {
      return resolveRefHash(refs, ref);
    },

    getCurrentBranch(): string | null {
      const symbolicRef = resolveSymbolicRef(refs, HEAD_REF);
      if (!symbolicRef || !symbolicRef.startsWith(HEADS_PREFIX)) {
        return null;
      }
      return symbolicRef.slice(HEADS_PREFIX.length);
    },

    createBranch(name: string, hash?: SHA1): void {
      const ref = branchNameToRef(name);
      ensureRefDoesNotExist(backend, ref, "Branch", name);
      refs.writeRaw(ref, resolveTargetHash(refs, hash));
    },

    readBranch(name: string): SHA1 | null {
      return resolveRefHash(refs, branchNameToRef(name));
    },

    listBranches(): string[] {
      return listShortRefs(backend, HEADS_PREFIX);
    },

    deleteBranch(name: string): void {
      const currentBranch = this.getCurrentBranch();
      if (currentBranch === name) {
        throw new Error(`Cannot delete current branch: ${name}`);
      }
      refs.deleteRaw(branchNameToRef(name));
    },

    createTag(name: string, hash?: SHA1): void {
      const ref = tagNameToRef(name);
      ensureRefDoesNotExist(backend, ref, "Tag", name);
      refs.writeRaw(ref, resolveTargetHash(refs, hash));
    },

    createAnnotatedTag(
      name: string,
      target: SHA1,
      message: string,
      tagger: GitAuthor,
      objectType?: ObjectType,
    ): SHA1 {
      const ref = tagNameToRef(name);
      ensureRefDoesNotExist(backend, ref, "Tag", name);

      const resolvedObjectType = objectType ?? objects.read(target).type;
      const tag: GitTag = {
        type: "tag",
        object: target,
        objectType: resolvedObjectType,
        tag: name,
        tagger,
        message,
      };
      const tagHash = objects.write(tag);
      refs.writeRaw(ref, tagHash);
      return tagHash;
    },

    readTag(name: string): SHA1 | null {
      return resolveRefHash(refs, tagNameToRef(name));
    },

    listTags(): string[] {
      return listShortRefs(backend, TAGS_PREFIX);
    },

    deleteTag(name: string): void {
      refs.deleteRaw(tagNameToRef(name));
    },

    writePack(hashes?: SHA1[]) {
      if (!packs) {
        throw new Error("Backend does not support packfile writes");
      }

      return packs.writeFromSource(objects, hashes ?? objects.list());
    },

    repack(options?: RepositoryRepackOptions) {
      if (!packs) {
        throw new Error("Backend does not support repack");
      }

      return packs.repack(objects, options);
    },

    listReachableObjects(): SHA1[] {
      return listReachableObjects(objects, refs);
    },

    gc(options?: RepositoryGCOptions) {
      if (!packs) {
        throw new Error("Backend does not support gc");
      }

      return packs.gc(listReachableObjects(objects, refs), options);
    },
  };
}
