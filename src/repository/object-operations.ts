/**
 * 仓库对象操作组装
 */

import { readFileSync } from "node:fs";

import { hashObject } from "../core/hash.ts";
import { createV2HttpTransport } from "../transport/client/git-transport.ts";
import { objectInfo } from "../transport/client/object-info.ts";
import {
  patchTree as patchTreeImpl,
  type TreePatchOp,
  type TreePatchResult,
} from "./tree-patch.ts";
import { writeTreeRecursive } from "./tree-writer.ts";

import type {
  GitAuthor,
  GitBlob,
  GitCommit,
  GitObject,
  GitTree,
  SHA1,
  TreeEntry,
} from "../core/types.ts";
import type { ObjectStore } from "../odb/types.ts";
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
export function createObjectRepositoryOperations(objects: ObjectStore): RepositoryObjectOperations {
  function writeBlob(data: Buffer): SHA1 {
    const blob: GitBlob = { type: "blob", content: data };
    return objects.write(blob);
  }

  return {
    hashObject(data: Buffer): SHA1 {
      return hashObject("blob", data);
    },

    writeBlob,

    writeBlobFile(filePath: string): SHA1 {
      return writeBlob(readFileSync(filePath));
    },

    catFile(hash: SHA1): GitObject {
      return objects.read(hash);
    },

    catFileType(hash: SHA1): string {
      return objects.read(hash).type;
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

    patchTree(rootHash: SHA1, ops: TreePatchOp[]): TreePatchResult {
      return patchTreeImpl(objects, rootHash, ops);
    },

    async fetchObjectInfo(
      url: string,
      oids: string[],
      token?: string,
    ): Promise<import("../transport/client/object-info.ts").ObjectInfoQueryResult> {
      const transport = createV2HttpTransport(url, { token });
      return objectInfo(transport, oids);
    },
  };
}
