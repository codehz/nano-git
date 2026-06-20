/**
 * 内存仓库后端兼容出口
 *
 * 具体实现已迁移到 `src/repository/backend/memory-backend.ts`，
 * 当前文件只保留原有导入路径的兼容层。
 */

export {
  createMemoryRepositoryBackend,
  type CreateMemoryRepositoryBackendOptions,
} from "../repository/backend/memory-backend.ts";
