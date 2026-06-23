/**
 * 仓库后端接口定义
 *
 * Repository 本身只负责高层 Git 语义，
 * 底层对象存储、引用存储和仓库布局信息通过 Backend 注入。
 */

import type { GitObject, SHA1 } from "../../core/types.ts";
import type { PackBuildResult } from "../../odb/pack/pack-builder.ts";
import type { PackBuilder } from "../../odb/pack/pack-builder.ts";
import type { PackObjectStore } from "../../odb/pack/pack-store.ts";
import type { ObjectSource, ObjectStore } from "../../odb/types.ts";
import type { RefStore, RefTransactionHook } from "../../refs/types.ts";
import type { ShallowStore } from "../../shallow/types.ts";

/** 仓库级 repack 选项 */
export interface RepositoryRepackOptions {
  /** 要打包的对象列表，默认使用 source.list() 的全部对象 */
  readonly hashes?: Iterable<SHA1>;

  /** 是否在成功写入新 pack 后删除旧 pack，默认 true */
  readonly replaceExistingPacks?: boolean;

  /**
   * 是否删除已写入 pack 的 loose object 文件，默认 false
   *
   * 此选项由仓库层（RepositoryMaintenanceOperations）处理，
   * RepositoryPackSupport 自身不处理 loose 对象删除。
   */
  readonly pruneLoose?: boolean;
}

/** 仓库级 gc 选项 */
export interface RepositoryGCOptions {
  /** 是否删除不可达的 loose objects，默认 true */
  readonly pruneLoose?: boolean;

  /** 是否替换旧 pack 文件，默认 true */
  readonly replaceExistingPacks?: boolean;
}

/**
 * Packfile 层 repack 选项
 *
 * RepositoryPackSupport.repack() 的内部选项，
 * 不包含 pruneLoose——那是仓库层的职责。
 */
export interface PackRepackOptions {
  /** 要打包的对象列表，默认使用 source.list() 的全部对象 */
  readonly hashes?: Iterable<SHA1>;

  /** 是否在成功写入新 pack 后删除旧 pack，默认 true */
  readonly replaceExistingPacks?: boolean;
}

/**
 * 仓库 pack 支持接口
 *
 * 负责：
 * - 暴露已存在的 pack 对象源
 * - 创建新的 packfile
 *
 * GC 的编排逻辑（计算可达对象、删除不可达 loose 对象）不在本接口职责范围内，
 * 请使用仓库层的 RepositoryMaintenanceOperations.gc()。
 */
export interface RepositoryPackSupport {
  /** 仅包含 packfile 中对象的只读对象源 */
  readonly source: PackObjectStore;

  /** 创建底层 PackBuilder */
  createBuilder(): PackBuilder;

  /** 将给定对象集合写入新的 packfile */
  writeObjects(objects: Iterable<GitObject>): PackBuildResult;

  /** 从对象源中读取指定对象并写入新的 packfile */
  writeFromSource(source: ObjectSource, hashes: Iterable<SHA1>): PackBuildResult;

  /** 执行仓库级 repack */
  repack(source: ObjectSource, options?: PackRepackOptions): PackBuildResult;
}

/**
 * 仓库后端接口
 *
 * 聚合 Repository 所需的底层依赖：
 * - objects: Git 对象存储
 * - refs: Git 引用存储
 * - shallow: Git shallow 边界存储
 * - packs: Packfile 读写支持（可选）
 * - gitDir: .git 目录路径（内存仓库为 null）
 */
export interface RepositoryBackend {
  /** Git 对象存储 */
  readonly objects: ObjectStore;

  /** Git 引用存储 */
  readonly refs: RefStore;

  /** Git shallow 边界存储 */
  readonly shallow: ShallowStore;

  /** Packfile 支持（内存仓库等后端可为 null） */
  readonly packs: RepositoryPackSupport | null;

  /** .git 目录路径（内存仓库为 null） */
  readonly gitDir: string | null;

  /** Reference transaction hooks（可选） */
  readonly refTransactionHooks?: RefTransactionHook[];
}
