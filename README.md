# nano-git

使用 TypeScript 实现的 Git 核心功能，专注于**裸仓库（bare repository）** 操作与服务端场景，
不涉及暂存区（index）和工作目录管理。

## 特性

- ✅ **SHA-1 哈希计算** — 与 Git 完全兼容的对象哈希
- ✅ **Git 对象模型** — 支持 blob、tree、commit、tag 四种对象类型
- ✅ **对象序列化/反序列化** — 完整的二进制格式支持
- ✅ **对象存储** — 文件系统存储和内存存储两种模式
- ✅ **Packfile 支持** — 读取、写入、索引生成、delta 编解码
- ✅ **引用管理** — refs 验证、解析、存储（文件系统 + 内存）
- ✅ **仓库 API** — 类似 Git plumbing 命令的高层接口（init、hash-object、cat-file、commit-tree、update-ref 等）
- ✅ **可达性遍历与 GC** — 基于 refs 的可达对象收集、repack、gc
- ✅ **Smart HTTP Fetch 客户端** — 基于 Bun fetch 的 Git 协议客户端，支持 clone/fetch
- ✅ **类型安全** — 完整的 TypeScript 类型定义

## 安装

```bash
bun install
```

## 快速开始

### 基础哈希计算

```typescript
import { hashObject } from "nano-git";

// 计算 "hello world" 的 blob 哈希
const hash = hashObject("blob", Buffer.from("hello world"));
console.log(hash); // => "95d09f2b10159347eece71399a7e2e907ea3df4f"

// 与 git hash-object 完全一致
// $ echo -n "hello world" | git hash-object --stdin
// 95d09f2b10159347eece71399a7e2e907ea3df4f
```

### 使用内存仓库

```typescript
import { createMemoryRepository, type GitAuthor } from "nano-git";

const repo = createMemoryRepository();

// 写入文件内容
const fileHash = repo.writeBlob(Buffer.from("Hello, nano-git!"));

// 创建目录结构
const treeHash = repo.createTree([{ mode: "100644", name: "README.md", hash: fileHash }]);

// 创建提交
const author: GitAuthor = {
  name: "Your Name",
  email: "you@example.com",
  timestamp: Math.floor(Date.now() / 1000),
  timezone: "+0800",
};

const commitHash = repo.createCommit(
  treeHash,
  [], // 初始提交
  "Initial commit",
  author,
);

console.log(`Created commit: ${commitHash}`);
```

### 使用显式仓库后端

```typescript
import { createMemoryRepositoryBackend, createRepository } from "nano-git";

const backend = createMemoryRepositoryBackend();
const repo = createRepository(backend);

repo.createBranch("main", repo.createTree([]));
```

### 使用文件系统仓库

```typescript
import { initRepository, openRepository } from "nano-git";

// 初始化新仓库
const repo = initRepository("/path/to/project");

// 或打开已有仓库
const existingRepo = openRepository("/path/to/existing/project");

// 写入文件
const hash = repo.writeBlobFile("/path/to/file.txt");

// 将整个目录写入 tree
const treeHash = repo.writeTree("/path/to/directory");

// 更新引用
repo.updateRef("refs/heads/main", commitHash);
```

`openRepository()` 默认会同时读取 `.git/objects/` 下的 loose objects 和 `.git/objects/pack/` 下的 packed objects，因此可以直接打开经过 `git gc` 或 `git repack` 的真实仓库（包括裸仓库）。搭配 `initRepository()` 的第二个参数可初始化为裸仓库布局。

### 生成 Packfile

```typescript
import { openRepository } from "nano-git";

const repo = openRepository("/path/to/repo");

// 打包当前仓库中所有可见对象
const result = repo.writePack();
console.log(result.packPath);
```

### Repack 仓库

```typescript
import { openRepository } from "nano-git";

const repo = openRepository("/path/to/repo");

// 重新生成 pack，并删除旧 pack 文件
repo.repack();

// 如需同时移除已打包的 loose objects：
repo.repack({ pruneLoose: true });
```

### 基于可达对象执行 GC

```typescript
import { openRepository } from "nano-git";

const repo = openRepository("/path/to/repo");

// 仅保留从 HEAD、分支、标签可达的对象
const result = repo.gc();
console.log(result.objectCount);
```

### 从远程仓库 Fetch（Smart HTTP）

```typescript
import { initRepository } from "nano-git";

const repo = initRepository("/tmp/my-clone");

// 从远程仓库拉取对象和引用
const result = await repo.fetch("https://github.com/user/repo");
console.log(`Fetched ${result.objectCount} objects`);

// 远程分支以 refs/remotes/origin/* 写入
const mainRef = repo.readRef("refs/remotes/origin/main");
if (mainRef) {
  const commit = repo.catFile(mainRef);
  console.log(`Main branch: ${commit.type} ${mainRef}`);
}

// 执行增量 fetch（仅拉取新对象）
const result2 = await repo.fetch("https://github.com/user/repo");
console.log(`New objects: ${result2.objectCount}`); // 0（已是最新）
```

