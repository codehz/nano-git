/**
 * VirtualWorkdir 合同测试：状态收敛与基线恢复语义
 */
import { describe, expect, test } from "bun:test";

import { virtualWorkdirBackends } from "./contract.ts";
import { createMemoryRepository } from "@/repository/memory.ts";

describe("VirtualWorkdir contract: state", () => {
  describe.each(virtualWorkdirBackends)("$name", ({ createWorkdir }) => {
    test("restore 可恢复到基线内容", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("base"));
      const baseTree = repo.createTree([{ mode: "100644", name: "file.txt", hash: fileHash }]);
      const session = createWorkdir(repo, { baseTree });

      session.writeFile("file.txt", Buffer.from("edited"));
      session.restore("file.txt");

      expect(session.readFile("file.txt").toString()).toBe("base");
      expect(session.diff()).toEqual([]);
    });

    test("目录 restore 默认不递归恢复子树修改", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("base"));
      const dirTree = repo.createTree([{ mode: "100644", name: "nested.txt", hash: fileHash }]);
      const baseTree = repo.createTree([{ mode: "040000", name: "dir", hash: dirTree }]);
      const session = createWorkdir(repo, { baseTree });

      session.writeFile("dir/nested.txt", Buffer.from("edited"));
      session.restore("dir");

      expect(session.readFile("dir/nested.txt").toString()).toBe("edited");
    });

    test("重复 diff 结果稳定", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("base"));
      const baseTree = repo.createTree([{ mode: "100644", name: "file.txt", hash: fileHash }]);
      const session = createWorkdir(repo, { baseTree });

      session.writeFile("file.txt", Buffer.from("edited"));
      session.writeFile("fresh.txt", Buffer.from("new"));

      const diff1 = session.diff();
      const diff2 = session.diff();

      expect(diff2).toEqual(diff1);
    });

    test("reset 丢弃 overlay", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("after"));
      const nextTree = repo.createTree([{ mode: "100644", name: "after.txt", hash: fileHash }]);
      const session = createWorkdir(repo, { baseTree: repo.createTree([]) });

      session.writeFile("before.txt", Buffer.from("before"));
      session.reset(nextTree);

      expect(session.exists("before.txt")).toBe(false);
      expect(session.readFile("after.txt").toString()).toBe("after");
      expect(session.diff()).toEqual([]);
    });
  });
});
