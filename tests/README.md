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

## 未来计划

端到端测试（E2E）将单独编写，与真实 Git 命令行工具进行对比验证。
