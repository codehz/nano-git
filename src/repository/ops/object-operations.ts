/**
 * 仓库对象操作组装
 */

import { hashObject } from "../../core/hash.ts";
import { writeObject, readObject } from "../../objects/raw.ts";
import {
  patchTree as patchTreeImpl,
  type TreePatchOp,
  type TreePatchResult,
} from "../tree/tree-patch.ts";

import type {
  GitAuthor,
  GitBlob,
  GitCommit,
  GitTree,
  GitObject,
  SHA1,
  TreeEntry,
} from "../../core/types.ts";
import type { ObjectDatabase } from "../../odb/types.ts";
import type { RepositoryObjectOperations } from "./object-types.ts";

/**
 * 创建仓库对象相关操作
 *
 * @example
 * ```ts
 * const ops = createObjectRepositoryOperations(store);
 * const hash = ops.writeBlob(Buffer.from("hello"));
 * ```
 */
export function createObjectRepositoryOperations(
  objects: ObjectDatabase,
): RepositoryObjectOperations {
  function writeBlob(data: Buffer): SHA1 {
    const blob: GitBlob = { type: "blob", content: data };
    return writeObject(objects, blob);
  }

  return {
    hashObject(data: Buffer): SHA1 {
      return hashObject("blob", data);
    },

    writeBlob,

    catFile(hash: SHA1): GitObject {
      return readObject(objects, hash);
    },

    catFileType(hash: SHA1): string {
      return readObject(objects, hash).type;
    },

    listObjects(): SHA1[] {
      return objects.list();
    },

    createTree(entries: TreeEntry[]): SHA1 {
      const tree: GitTree = { type: "tree", entries };
      return writeObject(objects, tree);
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
      return writeObject(objects, commit);
    },

    patchTree(rootHash: SHA1, ops: TreePatchOp[]): TreePatchResult {
      return patchTreeImpl(objects, rootHash, ops);
    },
  };
}
