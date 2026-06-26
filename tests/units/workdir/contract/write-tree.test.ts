/**
 * VirtualWorkdir 合同测试：writeTree 持久化语义
 */
import { describe, expect, test } from "bun:test";

import { virtualWorkdirBackends } from "./contract.ts";
import { createMemoryRepository } from "@/repository/memory.ts";

import type { SHA1 } from "@/core/types.ts";

describe("VirtualWorkdir contract: writeTree", () => {
  describe.each(virtualWorkdirBackends)("$name", ({ createWorkdir }) => {
    test("重复 writeTree 结果稳定", () => {
      const repo = createMemoryRepository();
      const session = createWorkdir(repo, { baseTree: repo.createTree([]) });

      session.writeFile("file.txt", Buffer.from("stable"));
      const hash1 = session.writeTree();
      const hash2 = session.writeTree();

      expect(hash1).toBe(hash2);
    });

    test("writeTree 后可被新 workdir 重新打开", () => {
      const repo = createMemoryRepository();
      const session = createWorkdir(repo, { baseTree: repo.createTree([]) });

      session.writeFile("a.txt", Buffer.from("alpha"));
      session.mkdir("dir");
      session.writeFile("dir/b.txt", Buffer.from("beta"));

      const tree = session.writeTree();
      const reopened = createWorkdir(repo, { baseTree: tree as SHA1 });

      expect(reopened.readFile("a.txt").toString()).toBe("alpha");
      expect(reopened.readFile("dir/b.txt").toString()).toBe("beta");
    });
  });
});
