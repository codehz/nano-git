/**
 * VirtualWorktree 组合操作测试：深层嵌套操作
 *
 * 验证深层嵌套目录中 move/copy 后子树操作的正确性，
 * 以及 move 后源与目标子树互不干扰。
 */
import { describe, expect, test } from "bun:test";

import { bytes, bytesToUtf8 } from "../../../helpers/bytes.ts";
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
      session.writeFile("a/b/c/d/target.txt", bytes("deep"));
      session.move("a/b", "x/y");

      expect(bytesToUtf8(session.readFile("x/y/c/d/target.txt"))).toBe("deep");
      expect(() => session.readFile("a/b/c/d/target.txt")).toThrow(VirtualPathNotFoundError);
      expect(session.exists("a")).toBe(true);
      expect(session.readdir("a")).toEqual([]);

      session.writeFile("a/new.txt", bytes("new-root"));
      expect(bytesToUtf8(session.readFile("a/new.txt"))).toBe("new-root");

      const rootHash = session.writeTree();
      const root = readTree(repo, rootHash);
      const names = root.entries.map((e) => e.name).sort();
      expect(names).toEqual(["a", "x"]);
    });

    test("深层嵌套目录中 copy 后源与目标子树互不干扰", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.mkdir("a/b/c", { recursive: true });
      session.writeFile("a/b/c/file.txt", bytes("original"));
      session.copy("a", "copy");

      session.writeFile("a/b/c/file.txt", bytes("source-edit"));
      session.writeFile("copy/b/c/file.txt", bytes("copy-edit"));

      expect(bytesToUtf8(session.readFile("a/b/c/file.txt"))).toBe("source-edit");
      expect(bytesToUtf8(session.readFile("copy/b/c/file.txt"))).toBe("copy-edit");

      session.writeFile("copy/b/c/extra.txt", bytes("extra"));
      expect(bytesToUtf8(session.readFile("copy/b/c/extra.txt"))).toBe("extra");
      expect(() => session.readFile("a/b/c/extra.txt")).toThrow(VirtualPathNotFoundError);
    });
  });
});
