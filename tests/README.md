# nano-git 测试

本目录包含 nano-git 项目的所有测试，使用 Bun 内置的测试运行器。

## 目录结构

```
tests/
├── README.md
├── units/              # 单元测试，按源码模块组织
│   ├── core/           # 基础类型和哈希
│   │   ├── types.test.ts    # SHA1 branded type 校验
│   │   └── hash.test.ts     # SHA-1 哈希计算、路径转换、格式验证
│   ├── objects/        # Git 对象序列化/反序列化
│   │   ├── blob.test.ts     # Blob 对象
│   │   ├── tree.test.ts     # Tree 对象
│   │   ├── commit.test.ts   # Commit 对象
│   │   ├── tag.test.ts      # Tag 对象
│   │   └── codec.test.ts    # 编解码错误处理及工具函数
│   ├── odb/            # 对象存储
│   │   ├── memory-store.test.ts   # 内存对象存储
│   │   ├── file-store.test.ts     # 文件系统对象存储
│   │   └── pack/               # Packfile 组件
│   │       ├── varint.test.ts       # 变长整数编码/解码
│   │       ├── delta.test.ts        # Delta 编解码
│   │       ├── packfile.test.ts     # Packfile 读写
│   │       ├── pack-index.test.ts   # 索引文件读写
│   │       ├── pack-store.test.ts   # PackObjectSource
│   │       ├── composite-store.test.ts # CompositeObjectDatabase
│   │       └── pack-builder.test.ts # PackBuilder
│   ├── refs.test.ts    # 引用存储和工具函数
│   └── repository/     # 仓库高层 API
│       ├── memory-repository.test.ts # 内存仓库
│       ├── tree-patch.test.ts       # 增量 tree 操作
│       ├── init-open.test.ts        # init/create/open
│       ├── fs-refs.test.ts          # 文件系统 ref 操作
│       └── fs-objects.test.ts       # 文件系统对象操作
│   └── worktree/       # Virtual Worktree（内存 / file / sqlite 契约与单元测试）
└── e2e/                # 端到端兼容性测试（需要系统安装 git）
    ├── helpers.ts      # Git CLI 封装工具
    ├── blob.test.ts    # Blob 兼容性
    ├── tree.test.ts    # Tree 兼容性（含符号链接）
    ├── commit.test.ts  # Commit 兼容性
    ├── tag.test.ts     # Tag 兼容性
    ├── ref.test.ts     # Ref（引用）兼容性
    ├── workflow.test.ts# 完整工作流
    └── pack.test.ts    # Packfile 兼容性
```

## 运行测试

```bash
# 运行所有测试
bun test

# 运行所有单元测试
bun test tests/units/

# 运行特定模块测试
bun test tests/units/objects/
bun test tests/units/pack/

# 运行 E2E 测试（需要系统安装 git）
bun test tests/e2e/

# 运行特定测试文件
bun test tests/units/core/hash.test.ts
bun test tests/e2e/blob.test.ts

# 监听模式
bun test --watch
```

## 测试原则

- **纯单元测试**：测试各模块的内部逻辑，不涉及与真实 Git 命令行的对比
- **内存优先**：尽量使用内存存储，避免文件系统副作用
- **文件系统测试**：使用临时目录，测试后自动清理
- **往返一致性**：序列化/反序列化、写入/读取等操作验证数据完整性

## E2E 测试策略

采用**双向验证**模式：

1. **nano-git → git**：用 nano-git 创建对象，用 `git cat-file` 等命令验证
2. **git → nano-git**：用 `git` 命令创建对象，用 nano-git 的 API 读取验证

### 环境要求

- 系统需安装 `git` 命令行工具（测试使用 `git version 2.54.0` 验证）
- 测试使用固定的 `GIT_AUTHOR_*` 和 `GIT_COMMITTER_*` 环境变量确保可重复性

### 已知兼容性细节

- Git 的 `commit-tree` 命令会在 commit message 末尾自动添加换行符，nano-git 的反序列化会保留此行为
- Tree 目录 mode 使用 `"040000"`（规范形式，与 `git cat-file -p` 显示一致），序列化时自动转为 `"40000"` 以匹配 Git 磁盘格式
