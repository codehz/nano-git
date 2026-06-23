/**
 * ShallowStore 接口定义
 *
 * 提供 Git shallow 边界（浅仓库状态）的持久化存储能力。
 * 所有存储实现（文件系统、内存等）都遵循此接口。
 *
 * Shallow 边界指浅仓库中截断历史的位置——commit 的 parent 在本地缺失
 * 但已知是正常状态而非损坏。
 *
 * 扩展点：添加新存储后端时，只需实现此接口即可无缝集成。
 */

import type { SHA1 } from "../types.ts";

/**
 * Shallow 边界更新
 *
 * 表示一次 fetch 操作中 shallow 边界集合的增减变化。
 */
export interface ShallowUpdate {
  /** 新增的 shallow 边界 commit 哈希列表 */
  readonly shallow: SHA1[];
  /** 从 shallow 边界移除的 commit 哈希列表（变为完整） */
  readonly unshallow: SHA1[];
}

/**
 * Shallow 存储接口
 *
 * 提供 Git shallow 边界集合的读写能力。
 */
export interface ShallowStore {
  /**
   * 读取当前 shallow 边界集合
   *
   * 返回当前仓库标记为 shallow 边界（即只拉取了部分历史）的 commit 哈希列表。
   * 非 shallow 仓库返回空数组。
   * 返回值为排序后的新数组副本，修改不影响内部状态。
   */
  read(): SHA1[];

  /**
   * 完全替换 shallow 边界集合
   *
   * 将 shallow 边界集合替换为给定列表。
   * 传空数组表示移除此仓库的 shallow 状态（转为完整仓库）。
   */
  write(boundaries: SHA1[]): void;

  /**
   * 增量更新 shallow 边界
   *
   * 根据 fetch 操作返回的 shallow/unshallow 信息，做集合变换：
   * - 加入 server 新返回的 shallow 边界
   * - 删除 server 返回的 unshallow 边界
   */
  applyUpdate(update: ShallowUpdate): void;

  /**
   * 判断指定哈希是否为 shallow boundary commit
   *
   * 若哈希在当前 shallow 边界集合中返回 true，否则返回 false。
   */
  isShallow(hash: SHA1): boolean;
}
