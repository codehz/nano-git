/**
 * 仓库后端类型兼容出口
 *
 * 具体实现已迁移到 `src/repository/backend/types.ts`，
 * 当前文件只保留原有导入路径的兼容层。
 */

export type {
  RepositoryBackend,
  RepositoryGCOptions,
  RepositoryPackSupport,
  RepositoryRepackOptions,
} from "../repository/backend/types.ts";
