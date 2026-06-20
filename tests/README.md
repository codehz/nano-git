# nano-git 单元测试

本目录包含 nano-git 项目的基础单元测试，使用 Bun 内置的测试运行器。

## 运行测试

```bash
# 运行所有测试
bun test

# 运行特定测试文件
bun test tests/hash.test.ts

# 监听模式
bun test --watch
```

## 测试覆盖

| 文件                 | 测试内容                                          |
| -------------------- | ------------------------------------------------- |
| `types.test.ts`      | SHA1 branded type 校验                            |
| `hash.test.ts`       | SHA-1 哈希计算、路径转换、格式验证                |
| `objects.test.ts`    | Git 对象（blob/tree/commit/tag）序列化/反序列化   |
| `store.test.ts`      | 对象存储（内存和文件系统实现）                    |
| `repository.test.ts` | 仓库高层 API（init/open/writeBlob/createTree 等） |

## 测试原则

- **纯单元测试**：测试各模块的内部逻辑，不涉及与真实 Git 命令行的对比
- **内存优先**：尽量使用内存存储，避免文件系统副作用
- **文件系统测试**：使用临时目录，测试后自动清理
- **往返一致性**：序列化/反序列化、写入/读取等操作验证数据完整性

## 端到端测试（E2E）

`e2e/` 目录包含与标准 Git 命令行工具的兼容性测试。

### 运行 E2E 测试

```bash
# 运行 E2E 测试（需要系统安装 git）
bun test tests/e2e/

# 运行特定 E2E 测试文件
bun test tests/e2e/git-compat.test.ts
```

### E2E 测试覆盖

| 文件                     | 测试内容                                              |
| ------------------------ | ----------------------------------------------------- |
| `e2e/helpers.ts`         | Git CLI 封装工具（spawnSync 调用 git 命令）           |
| `e2e/git-compat.test.ts` | nano-git 与标准 Git 的双向兼容性测试（33 个测试用例） |

### 测试策略

采用**双向验证**模式：

1. **nano-git → git**：用 nano-git 创建对象，用 `git cat-file` 等命令验证
2. **git → nano-git**：用 `git` 命令创建对象，用 nano-git 的 API 读取验证

### 测试覆盖范围

- **Blob 兼容性**：文本、二进制、空内容、中文内容的读写验证
- **Tree 兼容性**：简单 tree、多文件 tree、嵌套 tree（子目录）、可执行文件模式
- **Commit 兼容性**：初始 commit、带父节点 commit、merge commit、author/committer 格式、多行 message
- **Tag 兼容性**：annotated tag 的创建和读取
- **Ref 兼容性**：分支引用、HEAD 符号引用、自定义分支
- **完整工作流**：nano-git 初始化仓库 + git 验证、git 初始化仓库 + nano-git 读取、交替操作

### 环境要求

- 系统需安装 `git` 命令行工具（测试使用 `git version 2.54.0` 验证）
- 测试使用固定的 `GIT_AUTHOR_*` 和 `GIT_COMMITTER_*` 环境变量确保可重复性

### 已知兼容性细节

- Git 的 `commit-tree` 命令会在 commit message 末尾自动添加换行符，nano-git 的反序列化会保留此行为
- Tree 目录 mode 使用 `"40000"`（无前导零），与 Git 实际行为一致
