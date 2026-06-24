/**
 * nano-git/log - 提交日志遍历
 *
 * 提供程序化的 git-log 风格接口。
 *
 * ## 子路径入口
 *
 * | 入口 | 内容 | 依赖 |
 * |------|------|------|
 * | `nano-git/log` | 类型定义 + 遍历函数 | `node:crypto` |
 */

export { walkLogEntries } from "./walk.ts";
export type { LogEntry, LogWalkOptions, CommitWalkOrder } from "./types.ts";
