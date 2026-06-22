# Implementation Plans

由 improve skill 于 2026-06-22 生成，基于 commit `0b84c60`。

## 执行顺序 & 状态

| Plan | Title                                      | Priority | Effort | Depends on | Status |
| ---- | ------------------------------------------ | -------- | ------ | ---------- | ------ |
| 001  | reachability.ts 递归遍历改为迭代           | P2       | S      | —          | DONE   |
| 002  | Pack 模块 class 改为工厂函数               | P3       | L      | —          | DONE   |
| 003  | fetch-pack.ts 核心传输协商逻辑补充单元测试 | P1       | M      | —          | TODO   |
| 004  | Transport 模块测试覆盖率补充               | P1       | M      | —          | TODO   |

## 依赖说明

各 Plan 之间无严格依赖。推荐执行顺序：001 → 003 → 004 → 002。

002（class 重构）涉及核心模块，建议在 003/004 提供充分的测试安全网后再执行。

## Findings considered and rejected

- **01-002 `createDelta` O(n²)**：用户未选择纳入计划。
- **01-006 file-store-utils 路径校验**：纵深防御项，用户未选择纳入计划。
