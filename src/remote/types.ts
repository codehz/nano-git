/**
 * 远端来源类型定义
 *
 * 只描述"从哪里读"，不描述"写到哪里"。
 * 可被远端查询 API 与仓库导入 API 共同复用。
 */

/**
 * 远端 Git 数据来源
 */
export interface RemoteSource {
  /** 远端仓库 URL */
  readonly url: string;

  /** 认证 token（用于 bearer 或 basic auth） */
  readonly token?: string;

  /** 自定义请求头 */
  readonly headers?: Record<string, string>;
}
