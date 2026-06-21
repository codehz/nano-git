# AGENTS.md

## 项目概述

nano-git 是使用 TypeScript 实现的 Git 核心功能的项目，专注于**裸仓库（bare repository）** 操作与服务端场景，不涉及暂存区和工作目录管理。兼容 Git 底层数据结构和算法。运行时为 Bun。

## 常用命令

| 命令                       | 用途                          |
| -------------------------- | ----------------------------- |
| `bun install`              | 安装依赖                      |
| `bun run lint`             | 代码检查 (oxlint，含类型检查) |
| `bun run format`           | 格式化代码 (oxfmt)            |
| `bun run format:check`     | 检查格式是否正确              |
| `bun run examples/demo.ts` | 运行演示脚本                  |

## 测试规范

- **测试框架**：`bun:test`（`describe` / `test` / `expect`）
- **异步异常断言**：使用 `expect(promise).rejects.toBeInstanceOf(ErrorType)`，不要用 `await promise.catch(...)` + 单独的 `expect`

  ```typescript
  // ✓ 正确
  // 注意：请不要加入 await，bun:test 能正确解析异步错误，即使提前返回
  expect(pushPromise).rejects.toBeInstanceOf(PushError);

  // ✗ 冗长
  const caught: unknown = await pushPromise.catch((e: unknown) => e);
  expect(caught).toBeInstanceOf(PushError);
  ```

## 编码规范

- **语言**：所有注释、JSDoc、文档使用中文
- **类型安全**：`SHA1` 是 branded type（`string & { __brand: "SHA1" }`），使用 `sha1()` 辅助函数做运行时校验
- **导入风格**：使用 `node:` 协议导入内置模块，使用 `.ts` 扩展名（Bun 约定）
- **无 class**：全部使用工厂函数 + 对象字面量模式（`createXxx`）
- **同步 API**：文件系统操作全部使用同步版本（`readFileSync` 等）
- **错误处理**：直接 `throw new Error(...)` 带描述性消息
- **代码分区**：长文件使用 `// ====` 分隔符划分逻辑区块
- **JSDoc**：每个导出函数必须有 JSDoc，包含 `@example` 代码块

## 注意事项

- `tsconfig.json` 开启了 `strict`、`noUncheckedIndexedAccess`、`noImplicitOverride`，注意索引访问返回 `T | undefined`
- `index.ts` 应只做 re-export，不要在其中放实现代码
- Tree 目录 mode 使用 `"40000"`（无前导零），与 Git 实际行为一致
- `readRef` 的符号引用递归解析目前无循环检测，修改时注意
- Pre-commit hook 通过 husky + lint-staged 自动运行 oxlint 和 oxfmt
