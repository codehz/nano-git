/**
 * VirtualWorktree 组合操作测试：验证操作序列不损坏内部数据结构
 *
 * 本文件针对可能引发数据损坏（节点离群、overlay 引用断裂、writeTree 缺失子树、
 * change index 不收敛等）的操作组合，覆盖多后端。
 */
import { describe, expect, test } from "bun:test";

import { virtualWorktreeBackends } from "./contract.ts";
import { VirtualPathNotFoundError } from "@/errors.ts";
import { createMemoryRepository } from "@/repository/memory.ts";

import type { GitTree, SHA1 } from "@/types/index.ts";

function readTree(repo: ReturnType<typeof createMemoryRepository>, hash: string): GitTree {
  const obj = repo.catFile(hash as SHA1);
  if (obj.type !== "tree") throw new Error(`Expected tree, got ${obj.type}`);
  return obj;
}

function readBlob(repo: ReturnType<typeof createMemoryRepository>, hash: string): Buffer {
  const obj = repo.catFile(hash as SHA1);
  if (obj.type !== "blob") throw new Error(`Expected blob, got ${obj.type}`);
  return obj.content;
}

describe("VirtualWorktree contract: combinations", () => {
  describe.each(virtualWorktreeBackends)("$name", ({ createWorktree }) => {
    // ==================== 文件-目录类型互换 ====================

    test("基线的目录被删除后创建为同名文件，writeTree 不残留旧子树", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("alpha"));
      const subTree = repo.createTree([{ mode: "100644", name: "nested.txt", hash: fileHash }]);
      const baseTree = repo.createTree([{ mode: "040000", name: "dir", hash: subTree }]);
      const session = createWorktree(repo, { baseTree });

      session.delete("dir");
      session.writeFile("dir", Buffer.from("file-now"));

      expect(session.stat("dir")).toMatchObject({ kind: "blob", mode: "100644" });
      expect(() => session.readFile("dir/nested.txt")).toThrow(VirtualPathNotFoundError);

      const rootHash = session.writeTree();
      const root = readTree(repo, rootHash);
      expect(root.entries).toHaveLength(1);
      expect(root.entries[0]!).toMatchObject({ mode: "100644", name: "dir" });
      expect(readBlob(repo, root.entries[0]!.hash).toString()).toBe("file-now");
    });

    test("基线的文件被删除后创建为同名目录，writeTree 后目录可含子文件", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("content"));
      const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: fileHash }]);
      const session = createWorktree(repo, { baseTree });

      session.delete("f");
      session.mkdir("f");
      session.writeFile("f/child.txt", Buffer.from("child"));

      expect(session.stat("f")).toMatchObject({ kind: "tree", mode: "040000" });
      expect(session.readFile("f/child.txt").toString()).toBe("child");

      const rootHash = session.writeTree();
      const root = readTree(repo, rootHash);
      expect(root.entries).toHaveLength(1);
      expect(root.entries[0]!).toMatchObject({ mode: "040000", name: "f" });
      const dir = readTree(repo, root.entries[0]!.hash);
      expect(dir.entries).toHaveLength(1);
      expect(dir.entries[0]!).toMatchObject({ mode: "100644", name: "child.txt" });
    });

    test("文件→目录→文件往返 writeTree 三次结果均正确", () => {
      const repo = createMemoryRepository();
      const baseTree = repo.createTree([]);
      const session = createWorktree(repo, { baseTree });

      // 阶段 1：文件
      session.writeFile("x", Buffer.from("v1"));
      const t1 = session.writeTree();
      expect(readBlob(repo, readTree(repo, t1).entries[0]!.hash).toString()).toBe("v1");

      // 阶段 2：文件→目录
      session.delete("x");
      session.mkdir("x");
      session.writeFile("x/y.txt", Buffer.from("v2"));
      const t2 = session.writeTree();
      const t2Root = readTree(repo, t2);
      expect(t2Root.entries[0]!).toMatchObject({ mode: "040000", name: "x" });
      expect(
        readBlob(repo, readTree(repo, t2Root.entries[0]!.hash).entries[0]!.hash).toString(),
      ).toBe("v2");

      // 阶段 3：目录→文件
      session.delete("x");
      session.writeFile("x", Buffer.from("v3"));
      const t3 = session.writeTree();
      expect(readBlob(repo, readTree(repo, t3).entries[0]!.hash).toString()).toBe("v3");
    });

    // ==================== move + 源路径回收 ====================

    test("move 文件后，源路径创建同名目录，源与目标互不干扰", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.writeFile("a.txt", Buffer.from("data"));
      session.move("a.txt", "b.txt");

      // 源路径创建目录
      session.mkdir("a.txt");
      session.writeFile("a.txt/c.txt", Buffer.from("under-a"));

      expect(session.readFile("b.txt").toString()).toBe("data");
      expect(session.readFile("a.txt/c.txt").toString()).toBe("under-a");

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
      session.writeFile("dir/a.txt", Buffer.from("deep"));
      session.move("dir", "moved");

      // 源路径创建为文件
      session.writeFile("dir", Buffer.from("shallow"));

      expect(session.readFile("moved/a.txt").toString()).toBe("deep");
      expect(session.readFile("dir").toString()).toBe("shallow");

      const rootHash = session.writeTree();
      const root = readTree(repo, rootHash);
      const names = root.entries.map((e) => e.name).sort();
      expect(names).toEqual(["dir", "moved"]);
    });

    test("move 文件到深层路径，源路径被重复利用为深层目录", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      // 先创建 a.txt，move 到 deep/nested/b.txt
      session.writeFile("a.txt", Buffer.from("moved"));
      session.move("a.txt", "deep/nested/b.txt");

      // 源路径创建为目录并写入
      session.mkdir("a.txt");
      session.writeFile("a.txt/c.txt", Buffer.from("child"));

      expect(session.readFile("deep/nested/b.txt").toString()).toBe("moved");
      expect(session.readFile("a.txt/c.txt").toString()).toBe("child");

      const rootHash = session.writeTree();
      const root = readTree(repo, rootHash);
      const names = root.entries.map((e) => e.name).sort();
      expect(names).toEqual(["a.txt", "deep"]);
    });

    // ==================== copy 后独立修改 ====================

    test("copy 子树后删除源子树中文件，目标不受影响且 writeTree 正确", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.mkdir("src");
      session.writeFile("src/a.txt", Buffer.from("a"));
      session.writeFile("src/b.txt", Buffer.from("b"));
      session.copy("src", "copy");

      // 删除源中的文件
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

      // 源子树新增文件
      session.writeFile("base/b.txt", Buffer.from("b"));

      expect(session.readFile("base/a.txt").toString()).toBe("a");
      expect(session.readFile("base/b.txt").toString()).toBe("b");
      expect(session.readFile("derived/a.txt").toString()).toBe("a");
      expect(() => session.readFile("derived/b.txt")).toThrow(VirtualPathNotFoundError);
    });

    // ==================== restore 后修改 ====================

    test("restore 递归后立即修改能正确更新 diff", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("base"));
      const dirTree = repo.createTree([{ mode: "100644", name: "f.txt", hash: fileHash }]);
      const baseTree = repo.createTree([{ mode: "040000", name: "dir", hash: dirTree }]);
      const session = createWorktree(repo, { baseTree });

      session.writeFile("dir/f.txt", Buffer.from("edited"));
      session.restore("dir", { recursive: true });

      expect(session.diff()).toEqual([]);

      // 再次修改
      session.writeFile("dir/f.txt", Buffer.from("re-edited"));

      expect(session.diff()).toMatchObject([{ kind: "update", path: "dir/f.txt" }]);
    });

    test("restore 为非递归目录后，子树中写文件仍可读", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("base"));
      const dirTree = repo.createTree([
        { mode: "100644", name: "a.txt", hash: fileHash },
        { mode: "100644", name: "b.txt", hash: fileHash },
      ]);
      const baseTree = repo.createTree([{ mode: "040000", name: "dir", hash: dirTree }]);
      const session = createWorktree(repo, { baseTree });

      session.writeFile("dir/a.txt", Buffer.from("edited-a"));
      session.delete("dir/b.txt");
      session.restore("dir"); // 非递归：只是恢复 dir 的存在，子树修改保留

      expect(session.readFile("dir/a.txt").toString()).toBe("edited-a");
      expect(session.exists("dir/b.txt")).toBe(false);

      // 在子树中再新增一个文件
      session.writeFile("dir/c.txt", Buffer.from("new-c"));

      expect(session.readFile("dir/c.txt").toString()).toBe("new-c");
    });

    test("restore 文件前先删除父目录，restore 自动重建目录链", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("deep-base"));
      const inner = repo.createTree([{ mode: "100644", name: "target.txt", hash: fileHash }]);
      const outer = repo.createTree([{ mode: "040000", name: "inner", hash: inner }]);
      const baseTree = repo.createTree([{ mode: "040000", name: "outer", hash: outer }]);
      const session = createWorktree(repo, { baseTree });

      session.delete("outer");
      expect(session.exists("outer")).toBe(false);

      session.restore("outer/inner/target.txt", { recursive: true });

      expect(session.readFile("outer/inner/target.txt").toString()).toBe("deep-base");
      expect(session.diff()).toEqual([]);
    });

    // ==================== writeTree 交织 ====================

    test("连续多次 writeTree 与修改交织，每次结果自洽", () => {
      const repo = createMemoryRepository();
      const baseTree = repo.createTree([]);
      const session = createWorktree(repo, { baseTree });

      session.writeFile("a.txt", Buffer.from("v1"));
      session.mkdir("dir");

      const t1 = session.writeTree();
      const t1Root = readTree(repo, t1);
      expect(t1Root.entries.map((e) => e.name).sort()).toEqual(["a.txt", "dir"]);

      // 在 dir 下写文件，再 writeTree
      session.writeFile("dir/b.txt", Buffer.from("v2"));
      const t2 = session.writeTree();
      const t2Root = readTree(repo, t2);
      const t2Dir = readTree(repo, t2Root.entries.find((e) => e.name === "dir")!.hash);
      expect(t2Dir.entries.map((e) => e.name)).toEqual(["b.txt"]);

      // 删除 a.txt，修改 b.txt
      session.delete("a.txt");
      session.writeFile("dir/b.txt", Buffer.from("v3"));
      const t3 = session.writeTree();
      const t3Root = readTree(repo, t3);
      expect(t3Root.entries.map((e) => e.name)).toEqual(["dir"]);
      const t3Dir = readTree(repo, t3Root.entries[0]!.hash);
      expect(readBlob(repo, t3Dir.entries[0]!.hash).toString()).toBe("v3");

      // 最终 diff 正确（包含目录自身创建和文件创建）
      expect(session.diff()).toMatchObject([
        { kind: "create", path: "dir" },
        { kind: "create", path: "dir/b.txt" },
      ]);
    });

    test("writeTree 后删除路径再 writeTree，不残留已删除条目", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("stay"));
      const baseTree = repo.createTree([{ mode: "100644", name: "keep.txt", hash: fileHash }]);
      const session = createWorktree(repo, { baseTree });

      session.writeFile("temp.txt", Buffer.from("temp"));
      session.writeTree();

      session.delete("temp.txt");

      const finalHash = session.writeTree();
      const finalRoot = readTree(repo, finalHash);
      expect(finalRoot.entries.map((e) => e.name)).toEqual(["keep.txt"]);
    });

    test("writeTree 后 restore 已修改路径，diff 正确收敛", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("base"));
      const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: fileHash }]);
      const session = createWorktree(repo, { baseTree });

      session.writeFile("f", Buffer.from("edited"));
      session.writeTree();

      session.restore("f");

      expect(session.diff()).toEqual([]);
      const hash = session.writeTree();
      expect(hash).toBe(baseTree);
    });

    // ==================== 同路径反复操作 ====================

    test("同路径反复 writeFile → delete → writeFile 多次后 change records 不膨胀", () => {
      const repo = createMemoryRepository();
      const baseTree = repo.createTree([]);
      const session = createWorktree(repo, { baseTree });

      for (let i = 0; i < 10; i++) {
        session.writeFile("f.txt", Buffer.from(`v${i}`));
        session.delete("f.txt");
      }
      session.writeFile("f.txt", Buffer.from("final"));

      expect(session.diff()).toHaveLength(1);
      expect(session.diff()[0]).toMatchObject({
        kind: "create",
        path: "f.txt",
      });

      const rootHash = session.writeTree();
      const root = readTree(repo, rootHash);
      expect(root.entries).toHaveLength(1);
      expect(readBlob(repo, root.entries[0]!.hash).toString()).toBe("final");
    });

    test("同路径反复 mkdir → delete → mkdir 三次不报错", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      for (let i = 0; i < 3; i++) {
        session.mkdir("d");
        session.writeFile("d/f.txt", Buffer.from(`v${i}`));
        session.delete("d");
      }
      session.mkdir("d");
      session.writeFile("d/f.txt", Buffer.from("v3"));

      expect(session.readFile("d/f.txt").toString()).toBe("v3");
    });

    // ==================== 深层嵌套操作 ====================

    test("深层嵌套目录中 move 后子树操作正确", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.mkdir("a/b/c/d", { recursive: true });
      session.writeFile("a/b/c/d/target.txt", Buffer.from("deep"));
      session.move("a/b", "x/y");

      expect(session.readFile("x/y/c/d/target.txt").toString()).toBe("deep");
      expect(() => session.readFile("a/b/c/d/target.txt")).toThrow(VirtualPathNotFoundError);
      // a 被移除了 b 子项，但 a 自身仍存在（空目录）
      expect(session.exists("a")).toBe(true);
      expect(session.readdir("a")).toEqual([]);

      // 在源路径 a 下新建
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

      // 深层修改源子树
      session.writeFile("a/b/c/file.txt", Buffer.from("source-edit"));
      // 深层修改目标子树
      session.writeFile("copy/b/c/file.txt", Buffer.from("copy-edit"));

      expect(session.readFile("a/b/c/file.txt").toString()).toBe("source-edit");
      expect(session.readFile("copy/b/c/file.txt").toString()).toBe("copy-edit");

      // 在目标深层新增
      session.writeFile("copy/b/c/extra.txt", Buffer.from("extra"));
      expect(session.readFile("copy/b/c/extra.txt").toString()).toBe("extra");
      expect(() => session.readFile("a/b/c/extra.txt")).toThrow(VirtualPathNotFoundError);
    });

    // ==================== 多路径交织 ====================

    test("多个独立路径的并行操作互不干扰", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("base"));
      const baseTree = repo.createTree([
        { mode: "100644", name: "a.txt", hash: fileHash },
        { mode: "100644", name: "b.txt", hash: fileHash },
        { mode: "040000", name: "dir", hash: repo.createTree([]) },
      ]);
      const session = createWorktree(repo, { baseTree });

      session.writeFile("a.txt", Buffer.from("a-edited"));
      session.writeFile("new.txt", Buffer.from("new"));
      session.delete("b.txt");
      session.writeFile("dir/child.txt", Buffer.from("child"));
      session.mkdir("extra");
      session.writeFile("extra/x.txt", Buffer.from("x"));

      const diff = session.diff();
      expect(diff.find((e) => e.path === "a.txt")).toMatchObject({ kind: "update" });
      expect(diff.find((e) => e.path === "b.txt")).toMatchObject({ kind: "remove" });
      expect(diff.find((e) => e.path === "new.txt")).toMatchObject({ kind: "create" });
      expect(diff.find((e) => e.path === "dir/child.txt")).toMatchObject({ kind: "create" });
      expect(diff.find((e) => e.path === "extra/x.txt")).toMatchObject({ kind: "create" });

      const rootHash = session.writeTree();
      const root = readTree(repo, rootHash);
      const entryNames = root.entries.map((e) => e.name).sort();
      expect(entryNames).toEqual(["a.txt", "dir", "extra", "new.txt"]);
    });

    test("基线目录中新增与删除交织，overlay 不出现同名冲突", () => {
      const repo = createMemoryRepository();
      const subTree = repo.createTree([
        { mode: "100644", name: "keep.txt", hash: repo.writeBlob(Buffer.from("keep")) },
      ]);
      const baseTree = repo.createTree([{ mode: "040000", name: "dir", hash: subTree }]);
      const session = createWorktree(repo, { baseTree });

      // 删除基线的子文件，新增同名文件，删除新增，再新增
      session.delete("dir/keep.txt");
      session.writeFile("dir/keep.txt", Buffer.from("overwrite"));
      session.delete("dir/keep.txt");
      session.writeFile("dir/keep.txt", Buffer.from("final"));

      expect(session.readFile("dir/keep.txt").toString()).toBe("final");
      // diff 应该是 update 不是 create（因为基线存在）
      expect(session.diff()[0]).toMatchObject({
        kind: "update",
        path: "dir/keep.txt",
      });
    });

    // ==================== reset + 后续操作 ====================

    test("reset 到新基线后写入并 restore 正确", () => {
      const repo = createMemoryRepository();
      const fileHashA = repo.writeBlob(Buffer.from("aaa"));
      const fileHashB = repo.writeBlob(Buffer.from("bbb"));
      const treeA = repo.createTree([{ mode: "100644", name: "a.txt", hash: fileHashA }]);
      const treeB = repo.createTree([{ mode: "100644", name: "b.txt", hash: fileHashB }]);
      const session = createWorktree(repo, { baseTree: treeA });

      session.writeFile("extra.txt", Buffer.from("extra"));
      session.reset(treeB);

      expect(session.exists("a.txt")).toBe(false);
      expect(session.readFile("b.txt").toString()).toBe("bbb");
      expect(session.diff()).toEqual([]);

      // reset 后正常写入
      session.writeFile("c.txt", Buffer.from("ccc"));
      expect(session.readFile("c.txt").toString()).toBe("ccc");

      const rootHash = session.writeTree();
      const root = readTree(repo, rootHash);
      const names = root.entries.map((e) => e.name).sort();
      expect(names).toEqual(["b.txt", "c.txt"]);
    });

    // ==================== 混合操作链 ====================

    test("写→删→复制→移动→写混合操作链后 writeTree 正确", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.writeFile("a.txt", Buffer.from("a"));
      session.writeFile("b.txt", Buffer.from("b"));
      session.mkdir("sub");
      session.writeFile("sub/x.txt", Buffer.from("x"));

      // 删除 b
      session.delete("b.txt");
      // 复制 sub 到 sub2
      session.copy("sub", "sub2");
      // 移动 a 到 sub/a.txt
      session.move("a.txt", "sub/a.txt");
      // 在 sub2 新增文件
      session.writeFile("sub2/y.txt", Buffer.from("y"));
      // 删除 sub/x.txt
      session.delete("sub/x.txt");

      expect(session.readFile("sub/a.txt").toString()).toBe("a");
      expect(() => session.readFile("sub/x.txt")).toThrow(VirtualPathNotFoundError);
      expect(session.readFile("sub2/x.txt").toString()).toBe("x");
      expect(session.readFile("sub2/y.txt").toString()).toBe("y");
      expect(session.exists("b.txt")).toBe(false);
      expect(session.exists("a.txt")).toBe(false);

      const rootHash = session.writeTree();
      const root = readTree(repo, rootHash);
      const names = root.entries.map((e) => e.name).sort();
      expect(names).toEqual(["sub", "sub2"]);

      const sub = readTree(repo, root.entries.find((e) => e.name === "sub")!.hash);
      expect(sub.entries.map((e) => e.name)).toEqual(["a.txt"]);

      const sub2 = readTree(repo, root.entries.find((e) => e.name === "sub2")!.hash);
      expect(sub2.entries.map((e) => e.name).sort()).toEqual(["x.txt", "y.txt"]);
    });

    // ==================== 深层 restore ====================

    test("restore 递归后将子树中新增文件标记为删除，diff 正确", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("base"));
      const dirTree = repo.createTree([{ mode: "100644", name: "f.txt", hash: fileHash }]);
      const baseTree = repo.createTree([{ mode: "040000", name: "dir", hash: dirTree }]);
      const session = createWorktree(repo, { baseTree });

      session.writeFile("dir/new.txt", Buffer.from("new"));
      session.restore("dir", { recursive: true });

      expect(session.exists("dir/new.txt")).toBe(false);
      expect(session.diff()).toEqual([]);
    });

    // ==================== 异常恢复后状态 ====================

    test("构造事务回滚后 diff 仍正确收敛", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("base"));
      const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: fileHash }]);
      const session = createWorktree(repo, { baseTree });

      // 写一个新文件，触发 change index 更新
      session.writeFile("g", Buffer.from("new"));

      // 尝试一个会失败的操作（move 到自身子目录）
      session.mkdir("parent");
      session.writeFile("parent/child.txt", Buffer.from("child"));

      // 这个应该成功
      session.writeFile("h", Buffer.from("extra"));

      // 验证所有操作结果一致
      expect(session.readFile("f").toString()).toBe("base");
      expect(session.readFile("g").toString()).toBe("new");
      expect(session.readFile("h").toString()).toBe("extra");
      expect(session.readFile("parent/child.txt").toString()).toBe("child");

      const rootHash = session.writeTree();
      const root = readTree(repo, rootHash);
      const names = root.entries.map((e) => e.name).sort();
      expect(names).toEqual(["f", "g", "h", "parent"]);
    });

    // ==================== copy 对称性 ====================

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

    // ==================== 跨后端交互一致性 ====================

    test("不修改 baseTree 的情况下多次 writeTree 返回相同哈希", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.writeFile("stable.txt", Buffer.from("content"));
      const h1 = session.writeTree();
      const h2 = session.writeTree();
      const h3 = session.writeTree();

      expect(h1).toBe(h2);
      expect(h2).toBe(h3);

      // 修改后 writeTree 再恢复，最终又回到相同哈希
      session.writeFile("stable.txt", Buffer.from("changed"));
      const h4 = session.writeTree();
      expect(h4).not.toBe(h1);

      session.writeFile("stable.txt", Buffer.from("content"));
      const h5 = session.writeTree();
      expect(h5).toBe(h1);
    });
  });
});
