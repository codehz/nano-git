/**
 * VirtualWorktree 组合操作测试：reset 到新基线后操作正确性
 *
 * 验证 reset 到新基线后写入、restore、diff 等操作的正确行为。
 */
import { describe, expect, test } from "bun:test";

import { bytes, bytesToUtf8 } from "../../../helpers/bytes.ts";
import { virtualWorktreeBackends } from "./contract.ts";
import { readTree } from "./test-utils.ts";
import { createMemoryRepository } from "@/repository/memory.ts";

describe("VirtualWorktree contract: reset", () => {
  describe.each(virtualWorktreeBackends)("$name", ({ createWorktree }) => {
    test("reset 到新基线后写入并 restore 正确", () => {
      const repo = createMemoryRepository();
      const fileHashA = repo.writeBlob(bytes("aaa"));
      const fileHashB = repo.writeBlob(bytes("bbb"));
      const treeA = repo.createTree([{ mode: "100644", name: "a.txt", hash: fileHashA }]);
      const treeB = repo.createTree([{ mode: "100644", name: "b.txt", hash: fileHashB }]);
      const session = createWorktree(repo, { baseTree: treeA });

      session.writeFile("extra.txt", bytes("extra"));
      session.reset(treeB);

      expect(session.exists("a.txt")).toBe(false);
      expect(bytesToUtf8(session.readFile("b.txt"))).toBe("bbb");
      expect(session.diff()).toEqual([]);

      session.writeFile("c.txt", bytes("ccc"));
      expect(bytesToUtf8(session.readFile("c.txt"))).toBe("ccc");

      const rootHash = session.writeTree();
      const root = readTree(repo, rootHash);
      const names = root.entries.map((e) => e.name).sort();
      expect(names).toEqual(["b.txt", "c.txt"]);
    });
  });
});
