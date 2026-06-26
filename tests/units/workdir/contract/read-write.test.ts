/**
 * VirtualWorkdir 合同测试：读取与基础写入语义
 */
import { describe, expect, test } from "bun:test";

import { virtualWorkdirBackends } from "./contract.ts";
import { VirtualOriginUnavailableError } from "@/core/errors.ts";
import { createMemoryRepository } from "@/repository/memory.ts";

describe("VirtualWorkdir contract: read/write", () => {
  describe.each(virtualWorkdirBackends)("$name", ({ createWorkdir }) => {
    test("从空 tree 打开并写入文件/目录/符号链接", () => {
      const repo = createMemoryRepository();
      const session = createWorkdir(repo, { baseTree: repo.createTree([]) });

      expect(session.readdir()).toEqual([]);
      session.mkdir("dir");
      session.writeFile("dir/file.txt", Buffer.from("hello"));
      session.writeLink("link", "target");

      expect(session.readFile("dir/file.txt").toString()).toBe("hello");
      expect(session.readLink("link")).toBe("target");
      expect(session.readdir().map((entry) => entry.name)).toEqual(["dir", "link"]);
    });

    test("从非空 tree 打开并读取 repo-backed 文件、目录、符号链接", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("hello"));
      const linkHash = repo.writeBlob(Buffer.from("target"));
      const dirHash = repo.createTree([{ mode: "100644", name: "nested.txt", hash: fileHash }]);
      const baseTree = repo.createTree([
        { mode: "100644", name: "file.txt", hash: fileHash },
        { mode: "040000", name: "dir", hash: dirHash },
        { mode: "120000", name: "link", hash: linkHash },
      ]);
      const session = createWorkdir(repo, { baseTree });

      expect(session.readFile("file.txt").toString()).toBe("hello");
      expect(session.readFile("dir/nested.txt").toString()).toBe("hello");
      expect(session.readLink("link")).toBe("target");
    });

    test("origin 缺失时报 VirtualOriginUnavailableError", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("gone"));
      const session = createWorkdir(repo, {
        baseTree: repo.createTree([{ mode: "100644", name: "file.txt", hash: fileHash }]),
      });

      repo.objects.delete(fileHash);
      expect(() => session.readFile("file.txt")).toThrow(VirtualOriginUnavailableError);
    });
  });
});
