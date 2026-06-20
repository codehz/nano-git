/**
 * 对象存储接口定义
 *
 * 提供 Git 对象的持久化存储能力。
 * 所有存储实现（文件系统、内存等）都遵循此接口。
 *
 * 扩展点：添加新存储后端时（如 packfile、远程存储），
 * 只需实现此接口即可无缝集成。
 */

import type { GitObject, SHA1 } from "../types.ts";

/**
 * 对象存储接口
 *
 * 提供 Git 对象的持久化存储能力。
 * 默认实现基于文件系统（.git/objects/）。
 */
export interface ObjectStore {
  /**
   * 写入对象并返回其 SHA-1 哈希
   *
   * 如果对象已存在，则跳过写入（Git 的内容寻址特性）。
   */
  write(obj: GitObject): SHA1;

  /**
   * 读取对象
   *
   * @throws 如果对象不存在
   */
  read(hash: SHA1): GitObject;

  /**
   * 检查对象是否存在
   */
  exists(hash: SHA1): boolean;
}
