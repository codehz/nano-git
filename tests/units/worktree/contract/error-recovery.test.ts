/**
 * VirtualWorktree 组合操作测试：异常恢复后状态
 *
 * 验证操作序列中部分操作失败后 diff 仍正确收敛。
 */
import { describe, expect, test } from "bun:test";

import { bytes, bytesToUtf8 } from "../../../helpers/bytes.ts";
import { virtualWorktreeBackends } from "./contract.ts";
import { readTree } from "./test-utils.ts";
import { createMemoryRepository } from "@/repository/memory.ts";

describe("VirtualWorktree contract: error recovery", () => {
  describe.each(virtualWorktreeBackends)("$name", ({ createWorktree }) => {
    test("构造事务回滚后 diff 仍正确收敛", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(bytes("base"));
      const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: fileHash }]);
      const session = createWorktree(repo, { baseTree });

      session.writeFile("g", bytes("new"));

      session.mkdir("parent");
      session.writeFile("parent/child.txt", bytes("child"));

      session.writeFile("h", bytes("extra"));

      expect(bytesToUtf8(session.readFile("f"))).toBe("base");
      expect(bytesToUtf8(session.readFile("g"))).toBe("new");
      expect(bytesToUtf8(session.readFile("h"))).toBe("extra");
      expect(bytesToUtf8(session.readFile("parent/child.txt"))).toBe("child");

      const rootHash = session.writeTree();
      const root = readTree(repo, rootHash);
      const names = root.entries.map((e) => e.name).sort();
      expect(names).toEqual(["f", "g", "h", "parent"]);
    });
  });
});
