/**
 * nano-git 演示脚本
 *
 * 展示如何使用 nano-git 的核心功能：
 * 1. 创建内存仓库
 * 2. 写入 blob 对象
 * 3. 创建 tree 对象
 * 4. 创建 commit 对象
 * 5. 读取和验证对象
 * 6. Tree 遍历与增量修改
 */

import {
  createMemoryRepository,
  hashObject,
  serialize,
  deserialize,
  readTree,
  patchTree,
  type GitBlob,
  type GitAuthor,
} from "../src/index.ts";

console.log("=== nano-git 演示 ===\n");

// ============================================================================
// 1. 基础哈希计算
// ============================================================================

console.log("1. SHA-1 哈希计算");
console.log("-".repeat(50));

const helloWorld = Buffer.from("hello world");
const hash = hashObject("blob", helloWorld);
console.log(`"hello world" 的 blob 哈希: ${hash}`);
console.log(`预期值: 95d09f2b10159347eece71399a7e2e907ea3df4f`);
console.log(`匹配: ${hash === "95d09f2b10159347eece71399a7e2e907ea3df4f"}\n`);

// ============================================================================
// 2. 对象序列化/反序列化
// ============================================================================

console.log("2. 对象序列化/反序列化");
console.log("-".repeat(50));

const blob: GitBlob = {
  type: "blob",
  content: Buffer.from("Hello, nano-git!"),
};

const serialized = serialize(blob);
console.log(`序列化后的 blob: ${serialized.toString("utf-8")}`);
console.log(`格式: "blob <size>\\0<content>"`);

const deserialized = deserialize(serialized);
console.log(`反序列化成功: ${deserialized.type === "blob"}`);
if (deserialized.type === "blob") {
  console.log(`内容: ${deserialized.content.toString("utf-8")}\n`);
}

// ============================================================================
// 3. 使用内存仓库
// ============================================================================

console.log("3. 内存仓库操作");
console.log("-".repeat(50));

const repo = createMemoryRepository();

// 写入多个 blob
const file1Hash = repo.writeBlob(Buffer.from("file 1 content"));
const file2Hash = repo.writeBlob(Buffer.from("file 2 content"));
const file3Hash = repo.writeBlob(Buffer.from("#!/bin/bash\necho hello"));

console.log(`file1.txt: ${file1Hash}`);
console.log(`file2.txt: ${file2Hash}`);
console.log(`script.sh: ${file3Hash}`);

// 创建 tree 对象
const treeHash = repo.createTree([
  { mode: "100644", name: "file1.txt", hash: file1Hash },
  { mode: "100644", name: "file2.txt", hash: file2Hash },
  { mode: "100755", name: "script.sh", hash: file3Hash },
]);

console.log(`\nTree 对象: ${treeHash}`);

// 读取 tree 对象
const treeObj = repo.catFile(treeHash);
if (treeObj.type === "tree") {
  console.log(`Tree 包含 ${treeObj.entries.length} 个条目:`);
  for (const entry of treeObj.entries) {
    console.log(`  ${entry.mode} ${entry.name} ${entry.hash}`);
  }
}

// ============================================================================
// 4. 创建 commit
// ============================================================================

console.log("\n4. 创建 Commit");
console.log("-".repeat(50));

const author: GitAuthor = {
  name: "Demo User",
  email: "demo@example.com",
  timestamp: Math.floor(Date.now() / 1000),
  timezone: "+0800",
};

const commitHash = repo.createCommit(
  treeHash,
  [], // 初始提交，没有父节点
  "Initial commit\n\nThis is the first commit in nano-git demo.",
  author,
);

console.log(`Commit 对象: ${commitHash}`);

// 读取 commit 对象
const commitObj = repo.catFile(commitHash);
if (commitObj.type === "commit") {
  console.log(`Tree: ${commitObj.tree}`);
  console.log(`Parents: ${commitObj.parents.length === 0 ? "(无)" : commitObj.parents.join(", ")}`);
  console.log(`Author: ${commitObj.author.name} <${commitObj.author.email}>`);
  console.log(`Message: ${commitObj.message.split("\n")[0]}`);
}

// ============================================================================
// 5. 创建第二个 commit（有父节点）
// ============================================================================

console.log("\n5. 创建第二个 Commit（带父节点）");
console.log("-".repeat(50));

// 修改一个文件
const file1UpdatedHash = repo.writeBlob(Buffer.from("file 1 content - updated!"));

// 创建新的 tree
const tree2Hash = repo.createTree([
  { mode: "100644", name: "file1.txt", hash: file1UpdatedHash },
  { mode: "100644", name: "file2.txt", hash: file2Hash },
  { mode: "100755", name: "script.sh", hash: file3Hash },
]);

// 创建第二个 commit
const commit2Hash = repo.createCommit(
  tree2Hash,
  [commitHash], // 第一个 commit 作为父节点
  "Update file1.txt",
  author,
);

console.log(`Commit 2: ${commit2Hash}`);

const commit2Obj = repo.catFile(commit2Hash);
if (commit2Obj.type === "commit") {
  console.log(`Parent: ${commit2Obj.parents[0]}`);
  console.log(`Message: ${commit2Obj.message}`);
}

// ============================================================================
// 6. 验证对象存储
// ============================================================================

console.log("\n6. 验证对象存储");
console.log("-".repeat(50));

const allObjects = [
  file1Hash,
  file2Hash,
  file3Hash,
  file1UpdatedHash,
  treeHash,
  tree2Hash,
  commitHash,
  commit2Hash,
];

console.log(`总共存储了 ${allObjects.length} 个对象:`);
for (const hash of allObjects) {
  const type = repo.catFileType(hash);
  console.log(`  ${hash} (${type})`);
}

// ============================================================================
// 7. Tree 遍历与增量修改
// ============================================================================

console.log("\n7. Tree 遍历与增量修改");
console.log("-".repeat(50));

const allFiles = readTree(repo.objects, tree2Hash);
console.log(`Tree2 包含 ${allFiles.length} 个文件:`);
for (const entry of allFiles) {
  console.log(`  ${entry.mode} ${entry.path} ${entry.hash}`);
}

// 增量修改：删除文件 + 新增文件
const patchResult = patchTree(repo.objects, tree2Hash, [
  { op: "delete", path: "script.sh" },
  {
    op: "upsert",
    path: "CHANGELOG.md",
    mode: "100644",
    hash: repo.writeBlob(Buffer.from("# Changelog\n")),
  },
]);

console.log(`\nPatch 后新的 root tree: ${patchResult.rootHash}`);
console.log(`新写入的 tree 对象: ${patchResult.writtenTrees.length}`);

console.log("\n=== 演示完成 ===");
