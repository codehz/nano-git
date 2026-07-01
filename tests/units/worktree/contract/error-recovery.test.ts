/**
 * VirtualWorktree 组合操作测试：异常恢复后状态
 *
 * 验证操作序列中部分操作失败后 diff 仍正确收敛。
 */
import { describe, expect, test } from "bun:test";

import { virtualWorktreeBackends } from "./contract.ts";
import { readTree } from "./test-utils.ts";
import { createMemoryRepository } from "@/repository/memory.ts";

describe("VirtualWorktree contract: error recovery", () => {
  describe.each(virtualWorktreeBackends)("$name", ({ createWorktree }) => {
    test("构造事务回滚后 diff 仍正确收敛", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("base"));
      const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: fileHash }]);
      const session = createWorktree(repo, { baseTree });

      session.writeFile("g", Buffer.from("new"));

      session.mkdir("parent");
      session.writeFile("parent/child.txt", Buffer.from("child"));

      session.writeFile("h", Buffer.from("extra"));

      expect(session.readFile("f").toString()).toBe("base");
      expect(session.readFile("g").toString()).toBe("new");
      expect(session.readFile("h").toString()).toBe("extra");
      expect(session.readFile("parent/child.txt").toString()).toBe("child");

      const rootHash = session.writeTree();
      const root = readTree(repo, rootHash);
      const names = root.entries.map((e) => e.name).sort();
      expect(names).toEqual(["f", "g", "h", "parent"]);
    });
  });
});
