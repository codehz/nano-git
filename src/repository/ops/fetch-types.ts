/**
 * 仓库 fetch 操作类型定义
 *
 * repository 层只保留显式 URL 的 fetch 入口。
 * fetch 语义对标 `git fetch <url>`，是 ImportSession 的善意封装。
 */

import type { SHA1 } from "../../core/types.ts";

/**
 * 仓库 fetch 操作选项
 */
export interface RepositoryFetchOptions {
  /**
   * RefSpec 列表，格式如 "refs/heads/main:refs/heads/main"
   * 传入后完全取代默认映射（远端所有 branches → refs/heads/* + tags → refs/tags/*）。
   */
  readonly refSpecs?: string[];

  /**
   * 仅 fetch 匹配指定 glob 模式的远端 refs（如 "refs/heads/feature/*"），
   * 不 fetch 全部。不可与 refSpecs 同时使用。
   */
  readonly refPatterns?: string[];

  /** 认证 token（用于 bearer 或 basic auth） */
  readonly token?: string;

  /** 自定义请求头 */
  readonly headers?: Record<string, string>;

  /** 不自动 fetch 远端 tags（对标 `git fetch --no-tags`） */
  readonly noTags?: boolean;

  /** 删除本地有但远端已不存在的 refs（对标 `git fetch --prune`） */
  readonly prune?: boolean;

  /** 强制更新（对标 `git fetch --force`，等价于所有 refspec 加 + 前缀） */
  readonly force?: boolean;

  /** 浅 fetch 深度（⚠️ ImportSession 当前不支持，传此值会静默忽略） */
  readonly depth?: number;
}

/**
 * 单条引用更新结果
 */
export interface FetchRefUpdateResult {
  /** 引用名称，如 "refs/heads/main" */
  readonly refName: string;
  /** 更新前的哈希 */
  readonly oldHash: SHA1 | null;
  /** 更新后的哈希 */
  readonly newHash: SHA1 | null;
  /** 是否成功 */
  readonly success: boolean;
  /** 是否强制更新 */
  readonly forced: boolean;
  /** 失败时的错误消息 */
  readonly error?: string;
}

/**
 * 仓库 fetch 操作结果
 */
export interface RepositoryFetchResult {
  /** 已更新的引用列表 */
  readonly updatedRefs: readonly FetchRefUpdateResult[];
  /** 导入的对象数量 */
  readonly objectCount: number;
  /** 服务端返回的进度消息 */
  readonly progress: readonly string[];
}

/**
 * 仓库 fetch 操作接口
 */
export interface RepositoryFetchOperations {
  /**
   * 从远端仓库拉取 refs 和对象
   *
   * 等价于 `git fetch <url>`。
   * 默认行为：拉取所有远端分支（fast-forward）+ 标签 + 设置 HEAD。
   *
   * @param url - 远端仓库 URL
   * @param options - 可选参数
   * @returns fetch 结果
   *
   * @example
   * ```ts
   * const result = await repo.fetch("https://github.com/user/repo.git");
   * console.log(`Updated ${result.updatedRefs.length} refs`);
   * ```
   */
  fetch(url: string, options?: RepositoryFetchOptions): Promise<RepositoryFetchResult>;
}
