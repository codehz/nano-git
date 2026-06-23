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
- ✅ **增量 Tree Patch** — 不经暂存区直接修改目录结构（`patchTree`、`readTree`、`walkTree`）
- ✅ **可达性遍历与 GC** — 基于 refs 的可达对象收集、repack、gc
- ✅ **Smart HTTP 传输** — 基于 Bun fetch 的 Git 协议客户端，支持 `fetch()`/`push()` 与完整的 Import Session 物化流程
- ✅ **类型安全** — 完整的 TypeScript 类型定义
- ✅ **Reference Transaction** — 批量 ref 更新的原子性保障，支持 Hooks 回调与自动回滚

## 安装

```bash
bun install
```

## 快速开始

### 5 行完成"创建 → 写入 → 提交"

```typescript
import { createMemoryRepository } from "nano-git/repository/memory";

const repo = createMemoryRepository();
const treeHash = repo.createTree([
  { mode: "100644", name: "hello.txt", hash: repo.writeBlob(Buffer.from("Hello!")) },
]);
const commitHash = repo.createCommit(treeHash, [], "Initial commit", {
  name: "You",
  email: "you@example.com",
  timestamp: Math.floor(Date.now() / 1000),
  timezone: "+0800",
});
console.log(`Created commit: ${commitHash}`);
```

### 从远端仓库拉取

```typescript
import { initRepository } from "nano-git/repository/file";

const repo = initRepository("/tmp/project");
await repo.fetch("https://github.com/user/repo.git");
// 所有分支和标签已就绪
console.log(repo.listBranches());
```

### 内存仓库完整工作流

```typescript
import { createMemoryRepository } from "nano-git/repository/memory";
import type { GitAuthor } from "nano-git";

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

### 启动 Smart HTTP 服务器

```typescript
import { openRepository } from "nano-git/repository/file";
import { createSmartHttpHandler } from "nano-git/transport/http/smart-http";

// 创建 Git HTTP 后端处理函数（框架无关，标准 Request/Response）
const handler = createSmartHttpHandler(openRepository("/path/to/repo"));

// 接入 Bun.serve — 直接作为 fetch 处理器
Bun.serve({ port: 8080, fetch: handler });

console.log("Git server running on http://localhost:8080");
// 客户端可用 `git clone http://localhost:8080/` 拉取
```

### 使用显式仓库后端

```typescript
import { createMemoryRepositoryBackend } from "nano-git/backend";
import { createRepository } from "nano-git/repository/create";

const backend = createMemoryRepositoryBackend();
const repo = createRepository(backend);

repo.createBranch("main", repo.createTree([]));
```

### 使用文件系统仓库

```typescript
import { initRepository, openRepository } from "nano-git/repository/file";

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
import { openRepository } from "nano-git/repository/file";

const repo = openRepository("/path/to/repo");

// 打包当前仓库中所有可见对象
const result = repo.writePack();
console.log(result.packPath);
```

### Repack 仓库

```typescript
import { openRepository } from "nano-git/repository/file";

const repo = openRepository("/path/to/repo");

// 重新生成 pack，并删除旧 pack 文件
repo.repack();

// 如需同时移除已打包的 loose objects：
repo.repack({ pruneLoose: true });
```

### 基于可达对象执行 GC

```typescript
import { openRepository } from "nano-git/repository/file";

const repo = openRepository("/path/to/repo");

// 仅保留从 HEAD、分支、标签可达的对象
const result = repo.gc();
console.log(result.objectCount);
```

### 从远程仓库导入（Import Session）

```typescript
import { initRepository } from "nano-git/repository/file";

const repo = initRepository("/tmp/my-clone");

const session = await repo.openImportSession({
  url: "https://github.com/user/repo",
});

const branches = session.select("refs/heads/*");
const defaultBranch = session.defaultBranch();

const plan = session
  .plan()
  .materialize(branches)
  .toNamespace("refs/mirrors/upstream/*", {
    policy: { mode: "mirror" },
    prune: true,
  })
  .materialize(defaultBranch)
  .toBranch("main")
  .materialize(defaultBranch)
  .setHead();

