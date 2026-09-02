/**
 * VirtualWorktree 组合操作测试：move 操作深度验证
 *
 * 覆盖 move 后源路径回收、目标路径冲突、深层目录 move、符号链接 move、
 * 以及 move 与 writeTree/restore 交织的场景。
 */
import { describe, expect, test } from "bun:test";

import { bytes, bytesToUtf8 } from "../../../helpers/bytes.ts";
import { virtualWorktreeBackends } from "./contract.ts";
import { readBlob, readTree } from "./test-utils.ts";
import {
  VirtualNotDirectoryError,
  VirtualPathAlreadyExistsError,
  VirtualPathNotFoundError,
} from "@/errors.ts";
import { createMemoryRepository } from "@/repository/memory.ts";

describe("VirtualWorktree contract: move", () => {
  describe.each(virtualWorktreeBackends)("$name", ({ createWorktree }) => {
    // ==================== move + 源路径回收 ====================

    test("move 文件后，源路径创建同名目录，源与目标互不干扰", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.writeFile("a.txt", bytes("data"));
      session.move("a.txt", "b.txt");

      session.mkdir("a.txt");
      session.writeFile("a.txt/c.txt", bytes("under-a"));

      expect(bytesToUtf8(session.readFile("b.txt"))).toBe("data");
      expect(bytesToUtf8(session.readFile("a.txt/c.txt"))).toBe("under-a");

      const rootHash = session.writeTree();
      const root = readTree(repo, rootHash);
      const names = root.entries.map((e) => e.name).sort();
      expect(names).toEqual(["a.txt", "b.txt"]);
      const aEntry = root.entries.find((e) => e.name === "a.txt")!;
      expect(aEntry.mode).toBe("040000");
      const bEntry = root.entries.find((e) => e.name === "b.txt")!;
      expect(bEntry.mode).toBe("100644");
    });

    test("move 目录后，源路径创建文件，writeTree 正确", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.mkdir("dir");
      session.writeFile("dir/a.txt", bytes("deep"));
      session.move("dir", "moved");

      session.writeFile("dir", bytes("shallow"));

      expect(bytesToUtf8(session.readFile("moved/a.txt"))).toBe("deep");
      expect(bytesToUtf8(session.readFile("dir"))).toBe("shallow");

      const rootHash = session.writeTree();
      const root = readTree(repo, rootHash);
      const names = root.entries.map((e) => e.name).sort();
      expect(names).toEqual(["dir", "moved"]);
    });

    test("move 文件到深层路径，源路径被重复利用为深层目录", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.writeFile("a.txt", bytes("moved"));
      session.move("a.txt", "deep/nested/b.txt");

      session.mkdir("a.txt");
      session.writeFile("a.txt/c.txt", bytes("child"));

      expect(bytesToUtf8(session.readFile("deep/nested/b.txt"))).toBe("moved");
      expect(bytesToUtf8(session.readFile("a.txt/c.txt"))).toBe("child");

      const rootHash = session.writeTree();
      const root = readTree(repo, rootHash);
      const names = root.entries.map((e) => e.name).sort();
      expect(names).toEqual(["a.txt", "deep"]);
    });

    // ==================== move 操作深度验证 ====================

    test("move 到已存在的目录下（作为子项）", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.mkdir("src");
      session.mkdir("dst");
      session.writeFile("src/f.txt", bytes("data"));
      session.move("src/f.txt", "dst/f.txt");

      expect(bytesToUtf8(session.readFile("dst/f.txt"))).toBe("data");
      expect(() => session.readFile("src/f.txt")).toThrow(VirtualPathNotFoundError);
    });

    test("move 到已存在的目录路径下，不覆盖目标目录自身", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.mkdir("src");
      session.writeFile("src/f.txt", bytes("data"));
      session.mkdir("dst");
      session.writeFile("dst/g.txt", bytes("existing"));
      session.move("src/f.txt", "dst/f.txt");

      expect(bytesToUtf8(session.readFile("dst/f.txt"))).toBe("data");
      expect(bytesToUtf8(session.readFile("dst/g.txt"))).toBe("existing");
    });

    test("move 目录到已存在目录下，子树完全保留", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.mkdir("src");
      session.writeFile("src/a.txt", bytes("a"));
      session.writeFile("src/b.txt", bytes("b"));
      session.mkdir("dst");
      session.writeFile("dst/c.txt", bytes("c"));
      session.move("src", "dst/src");

      expect(bytesToUtf8(session.readFile("dst/src/a.txt"))).toBe("a");
      expect(bytesToUtf8(session.readFile("dst/src/b.txt"))).toBe("b");
      expect(bytesToUtf8(session.readFile("dst/c.txt"))).toBe("c");
      expect(session.exists("src")).toBe(false);

      const rootHash = session.writeTree();
      const root = readTree(repo, rootHash);
      expect(root.entries.map((e) => e.name)).toEqual(["dst"]);
    });

    test("连续链条 move: a→b→c→d 后 writeTree 稳定", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.writeFile("a.txt", bytes("data"));
      session.move("a.txt", "b.txt");
      session.move("b.txt", "c.txt");
      session.move("c.txt", "d.txt");

      expect(session.exists("a.txt")).toBe(false);
      expect(session.exists("b.txt")).toBe(false);
      expect(session.exists("c.txt")).toBe(false);
      expect(bytesToUtf8(session.readFile("d.txt"))).toBe("data");
      expect(session.diff()).toHaveLength(1);
      expect(session.diff()[0]).toMatchObject({
        kind: "create",
        path: "d.txt",
      });

      const h1 = session.writeTree();
      const h2 = session.writeTree();
      expect(h1).toBe(h2);
    });

    test("move 基线文件后修改，再 move 回来，diff 正确收敛", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(bytes("base"));
      const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: fileHash }]);
      const session = createWorktree(repo, { baseTree });

      session.move("f", "g");
      session.writeFile("g", bytes("edited"));
      session.move("g", "f");

      expect(bytesToUtf8(session.readFile("f"))).toBe("edited");
      expect(session.diff()).toMatchObject([
        {
          kind: "update",
          path: "f",
          changes: { contentChanged: true },
        },
      ]);

      const rootHash = session.writeTree();
      const entry = readTree(repo, rootHash).entries.find((e) => e.name === "f")!;
      expect(bytesToUtf8(readBlob(repo, entry.hash))).toBe("edited");
    });

    test("move 基线文件后删除目标，再在源路径写入不同种类", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(bytes("base"));
      const baseTree = repo.createTree([{ mode: "100644", name: "a.txt", hash: fileHash }]);
      const session = createWorktree(repo, { baseTree });

      session.move("a.txt", "b.txt");
      session.delete("b.txt");
      session.mkdir("a.txt");
      session.writeFile("a.txt/child.txt", bytes("child"));

      expect(bytesToUtf8(session.readFile("a.txt/child.txt"))).toBe("child");
      expect(session.exists("b.txt")).toBe(false);
      expect(session.exists("a.txt")).toBe(true);

      const rootHash = session.writeTree();
      const root = readTree(repo, rootHash);
      const aEntry = root.entries.find((e) => e.name === "a.txt")!;
      expect(aEntry.mode).toBe("040000");
    });

    test("move 到已删除的基线文件路径时，diff 收敛为 remove + update", () => {
      const repo = createMemoryRepository();
      const aHash = repo.writeBlob(bytes("A"));
      const bHash = repo.writeBlob(bytes("B"));
      const baseTree = repo.createTree([
        { mode: "100644", name: "a.txt", hash: aHash },
        { mode: "100644", name: "b.txt", hash: bHash },
      ]);
      const session = createWorktree(repo, { baseTree });

      session.delete("b.txt");
      session.move("a.txt", "b.txt");

      expect(session.exists("a.txt")).toBe(false);
      expect(bytesToUtf8(session.readFile("b.txt"))).toBe("A");

      const diff = session.diff();
      expect(diff).toHaveLength(2);
      expect(diff.find((entry) => entry.path === "a.txt")).toMatchObject({
        kind: "remove",
        path: "a.txt",
        previous: { kind: "blob", mode: "100644" },
      });
      expect(diff.find((entry) => entry.path === "b.txt")).toMatchObject({
        kind: "update",
        path: "b.txt",
        current: { kind: "blob", mode: "100644" },
        changes: { contentChanged: true, kindChanged: false, modeChanged: false },
      });
    });

    test("move 到已删除的基线目录路径时，diff 标记 kindChanged 并移除旧子项", () => {
      const repo = createMemoryRepository();
      const movedHash = repo.writeBlob(bytes("moved"));
      const oldChildHash = repo.writeBlob(bytes("old-child"));
      const dstTree = repo.createTree([{ mode: "100644", name: "q.txt", hash: oldChildHash }]);
      const baseTree = repo.createTree([
        { mode: "100644", name: "a.txt", hash: movedHash },
        { mode: "040000", name: "dst", hash: dstTree },
      ]);
      const session = createWorktree(repo, { baseTree });

      session.delete("dst");
      session.move("a.txt", "dst");

      expect(bytesToUtf8(session.readFile("dst"))).toBe("moved");
      expect(() => session.readFile("dst/q.txt")).toThrow(VirtualPathNotFoundError);

      const diff = session.diff();
      expect(diff.find((entry) => entry.path === "a.txt")).toMatchObject({
        kind: "remove",
        path: "a.txt",
      });
      expect(diff.find((entry) => entry.path === "dst")).toMatchObject({
        kind: "update",
        path: "dst",
        current: { kind: "blob", mode: "100644" },
        changes: { kindChanged: true, modeChanged: true, contentChanged: true },
      });
      expect(diff.find((entry) => entry.path === "dst/q.txt")).toMatchObject({
        kind: "remove",
        path: "dst/q.txt",
        previous: { kind: "blob", mode: "100644" },
      });
    });

    test("move 符号链接后读写一致", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.writeLink("link", "target/path");
      session.move("link", "moved-link");

      expect(session.readLink("moved-link")).toBe("target/path");
      expect(session.stat("moved-link")).toMatchObject({ kind: "symlink", mode: "120000" });
      expect(session.exists("link")).toBe(false);
    });

    test("move 符号链接后修改目标再写回源路径", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.writeLink("link", "old");
      session.move("link", "moved");
      session.writeLink("moved", "new-target");
      session.writeFile("link", bytes("now-file"));

      expect(session.readLink("moved")).toBe("new-target");
      expect(bytesToUtf8(session.readFile("link"))).toBe("now-file");
      expect(session.stat("link")).toMatchObject({ kind: "blob", mode: "100644" });
    });

    test("move 目录后 restore 源路径，互不干扰", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(bytes("base-content"));
      const dirTree = repo.createTree([{ mode: "100644", name: "n.txt", hash: fileHash }]);
      const baseTree = repo.createTree([{ mode: "040000", name: "src", hash: dirTree }]);
      const session = createWorktree(repo, { baseTree });

      session.writeFile("src/n.txt", bytes("modified"));
      session.move("src", "dst");

      session.restore("src", { force: true });

      expect(bytesToUtf8(session.readFile("src/n.txt"))).toBe("base-content");
      expect(bytesToUtf8(session.readFile("dst/n.txt"))).toBe("modified");
    });

    test("move 包含多层嵌套的目录后 diff 不出现残留路径", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.mkdir("a/b/c", { recursive: true });
      session.writeFile("a/b/c/1.txt", bytes("1"));
      session.writeFile("a/b/2.txt", bytes("2"));
      session.writeFile("a/3.txt", bytes("3"));

      session.move("a", "x");

      const diff = session.diff();
      expect(diff.some((entry) => entry.path.startsWith("a/"))).toBe(false);
      expect(diff.filter((entry) => entry.path.startsWith("x"))).toHaveLength(6);
      expect(diff.filter((entry) => entry.kind === "create")).toHaveLength(6);
    });

    test("move 失败后事务回滚，不残留自动创建的目标父目录", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.writeFile("src.txt", bytes("data"));
      session.writeFile("deep", bytes("blocking-parent"));

      expect(() => session.move("src.txt", "deep/nested/target.txt")).toThrow(
        VirtualNotDirectoryError,
      );

      expect(bytesToUtf8(session.readFile("src.txt"))).toBe("data");
      expect(bytesToUtf8(session.readFile("deep"))).toBe("blocking-parent");
      expect(session.exists("deep/nested")).toBe(false);
      expect(session.diff()).toMatchObject([
        {
          kind: "create",
          path: "deep",
          current: { kind: "blob", mode: "100644" },
        },
        {
          kind: "create",
          path: "src.txt",
          current: { kind: "blob", mode: "100644" },
        },
      ]);
    });

    test("同父目录 rename 后不残留旧目录路径", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.mkdir("root/dir", { recursive: true });
      session.writeFile("root/dir/file.txt", bytes("x"));
      session.move("root/dir", "root/renamed");

      expect(session.exists("root/dir")).toBe(false);
      expect(bytesToUtf8(session.readFile("root/renamed/file.txt"))).toBe("x");

      const diff = session.diff();
      expect(diff.find((entry) => entry.path === "root/dir")).toBeUndefined();
      expect(diff.find((entry) => entry.path === "root/dir/file.txt")).toBeUndefined();
      expect(diff.find((entry) => entry.path === "root")).toMatchObject({ kind: "create" });
      expect(diff.find((entry) => entry.path === "root/renamed")).toMatchObject({
        kind: "create",
      });
      expect(diff.find((entry) => entry.path === "root/renamed/file.txt")).toMatchObject({
        kind: "create",
      });
    });

    test("move 后 writeTree 再 move，多次 writeTree 结果连续正确", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.writeFile("f.txt", bytes("data"));
      session.move("f.txt", "g.txt");
      const t1 = session.writeTree();
      expect(readTree(repo, t1).entries.map((e) => e.name)).toEqual(["g.txt"]);

      session.move("g.txt", "h.txt");
      const t2 = session.writeTree();
      expect(readTree(repo, t2).entries.map((e) => e.name)).toEqual(["h.txt"]);

      expect(t1).not.toBe(t2);
    });

    test("move 文件到深层新建目录链中，diff 显示仅目标路径", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.writeFile("source.txt", bytes("content"));
      session.move("source.txt", "deep/nested/path/target.txt");

      const diff = session.diff();
      expect(diff.find((e) => e.path === "source.txt")).toBeUndefined();
      expect(diff.find((e) => e.path === "deep")).toMatchObject({ kind: "create" });
      expect(diff.find((e) => e.path === "deep/nested")).toMatchObject({ kind: "create" });
      expect(diff.find((e) => e.path === "deep/nested/path")).toMatchObject({ kind: "create" });
      expect(diff.find((e) => e.path === "deep/nested/path/target.txt")).toMatchObject({
        kind: "create",
      });

      const rootHash = session.writeTree();
      const root = readTree(repo, rootHash);
      expect(root.entries.map((e) => e.name)).toEqual(["deep"]);
    });

    test("move 目录到另一个目录下，原同名目标条目被正确覆盖", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.mkdir("common");
      session.writeFile("common/a.txt", bytes("a"));
      session.mkdir("parent");
      session.mkdir("parent/common");
      session.writeFile("parent/common/b.txt", bytes("b"));

      expect(() => session.move("common", "parent/common")).toThrow(VirtualPathAlreadyExistsError);
    });

    test("move 文件到深层目录后，在深层目录中写入并再次 move，状态正确", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.writeFile("src.txt", bytes("move-me"));
      session.move("src.txt", "layer1/layer2/target.txt");

      session.writeFile("layer1/layer2/extra.txt", bytes("extra"));

      session.move("layer1/layer2/target.txt", "layer1/top.txt");

      expect(bytesToUtf8(session.readFile("layer1/top.txt"))).toBe("move-me");
      expect(bytesToUtf8(session.readFile("layer1/layer2/extra.txt"))).toBe("extra");
      expect(() => session.readFile("layer1/layer2/target.txt")).toThrow(VirtualPathNotFoundError);

      const rootHash = session.writeTree();
      const root = readTree(repo, rootHash);
      const layer1 = readTree(repo, root.entries.find((e) => e.name === "layer1")!.hash);
      expect(layer1.entries.map((e) => e.name).sort()).toEqual(["layer2", "top.txt"]);
    });
  });
});
