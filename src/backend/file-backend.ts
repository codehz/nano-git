/**
 * 文件系统仓库后端兼容出口
 *
 * 具体实现已迁移到 `src/repository/backend/file-backend.ts`，
 * 当前文件只保留原有导入路径的兼容层。
 */

export {
  createFileRepositoryBackend,
  type CreateFileRepositoryBackendOptions,
} from "../repository/backend/file-backend.ts";
