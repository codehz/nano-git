/**
 * SQLite VirtualWorktree 数据库管理器测试
 */
import { describe, test, expect } from "bun:test";

import { createMemoryRepository } from "@/repository/memory.ts";
import { openSqliteVirtualWorktreeDatabase } from "@/worktree/sqlite.ts";

describe("openSqliteVirtualWorktreeDatabase", () => {
  test("同一数据库可创建多个 worktree 并列举", () => {
    const repo = createMemoryRepository();
    const baseA = repo.createTree([]);
    const baseB = repo.createTree([]);

    using db = openSqliteVirtualWorktreeDatabase(":memory:");
    db.createWorktree("a", { baseTree: baseA });
    db.createWorktree("b", { baseTree: baseB });

    expect(db.listWorktreeKeys()).toEqual(["a", "b"]);
    expect(db.listWorktrees().map((entry) => entry.key)).toEqual(["a", "b"]);

    const worktreeA = db.openWorktree(repo.objects, "a", { baseTree: baseA });
    const worktreeB = db.openWorktree(repo.objects, "b", { baseTree: baseB });

    worktreeA.writeFile("only-a.txt", Buffer.from("a"));
    worktreeB.writeFile("only-b.txt", Buffer.from("b"));

    expect(worktreeA.exists("only-b.txt")).toBe(false);
    expect(worktreeB.exists("only-a.txt")).toBe(false);

    db.deleteWorktree("a");
    expect(db.listWorktreeKeys()).toEqual(["b"]);
    expect(db.hasWorktree("a")).toBe(false);
    expect(db.hasWorktree("b")).toBe(true);
  });

  test("重复 create 或打开不存在的 key 会失败", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);

    using db = openSqliteVirtualWorktreeDatabase(":memory:");
    db.createWorktree("demo", { baseTree });

    expect(() => db.createWorktree("demo", { baseTree })).toThrow(
      /Virtual worktree already exists/,
    );
    expect(() => db.openWorktree(repo.objects, "missing", { baseTree })).toThrow(
      /Virtual worktree not found/,
    );
    expect(() => db.deleteWorktree("missing")).toThrow(/Virtual worktree not found/);
  });

  test("可按前缀列举并批量清理 worktree", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);

    using db = openSqliteVirtualWorktreeDatabase(":memory:");
    db.createWorktree("sess/a", { baseTree });
    db.createWorktree("sess/b", { baseTree });
    db.createWorktree("other", { baseTree });

    expect(db.listWorktreeKeys("sess/")).toEqual(["sess/a", "sess/b"]);
    expect(db.listWorktrees("sess/").map((e) => e.key)).toEqual(["sess/a", "sess/b"]);
    expect(db.listWorktreeKeys()).toEqual(["other", "sess/a", "sess/b"]);

    expect(db.deleteWorktreesByPrefix("sess/")).toBe(2);
    expect(db.listWorktreeKeys()).toEqual(["other"]);
    expect(db.hasWorktree("sess/a")).toBe(false);
    expect(db.hasWorktree("other")).toBe(true);

    expect(db.deleteWorktreesByPrefix("missing/")).toBe(0);
  });
});
