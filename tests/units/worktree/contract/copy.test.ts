/**
 * VirtualWorktree 组合操作测试：copy 后独立修改与对称性
 *
 * 验证 copy 操作后源与目标子树各自修改的隔离性，
 * 以及同一个目录多次 copy 后所有副本彼此独立。
 */
import { describe, expect, test } from "bun:test";

import { virtualWorktreeBackends } from "./contract.ts";
import { readBlob, readTree } from "./test-utils.ts";
import { VirtualPathNotFoundError } from "@/errors.ts";
import { createMemoryRepository } from "@/repository/memory.ts";

describe("VirtualWorktree contract: copy", () => {
  describe.each(virtualWorktreeBackends)("$name", ({ createWorktree }) => {
    test("copy 子树后删除源子树中文件，目标不受影响且 writeTree 正确", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.mkdir("src");
      session.writeFile("src/a.txt", Buffer.from("a"));
      session.writeFile("src/b.txt", Buffer.from("b"));
      session.copy("src", "copy");

      session.delete("src/a.txt");

      expect(session.readFile("copy/a.txt").toString()).toBe("a");
      expect(() => session.readFile("src/a.txt")).toThrow(VirtualPathNotFoundError);
      expect(session.readFile("src/b.txt").toString()).toBe("b");

      const rootHash = session.writeTree();
      const root = readTree(repo, rootHash);
      const src = readTree(repo, root.entries.find((e) => e.name === "src")!.hash);
      const copy = readTree(repo, root.entries.find((e) => e.name === "copy")!.hash);
      expect(src.entries.map((e) => e.name)).toEqual(["b.txt"]);
      expect(copy.entries.map((e) => e.name).sort()).toEqual(["a.txt", "b.txt"]);
    });

    test("copy 子树后在源和目标中分别修改同名文件，writeTree 独立导出", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.mkdir("shared");
      session.writeFile("shared/file.txt", Buffer.from("original"));
      session.copy("shared", "fork");

      session.writeFile("shared/file.txt", Buffer.from("source-edit"));
      session.writeFile("fork/file.txt", Buffer.from("fork-edit"));

      expect(session.readFile("shared/file.txt").toString()).toBe("source-edit");
      expect(session.readFile("fork/file.txt").toString()).toBe("fork-edit");

      const rootHash = session.writeTree();
      const root = readTree(repo, rootHash);
      const shared = readTree(repo, root.entries.find((e) => e.name === "shared")!.hash);
      const fork = readTree(repo, root.entries.find((e) => e.name === "fork")!.hash);
      expect(
        readBlob(repo, shared.entries.find((e) => e.name === "file.txt")!.hash).toString(),
      ).toBe("source-edit");
      expect(readBlob(repo, fork.entries.find((e) => e.name === "file.txt")!.hash).toString()).toBe(
        "fork-edit",
      );
    });

    test("copy 子树后在源子树中新增文件，目标不含新增文件", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.mkdir("base");
      session.writeFile("base/a.txt", Buffer.from("a"));
      session.copy("base", "derived");

      session.writeFile("base/b.txt", Buffer.from("b"));

      expect(session.readFile("base/a.txt").toString()).toBe("a");
      expect(session.readFile("base/b.txt").toString()).toBe("b");
      expect(session.readFile("derived/a.txt").toString()).toBe("a");
      expect(() => session.readFile("derived/b.txt")).toThrow(VirtualPathNotFoundError);
    });

    test("同一个目录多次 copy 后所有副本彼此独立", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.mkdir("data");
      session.writeFile("data/file.txt", Buffer.from("common"));
      session.copy("data", "copy1");
      session.copy("data", "copy2");
      session.copy("data", "copy3");

      session.writeFile("data/file.txt", Buffer.from("original"));
      session.writeFile("copy1/file.txt", Buffer.from("one"));
      session.delete("copy2/file.txt");
      session.writeFile("copy3/file.txt", Buffer.from("three"));

      expect(session.readFile("data/file.txt").toString()).toBe("original");
      expect(session.readFile("copy1/file.txt").toString()).toBe("one");
      expect(() => session.readFile("copy2/file.txt")).toThrow(VirtualPathNotFoundError);
      expect(session.readFile("copy3/file.txt").toString()).toBe("three");

      const rootHash = session.writeTree();
      const root = readTree(repo, rootHash);
      expect(root.entries).toHaveLength(4);
      const data = readTree(repo, root.entries.find((e) => e.name === "data")!.hash);
      const copy1 = readTree(repo, root.entries.find((e) => e.name === "copy1")!.hash);
      const copy2 = readTree(repo, root.entries.find((e) => e.name === "copy2")!.hash);
      const copy3 = readTree(repo, root.entries.find((e) => e.name === "copy3")!.hash);
      expect(readBlob(repo, data.entries[0]!.hash).toString()).toBe("original");
      expect(readBlob(repo, copy1.entries[0]!.hash).toString()).toBe("one");
      expect(copy2.entries).toHaveLength(0);
      expect(readBlob(repo, copy3.entries[0]!.hash).toString()).toBe("three");
    });
  });
});
