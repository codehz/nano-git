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

import type { GitObject, SHA1 } from "../core/types.ts";

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

  /**
   * 列出当前对象源中的所有对象哈希
   */
  list(): SHA1[];
}

/**
 * 对象存储接口
 *
 * 在 ObjectSource 的基础上增加写入和删除能力。
 *
 * delete 是可选的（`?`）——只读后端、纯 pack 存储可以不实现。
 * 调用方应始终先检查 `store.delete` 再调用。
 */
export interface ObjectStore extends ObjectSource {
  /**
   * 写入对象并返回其 SHA-1 哈希
   *
   * 如果对象已存在，则跳过写入（Git 的内容寻址特性）。
   */
  write<const T extends GitObject>(obj: T): SHA1;

  /**
   * 删除指定对象
   *
   * 非所有后端都支持此操作。不支持时此属性为 undefined。
   * 删除不存在的对象应静默成功（no-op）。
   *
   * @param hash - 要删除的对象哈希
   */
  delete?(hash: SHA1): void;
}
