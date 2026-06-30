/**
 * worktree/origin.ts 单元测试
 */
import { describe, test, expect } from "bun:test";

import { VirtualOriginUnavailableError } from "@/core/errors.ts";
import { sha1 } from "@/core/types.ts";
import { createMemoryObjectStore } from "@/odb/memory.ts";
import {
  readRepoBlobContent,
  readRepoTree,
  treeEntryToNodeOrigin,
} from "@/worktree/model/origin.ts";

describe("readRepoTree / readRepoBlobContent", () => {
  test("缺失对象抛 VirtualOriginUnavailableError", () => {
    const odb = createMemoryObjectStore();
    const missing = sha1("0000000000000000000000000000000000000000");
    expect(() => readRepoTree(odb, missing, "p")).toThrow(VirtualOriginUnavailableError);
    expect(() => readRepoBlobContent(odb, missing, "p")).toThrow(VirtualOriginUnavailableError);
  });

  test("treeEntryToNodeOrigin 区分目录与 blob", () => {
    const h = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
    expect(treeEntryToNodeOrigin({ mode: "040000", name: "d", hash: h })).toEqual({
      kind: "repo-tree",
      hash: h,
    });
    expect(treeEntryToNodeOrigin({ mode: "100644", name: "f", hash: h })).toEqual({
      kind: "repo-blob",
      mode: "100644",
      hash: h,
    });
  });
});
