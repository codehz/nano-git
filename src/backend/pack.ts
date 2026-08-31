/**
 * Pack 仓库后端能力
 *
 * 只依赖纯 Pack 类型，不加载 builder、store 或 MIDX 文件实现。
 */

import type { ObjectSource } from "../odb/types.ts";
import type {
  PackBuildResult,
  PackBuilder,
  PackObjectSource,
  PackRepackOptions,
} from "../pack/types.ts";
import type { RawGitObject, SHA1 } from "../types/index.ts";
import type { RepositoryBackend } from "./types.ts";

/** Packfile 仓库后端能力 */
export interface RepositoryPackBackend extends RepositoryBackend {
  /** Pack 对象源与写入能力 */
  readonly packs: RepositoryPackSupport;
}

/** Packfile 支持接口 */
export interface RepositoryPackSupport {
  /** 仅包含 packfile 中对象的只读对象源 */
  readonly source: PackObjectSource;

  /** 创建底层 PackBuilder */
  createBuilder(): PackBuilder;

  /** 将给定原始对象集合写入新的 packfile */
  writeRawObjects(objects: Iterable<RawGitObject>): PackBuildResult;

  /** 从对象源中读取指定对象并写入新的 packfile */
  writeFromSource(source: ObjectSource, hashes: Iterable<SHA1>): PackBuildResult;

  /** 执行 packfile 层 repack */
  repack(source: ObjectSource, options?: PackRepackOptions): PackBuildResult;
}

export type {
  PackBuildResult,
  PackBuilder,
  PackFileInfo,
  PackObject,
  PackObjectSource,
  PackRepackOptions,
  RepositoryRepackOptions,
} from "../pack/types.ts";
