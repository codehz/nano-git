/**
 * VirtualWorktree 组合操作测试：同路径反复操作
 *
 * 验证同路径反复 writeFile → delete / mkdir → delete 后
 * change records 不膨胀且最终状态正确。
 */
import { describe, expect, test } from "bun:test";

import { virtualWorktreeBackends } from "./contract.ts";
import { readBlob, readTree } from "./test-utils.ts";
import { createMemoryRepository } from "@/repository/memory.ts";

describe("VirtualWorktree contract: repeated path", () => {
  describe.each(virtualWorktreeBackends)("$name", ({ createWorktree }) => {
    test("同路径反复 writeFile → delete → writeFile 多次后 change records 不膨胀", () => {
      const repo = createMemoryRepository();
      const baseTree = repo.createTree([]);
      const session = createWorktree(repo, { baseTree });

      for (let i = 0; i < 10; i++) {
        session.writeFile("f.txt", Buffer.from(`v${i}`));
        session.delete("f.txt");
      }
      session.writeFile("f.txt", Buffer.from("final"));

      expect(session.diff()).toHaveLength(1);
      expect(session.diff()[0]).toMatchObject({
        kind: "create",
        path: "f.txt",
      });

      const rootHash = session.writeTree();
      const root = readTree(repo, rootHash);
      expect(root.entries).toHaveLength(1);
      expect(readBlob(repo, root.entries[0]!.hash).toString()).toBe("final");
    });

    test("同路径反复 mkdir → delete → mkdir 三次不报错", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      for (let i = 0; i < 3; i++) {
        session.mkdir("d");
        session.writeFile("d/f.txt", Buffer.from(`v${i}`));
        session.delete("d");
      }
      session.mkdir("d");
      session.writeFile("d/f.txt", Buffer.from("v3"));

      expect(session.readFile("d/f.txt").toString()).toBe("v3");
    });
  });
});
