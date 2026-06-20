/**
 * Git 仓库高层 API 类型定义
 *
 * 组合仓库上下文、对象操作、引用操作与维护操作的总接口。
 *
 * 这些操作对应 git 的 plumbing 命令。
 */

import type { RepositoryContext } from "./context-types.ts";
import type { RepositoryMaintenanceOperations } from "./maintenance-types.ts";
import type { RepositoryObjectOperations } from "./object-types.ts";
import type { RepositoryRefOperations } from "./ref-types.ts";

/**
 * Git 仓库接口
 */
export interface Repository
  extends
    RepositoryContext,
    RepositoryObjectOperations,
    RepositoryRefOperations,
    RepositoryMaintenanceOperations {}