const preview = await plan.preview();
console.log(preview.refOperations.map((op) => op.localRef));
console.log(preview.prefetchedObjects);

const result = await plan.apply();
console.log(`Imported ${result.importedObjects} objects`);
console.log(`Updated ${result.updatedRefs.size} refs`);
```

`preview()` 可能会为严格校验预取缺失对象，但不会写入 refs 或 `HEAD`。`apply()` 只会消费同一计划的冻结 preview 结果。

带认证的导入（私有仓库）：

```typescript
const session = await repo.openImportSession({
  url: "https://github.com/org/private-repo",
  token: "ghp_xxxxxxxxxxxx",
});

const session2 = await repo.openImportSession({
  url: "https://gitlab.com/org/private-repo",
  headers: { "Job-Token": "xxxxxxxx" },
});

await session.plan().materialize(session.defaultBranch()).toBranch("main").apply();
await session2
  .plan()
  .materialize(session2.allRefs())
  .toNamespace("refs/mirrors/upstream/*", {
    policy: { mode: "mirror" },
    prune: true,
  })
  .apply();
```

如果你需要更底层的控制，也可以直接使用 transport 层的独立函数：

```typescript
import {
  buildUploadPackRequest,
  createUploadPackHttpClient,
  decodeUploadPackResponse,
} from "nano-git/transport";
import { sha1 } from "nano-git";

// 仅获取引用广告
const client = createUploadPackHttpClient("https://github.com/user/repo");
const adv = await client.advertise();
console.log(adv.refs);

// 带认证的底层传输控制
const authedClient = createUploadPackHttpClient("https://github.com/user/repo", {
  token: "ghp_xxxxxxxx",
});

const body = buildUploadPackRequest(
  [sha1("95d09f2b10159347eece71399a7e2e907ea3df4f")],
  [],
  ["multi_ack", "side-band-64k", "ofs-delta"],
);

const raw = await authedClient.request(body);
const { packfile } = decodeUploadPackResponse(raw);
```

### 对象序列化

```typescript
import { serialize, deserialize } from "nano-git/objects";
import type { GitBlob } from "nano-git";

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

## 按需加载的入口设计

本库采用 **tree-shakeable** 的子路径导出设计，各模块按后端实现类型隔离。
默认入口 `"nano-git"` 只导出核心类型和纯工具函数，**不包含任何后端实现**。
具体子路径入口见 `package.json` 的 `exports` 字段或 `src/index.ts` 的 JSDoc 文档。

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
- [x] **Smart HTTP 传输** — pkt-line 编解码、ref 广告解析、side-band 解复用、Fetch / Push 协议、Import Session 集成
- [x] **Reference Transaction** — 批量 ref 更新原子性、lock-then-rename 文件事务、生命周期 Hooks

- [x] **Smart HTTP 服务端（upload-pack）** — 类 git-http-backend、框架无关的 HTTP handler，支持 ls-refs 和 fetch 命令，协议实现与编排器解耦
- [x] **Smart HTTP 服务端（v1 receive-pack）** — 服务端 push 支持，基于 v1 协议，含 ref 广告、packfile 解包、ref 校验与 report-status

### 规划中（聚焦裸仓库/服务端场景）

- [ ] **Partial Clone / Filter 支持** — 按需对象过滤传输

### 非目标（明确不实现）

- ~~暂存区（index）操作~~ — 如 `git add`、`git status`
- ~~工作目录管理~~ — 如 `git checkout`、`git restore`
- ~~文件级别的差异计算（diff）~~ — 如 `git diff`
- ~~多格式哈希支持~~ — SHA-256 兼容准备（当前仅 SHA-1）

## 参考资料

- [Git Internals - Git Objects](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects)
- [Git Internals - Git References](https://git-scm.com/book/en/v2/Git-Internals-Git-References)
- [Git Repository Layout](https://git-scm.com/docs/gitrepository-layout)

## 许可证

MIT
