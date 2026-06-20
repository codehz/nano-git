/**
 * 仓库上下文类型定义
 */

import type { ObjectStore } from "../odb/index.ts";
import type { RefStore } from "../refs/index.ts";
import type { RepositoryBackend, RepositoryPackSupport } from "./backend/index.ts";

/**
 * 仓库上下文属性
 */
export interface RepositoryContext {
  /** 底层仓库后端 */
  readonly backend: RepositoryBackend;

  /** Git 对象存储 */
  readonly objects: ObjectStore;

  /** Git 引用存储 */
  readonly refs: RefStore;

  /** Packfile 支持 */
  readonly packs: RepositoryPackSupport | null;

  /** .git 目录路径（内存仓库为 null） */
  readonly gitDir: string | null;
}
