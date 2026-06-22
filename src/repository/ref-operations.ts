/**
 * 仓库引用操作组装
 */

import { RepositoryError } from "../core/errors.ts";
import {
  branchNameToRef,
  HEAD_REF,
  HEADS_PREFIX,
  resolveRefHash,
  resolveSymbolicRef,
  resolveTargetHash,
  tagNameToRef,
  TAGS_PREFIX,
} from "../refs/index.ts";

import type { SHA1, GitAuthor, ObjectType, GitTag } from "../core/types.ts";
import type { RepositoryBackend } from "./backend/index.ts";
import type { RepositoryRefOperations } from "./ref-types.ts";

function ensureRefDoesNotExist(
  backend: RepositoryBackend,
  ref: string,
  kind: "Branch" | "Tag",
  name: string,
): void {
  if (backend.refs.read(ref) !== null) {
    throw new RepositoryError(`${kind} already exists: ${name}`);
  }
}

function listShortRefs(backend: RepositoryBackend, prefix: string): string[] {
  return backend.refs.list(prefix).map((ref) => ref.slice(prefix.length));
}

/**
 * 创建仓库引用相关操作
 *
 * @example
 * ```ts
 * const ops = createRefRepositoryOperations(backend);
 * ops.createBranch("main");
 * ```
 */
export function createRefRepositoryOperations(backend: RepositoryBackend): RepositoryRefOperations {
  const { objects, refs } = backend;

  function getCurrentBranch(): string | null {
    const symbolicRef = resolveSymbolicRef(refs, HEAD_REF);
    if (!symbolicRef || !symbolicRef.startsWith(HEADS_PREFIX)) {
      return null;
    }

    return symbolicRef.slice(HEADS_PREFIX.length);
  }

  return {
    updateRef(ref: string, hash: SHA1): void {
      refs.write(ref, hash);
    },

    readRef(ref: string): SHA1 | null {
      return resolveRefHash(refs, ref);
    },

    getCurrentBranch,

    createBranch(name: string, hash?: SHA1): void {
      const ref = branchNameToRef(name);
      ensureRefDoesNotExist(backend, ref, "Branch", name);
      refs.write(ref, resolveTargetHash(refs, hash));
    },

    readBranch(name: string): SHA1 | null {
      return resolveRefHash(refs, branchNameToRef(name));
    },

    listBranches(): string[] {
      return listShortRefs(backend, HEADS_PREFIX);
    },

    deleteBranch(name: string): void {
      if (getCurrentBranch() === name) {
        throw new RepositoryError(`Cannot delete current branch: ${name}`);
      }

      refs.delete(branchNameToRef(name));
    },

    createTag(name: string, hash?: SHA1): void {
      const ref = tagNameToRef(name);
      ensureRefDoesNotExist(backend, ref, "Tag", name);
      refs.write(ref, resolveTargetHash(refs, hash));
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
      refs.write(ref, tagHash);
      return tagHash;
    },

    readTag(name: string): SHA1 | null {
      return resolveRefHash(refs, tagNameToRef(name));
    },

    listTags(): string[] {
      return listShortRefs(backend, TAGS_PREFIX);
    },

    deleteTag(name: string): void {
      refs.delete(tagNameToRef(name));
    },
  };
}
