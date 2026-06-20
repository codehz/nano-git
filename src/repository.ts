/**
 * Git 仓库模块兼容出口
 *
 * 具体实现已迁移到 `src/repository/` 目录下，
 * 当前文件只保留原有导入路径的兼容层。
 */

export type { Repository } from "./repository/index.ts";
export {
  createRepository,
  initRepository,
  openRepository,
  createMemoryRepository,
} from "./repository/index.ts";
