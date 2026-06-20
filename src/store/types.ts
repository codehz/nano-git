/**
 * 对象读取接口与对象存储接口定义
 *
 * ObjectSource 表示只读对象源，
 * ObjectStore 在其基础上增加写入能力。
 *
 * 扩展点：
 * - packfile、远程镜像等只读后端实现 ObjectSource
 * - loose object、内存存储等可写后端实现 ObjectStore
 */

import type { GitObject, SHA1 } from "../types.ts";

/**
 * 对象读取接口
 *
 * 提供 Git 对象的读取能力。
 */
export interface ObjectSource {
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

/**
 * 对象存储接口
 *
 * 在 ObjectSource 的基础上增加写入能力。
 */
export interface ObjectStore extends ObjectSource {
  /**
   * 写入对象并返回其 SHA-1 哈希
   *
   * 如果对象已存在，则跳过写入（Git 的内容寻址特性）。
   */
  write(obj: GitObject): SHA1;
}
