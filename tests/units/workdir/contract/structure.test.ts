/**
 * VirtualWorkdir 合同测试：结构变更语义
 */
import { describe, expect, test } from "bun:test";

import { virtualWorkdirBackends } from "./contract.ts";
import { VirtualPathNotFoundError } from "@/core/errors.ts";
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
  });
});
