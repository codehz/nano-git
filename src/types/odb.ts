/**
 * 对象源与对象数据库接口定义
 *
 * ObjectSource  表示只读对象源（packfile、远端镜像等）。
 * ObjectDatabase 在其基础上增加摄入和删除能力（loose object 等可写后端）。
 *
 * ODB 的真实边界是 RawGitObject，不是 GitObject。
 * 语义转换由上层 helper（src/objects/raw.ts）负责。
 *
 * 扩展点：
 * - packfile、远程镜像等只读后端实现 ObjectSource
 * - loose object、内存存储等可写后端实现 ObjectDatabase
 */

import type { RawGitObject, SHA1 } from "./index.ts";

/**
 * 只读对象源接口
 *
 * 提供 Git 原生原始对象的读取能力。
 */
export interface ObjectSource {
  /**
   * 读取原始对象
   *
   * @throws 如果对象不存在
   */
  read(hash: SHA1): RawGitObject;

  /**
   * 尝试读取原始对象，不存在时返回 undefined
   *
   * 相比 `read()` + `catch` 或 `exists()` + `read()` 模式，
   * `tryRead` 避免了双重查找开销（N+1 问题）。
   * 默认实现通过 `read()` + catch 回退，各后端可提供优化版本。
   */
  tryRead(hash: SHA1): RawGitObject | undefined;

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
 * 对象数据库接口
 *
 * 在 ObjectSource 的基础上增加摄入和删除能力。
 * 摄入 = 直接写入 canonical raw object，不做语义序列化。
 */
export interface ObjectDatabase extends ObjectSource {
  /**
   * 摄入一个原始对象
   *
   * 直接按 canonical raw object 写入存储，不做语义序列化。
   * 如果对象已存在则幂等跳过。
   */
  ingest(raw: RawGitObject): void;

  /**
   * 批量摄入原始对象
   *
   * 默认实现逐条调用 ingest()，各后端可提供批量优化版本。
   */
  ingestMany(objects: Iterable<RawGitObject>): void;

  /**
   * 删除指定对象
   *
   * 删除不存在的对象应静默成功（no-op）。
   *
   * @param hash - 要删除的对象哈希
   */
  delete(hash: SHA1): void;
}
