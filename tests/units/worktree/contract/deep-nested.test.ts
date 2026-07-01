/**
 * VirtualWorktree 组合操作测试：深层嵌套操作
 *
 * 验证深层嵌套目录中 move/copy 后子树操作的正确性，
 * 以及 move 后源与目标子树互不干扰。
 */
import { describe, expect, test } from "bun:test";

import { virtualWorktreeBackends } from "./contract.ts";
import { readTree } from "./test-utils.ts";
import { VirtualPathNotFoundError } from "@/errors.ts";
import { createMemoryRepository } from "@/repository/memory.ts";

describe("VirtualWorktree contract: deep nested", () => {
  describe.each(virtualWorktreeBackends)("$name", ({ createWorktree }) => {
    test("深层嵌套目录中 move 后子树操作正确", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.mkdir("a/b/c/d", { recursive: true });
      session.writeFile("a/b/c/d/target.txt", Buffer.from("deep"));
      session.move("a/b", "x/y");

      expect(session.readFile("x/y/c/d/target.txt").toString()).toBe("deep");
      expect(() => session.readFile("a/b/c/d/target.txt")).toThrow(VirtualPathNotFoundError);
      expect(session.exists("a")).toBe(true);
      expect(session.readdir("a")).toEqual([]);

      session.writeFile("a/new.txt", Buffer.from("new-root"));
      expect(session.readFile("a/new.txt").toString()).toBe("new-root");

      const rootHash = session.writeTree();
      const root = readTree(repo, rootHash);
      const names = root.entries.map((e) => e.name).sort();
      expect(names).toEqual(["a", "x"]);
    });

    test("深层嵌套目录中 copy 后源与目标子树互不干扰", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.mkdir("a/b/c", { recursive: true });
      session.writeFile("a/b/c/file.txt", Buffer.from("original"));
      session.copy("a", "copy");

      session.writeFile("a/b/c/file.txt", Buffer.from("source-edit"));
      session.writeFile("copy/b/c/file.txt", Buffer.from("copy-edit"));

      expect(session.readFile("a/b/c/file.txt").toString()).toBe("source-edit");
      expect(session.readFile("copy/b/c/file.txt").toString()).toBe("copy-edit");

      session.writeFile("copy/b/c/extra.txt", Buffer.from("extra"));
      expect(session.readFile("copy/b/c/extra.txt").toString()).toBe("extra");
      expect(() => session.readFile("a/b/c/extra.txt")).toThrow(VirtualPathNotFoundError);
    });
  });
});
