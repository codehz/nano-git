/**
 * 远端来源类型定义
 *
 * 只描述"从哪里读"，不描述"写到哪里"。
 * 可被远端查询 API 与仓库导入 API 共同复用。
 */

/**
 * HTTP Basic 认证凭据
 *
 * Git Smart HTTP 使用标准 Basic 认证（`username:password`）。
 * 对 GitHub PAT，调用方自行填写，例如
 * `{ username: "x-access-token", password: "ghp_..." }`。
 */
export interface HttpAuth {
  /** 用户名 */
  readonly username: string;
  /** 密码或访问令牌 */
  readonly password: string;
}

/**
 * 远端 Git 数据来源
 */
export interface RemoteSource {
  /** 远端仓库 URL */
  readonly url: string;

  /**
   * HTTP Basic 认证凭据，透传给 transport。
   * 若同时提供 headers.Authorization，auth 优先生效。
   */
  readonly auth?: HttpAuth;

  /** 自定义请求头 */
  readonly headers?: Record<string, string>;
}
