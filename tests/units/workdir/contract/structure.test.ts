/**
 * VirtualWorkdir 合同测试：结构变更语义
 */
import { describe, expect, test } from "bun:test";

import { virtualWorkdirBackends } from "./contract.ts";
import {
  VirtualNotDirectoryError,
  VirtualPathAlreadyExistsError,
  VirtualPathNotFoundError,
} from "@/core/errors.ts";
import { createMemoryRepository } from "@/repository/memory.ts";

describe("VirtualWorkdir contract: structure", () => {
  describe.each(virtualWorkdirBackends)("$name", ({ createWorkdir }) => {
    test("删除路径后不可见", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("gone"));
      const session = createWorkdir(repo, {
        baseTree: repo.createTree([{ mode: "100644", name: "file.txt", hash: fileHash }]),
      });

      session.delete("file.txt");
      expect(session.exists("file.txt")).toBe(false);
      expect(() => session.readFile("file.txt")).toThrow(VirtualPathNotFoundError);
    });

    test("删除根路径时报错", () => {
      const repo = createMemoryRepository();
      const session = createWorkdir(repo, { baseTree: repo.createTree([]) });

      expect(() => session.delete("")).toThrow(/Path must not be empty/);
    });

    test("force 删除不存在路径时保持幂等", () => {
      const repo = createMemoryRepository();
      const session = createWorkdir(repo, { baseTree: repo.createTree([]) });

      expect(() => session.delete("missing", { force: true })).not.toThrow();
      session.writeFile("file.txt", Buffer.from("data"));
      session.delete("file.txt");
      expect(() => session.delete("file.txt", { force: true })).not.toThrow();
    });

    test("删除目录后同名写文件不会残留旧子路径", () => {
      const repo = createMemoryRepository();
      const session = createWorkdir(repo, { baseTree: repo.createTree([]) });

      session.mkdir("manuscript");
      session.writeFile("manuscript/a.md", Buffer.from("a"));
      session.delete("manuscript", { force: true });
      session.writeFile("manuscript", Buffer.from("file-now"));

      expect(session.stat("manuscript")).toMatchObject({ kind: "blob", mode: "100644", size: 8 });
      expect(session.diff()).toMatchObject([
        {
          kind: "create",
          path: "manuscript",
          current: { kind: "blob", mode: "100644" },
        },
      ]);
    });

    test("move 文件与目录保持可读", () => {
      const repo = createMemoryRepository();
      const session = createWorkdir(repo, { baseTree: repo.createTree([]) });

      session.mkdir("src");
      session.writeFile("src/main.ts", Buffer.from("code"));
      session.move("src/main.ts", "src/index.ts");
      session.move("src", "lib");

      expect(session.exists("src")).toBe(false);
      expect(session.readFile("lib/index.ts").toString()).toBe("code");
    });

    test("move 可自动创建目标父目录", () => {
      const repo = createMemoryRepository();
      const session = createWorkdir(repo, { baseTree: repo.createTree([]) });

      session.writeFile("a.txt", Buffer.from("nested"));
      session.move("a.txt", "other/deep/b.txt");

      expect(session.exists("a.txt")).toBe(false);
      expect(session.readFile("other/deep/b.txt").toString()).toBe("nested");
    });

    test("move 到文件父路径下时报 VirtualNotDirectoryError", () => {
      const repo = createMemoryRepository();
      const session = createWorkdir(repo, { baseTree: repo.createTree([]) });

      session.writeFile("from.txt", Buffer.from("data"));
      session.writeFile("target", Buffer.from("blocking parent"));

      expect(() => session.move("from.txt", "target/child.txt")).toThrow(VirtualNotDirectoryError);
    });

    test("move 目录到自身子目录时报错", () => {
      const repo = createMemoryRepository();
      const session = createWorkdir(repo, { baseTree: repo.createTree([]) });

      session.mkdir("src");
      session.writeFile("src/main.ts", Buffer.from("code"));

      expect(() => session.move("src", "src/nested")).toThrow(
        /destination is a subdirectory of source/,
      );
    });

    test("move 到已存在路径时报 VirtualPathAlreadyExistsError", () => {
      const repo = createMemoryRepository();
      const session = createWorkdir(repo, { baseTree: repo.createTree([]) });

      session.writeFile("a.txt", Buffer.from("a"));
      session.writeFile("b.txt", Buffer.from("b"));

      expect(() => session.move("a.txt", "b.txt")).toThrow(VirtualPathAlreadyExistsError);
    });

    test("copy 文件与目录后可独立修改", () => {
      const repo = createMemoryRepository();
      const session = createWorkdir(repo, { baseTree: repo.createTree([]) });

      session.mkdir("src");
      session.writeFile("src/main.ts", Buffer.from("v1"));
      session.copy("src", "src-copy");
      session.writeFile("src/main.ts", Buffer.from("v2"));

      expect(session.readFile("src/main.ts").toString()).toBe("v2");
      expect(session.readFile("src-copy/main.ts").toString()).toBe("v1");
    });

    test("copy 到文件父路径下时报 VirtualNotDirectoryError", () => {
      const repo = createMemoryRepository();
      const session = createWorkdir(repo, { baseTree: repo.createTree([]) });

      session.writeFile("from.txt", Buffer.from("data"));
      session.writeFile("target", Buffer.from("blocking parent"));

      expect(() => session.copy("from.txt", "target/child.txt")).toThrow(VirtualNotDirectoryError);
    });

    test("copy 目录到自身子目录时源和目标都可读", () => {
      const repo = createMemoryRepository();
      const session = createWorkdir(repo, { baseTree: repo.createTree([]) });

      session.mkdir("src");
      session.writeFile("src/main.ts", Buffer.from("code"));
      session.copy("src", "src/nested");

      expect(session.readFile("src/main.ts").toString()).toBe("code");
      expect(session.readFile("src/nested/main.ts").toString()).toBe("code");
    });

    test("copy 到已存在路径时报 VirtualPathAlreadyExistsError", () => {
      const repo = createMemoryRepository();
      const session = createWorkdir(repo, { baseTree: repo.createTree([]) });

      session.writeFile("a.txt", Buffer.from("a"));
      session.writeFile("b.txt", Buffer.from("b"));

      expect(() => session.copy("a.txt", "b.txt")).toThrow(VirtualPathAlreadyExistsError);
    });
  });
});