如果你需要更底层的控制，也可以直接使用 transport 层的独立函数：

```typescript
import { fetch, createSmartHttpClient, buildUploadPackRequest } from "nano-git";

// 仅获取引用广告
const client = createSmartHttpClient("https://github.com/user/repo");
const adv = await client.getRefAdvertisement();
console.log(adv.refs);
```

### 对象序列化

```typescript
import { serialize, deserialize, type GitBlob } from "nano-git";

const blob: GitBlob = {
  type: "blob",
  content: Buffer.from("file content"),
};

// 序列化为 Git 存储格式
const data = serialize(blob);
// => Buffer("blob 12\0file content")

// 反序列化
const obj = deserialize(data);
console.log(obj.type); // => "blob"
```

## 运行演示

```bash
bun run examples/demo.ts
```

演示脚本展示了：

- SHA-1 哈希计算
- 对象序列化/反序列化
- 内存仓库操作
- 创建 blob、tree、commit 对象
- 对象存储和读取

## 项目结构

```
nano-git/
├── src/
│   ├── index.ts          # 入口文件和公开导出
│   ├── core/             # 核心类型、错误、哈希工具
│   ├── objects/          # blob/tree/commit/tag 序列化
│   ├── odb/              # 对象数据库与 pack 支持
│   ├── refs/             # 引用解析、校验、存储
│   ├── transport/        # Smart HTTP Fetch 协议客户端
│   └── repository/       # 仓库 API 与后端
├── tests/
│   ├── units/            # 单元测试
│   ├── e2e/              # 端到端兼容性测试
│   └── README.md
├── examples/
│   └── demo.ts           # 演示脚本
└── README.md
```

## Git 对象模型

Git 使用内容寻址文件系统，所有对象通过 SHA-1 哈希寻址：

### Blob（文件内容）

存储文件的原始内容，不包含文件名或权限信息。

### Tree（目录结构）

存储目录内容，每个条目包含：

- 文件模式（如 `100644` 普通文件，`100755` 可执行文件，`040000` 目录）
- 文件名
- 指向 blob 或子 tree 的哈希

### Commit（快照）

存储一次提交的完整信息：

- 指向 tree 的哈希（项目快照）
- 父 commit 哈希列表（merge commit 有多个父节点）
- 作者和提交者信息
- 提交信息

### Tag（标签）

带注释的标签，指向特定对象（通常是 commit）。

## 对象存储格式

所有 Git 对象以以下格式存储：

```
<type> <size>\0<content>
```

例如，一个包含 "hello world" 的 blob：

```
blob 11\0hello world
```

对象在 `.git/objects/` 目录下以 zlib 压缩格式存储，路径为：

```
.git/objects/<前2字符>/<剩余38字符>
```

例如：`.git/objects/95/d09f2b10159347eece71399a7e2e907ea3df4f`

## 开发

```bash
# 类型检查
bun tsc --noEmit

# 运行测试
bun test
```

## 路线图

### 已实现

- [x] 基础数据结构和哈希算法
- [x] 对象序列化/反序列化
- [x] 对象存储（文件系统和内存）
- [x] Packfile 支持（读取、写入、索引、delta 编解码、打包构建器）
- [x] 引用管理（refs、HEAD、符号引用解析）
- [x] 仓库 API（init、open、hash-object、cat-file、write-tree、commit-tree、update-ref、branch、tag）
- [x] 可达性遍历与 GC（repack、gc）
- [x] **Smart HTTP Fetch 客户端** — pkt-line 编解码、ref 广告解析、side-band 解复用、请求生成、HTTP 传输、fetch 编排、`repo.fetch()` 集成

### 规划中（聚焦裸仓库/服务端场景）

- [ ] **Smart HTTP Push / receive-pack** — `git push` 的协议层
- [ ] **Reference Transaction** — 引用更新钩子与事务
- [ ] **多格式哈希支持** — SHA-256 兼容准备

### 非目标（明确不实现）

- ~~暂存区（index）操作~~ — 如 `git add`、`git status`
- ~~工作目录管理~~ — 如 `git checkout`、`git restore`
- ~~文件级别的差异计算（diff）~~ — 如 `git diff`

## 参考资料

- [Git Internals - Git Objects](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects)
- [Git Internals - Git References](https://git-scm.com/book/en/v2/Git-Internals-Git-References)
- [Git Repository Layout](https://git-scm.com/docs/gitrepository-layout)

## 许可证

MIT
