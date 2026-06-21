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
import type { RefStore } from "../../refs/types.ts";

/** 仓库级 repack 选项 */
export interface RepositoryRepackOptions {
  /** 要打包的对象列表，默认使用 source.list() 的全部对象 */
  readonly hashes?: Iterable<SHA1>;

  /** 是否在成功写入新 pack 后删除旧 pack，默认 true */
  readonly replaceExistingPacks?: boolean;

  /** 是否删除已写入 pack 的 loose object 文件，默认 false */
  readonly pruneLoose?: boolean;
}

/** 仓库级 gc 选项 */
export interface RepositoryGCOptions {
  /** 是否删除已打包的 loose objects，默认 true */
  readonly pruneLoose?: boolean;

  /** 是否替换旧 pack 文件，默认 true */
  readonly replaceExistingPacks?: boolean;
}

/**
 * 仓库 pack 支持接口
 *
 * 负责：
 * - 暴露已存在的 pack 对象源
 * - 创建新的 packfile
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
  repack(source: ObjectSource, options?: RepositoryRepackOptions): PackBuildResult;

  /** 执行基于可达对象集合的 gc */
  gc(reachable: Iterable<SHA1>, options?: RepositoryGCOptions): PackBuildResult;
}

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
 * 仓库后端接口
 *
 * 聚合 Repository 所需的底层依赖：
 * - objects: Git 对象存储
 * - refs: Git 引用存储
 * - packs: Packfile 读写支持（可选）
 * - gitDir: .git 目录路径（内存仓库为 null）
 * - shallow: Shallow 边界状态读写
 */
export interface RepositoryBackend {
  /** Git 对象存储 */
  readonly objects: ObjectStore;

  /** Git 引用存储 */
  readonly refs: RefStore;

  /** Packfile 支持（内存仓库等后端可为 null） */
  readonly packs: RepositoryPackSupport | null;

  /** .git 目录路径（内存仓库为 null） */
  readonly gitDir: string | null;

  /**
   * 读取当前 shallow 边界集合
   *
   * 返回当前仓库标记为 shallow 边界（即只拉取了部分历史）的 commit 哈希列表。
   * 非 shallow 仓库返回空数组。
   */
  readShallow(): SHA1[];

  /**
   * 完全替换 shallow 边界集合
   *
   * 将 shallow 边界集合替换为给定列表。
   * 传空数组表示移除此仓库的 shallow 状态（转为完整仓库）。
   */
  writeShallow(boundaries: SHA1[]): void;

  /**
   * 增量更新 shallow 边界
   *
   * 根据 fetch 操作返回的 shallow/unshallow 信息，做集合变换：
   * - 加入 server 新返回的 shallow 边界
   * - 删除 server 返回的 unshallow 边界
   */
  applyShallowUpdate(update: ShallowUpdate): void;

  /**
   * 判断指定哈希是否为 shallow boundary commit
   *
   * 若哈希在当前 shallow 边界集合中返回 true，否则返回 false。
   */
  isShallowCommit(hash: SHA1): boolean;
}
