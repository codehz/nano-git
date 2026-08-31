/**
 * Pack 能力相关的纯类型定义
 *
 * 本模块不导入任何 pack 运行时实现，适合作为 backend 与 repository 的类型边界。
 */

import type { ObjectSource } from "../odb/types.ts";
import type { RawGitObject, SHA1 } from "../types/index.ts";
import type { PackBuildResult } from "./builder/pack-builder-types.ts";

/** Packfile 构建器接口 */
export interface PackBuilder {
  /** 获取已添加的对象数量 */
  readonly objectCount: number;

  /** 添加一个原始 Git 对象 */
  addRaw(raw: RawGitObject): SHA1;

  /** 构建 packfile 和索引文件 */
  build(): PackBuildResult;
}

/** Packfile 中的对象信息 */
export type { PackObject } from "./reader/pack-reader-types.ts";

/** Packfile 索引中的对象条目 */
export type { PackIndexEntry } from "./idx/pack-index-types.ts";

/** Packfile 构建结果 */
export type { PackBuildResult } from "./builder/pack-builder-types.ts";

/** 已发现的 pack 文件信息 */
export interface PackFileInfo {
  /** pack 文件校验和 */
  checksum: string;
  /** .pack 文件路径 */
  packPath: string;
  /** .idx 文件路径 */
  idxPath: string;
  /** 索引中的对象数量 */
  objectCount: number;
}

/** Pack 对象源的公共能力 */
export interface PackObjectSource extends ObjectSource {
  /** 刷新 pack 目录缓存 */
  refresh(): void;

  /** 列出当前可见的 pack 文件 */
  listPacks(): PackFileInfo[];

  /** 列出所有 pack 中的对象哈希 */
  listHashes(): SHA1[];

  /** 获取 packfile 数量 */
  readonly packCount: number;

  /** 获取所有对象数量 */
  readonly objectCount: number;
}

/** 仓库级 repack 选项 */
export interface RepositoryRepackOptions {
  /** 要打包的对象列表，默认使用 source.list() 的全部对象 */
  readonly hashes?: Iterable<SHA1>;

  /** 是否在成功写入新 pack 后删除旧 pack，默认 true */
  readonly replaceExistingPacks?: boolean;

  /** 是否删除已写入 pack 的 loose object，默认 false */
  readonly pruneLoose?: boolean;
}

/** Packfile 层 repack 选项 */
export interface PackRepackOptions {
  /** 要打包的对象列表，默认使用 source.list() 的全部对象 */
  readonly hashes?: Iterable<SHA1>;

  /** 是否在成功写入新 pack 后删除旧 pack，默认 true */
  readonly replaceExistingPacks?: boolean;
}
