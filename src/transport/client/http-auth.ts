/**
 * Git Smart HTTP 客户端认证辅助
 *
 * Git 托管平台对 smart HTTP 协议使用标准 Basic 认证
 *（`Authorization: Basic base64(username:password)`）。
 * REST API 常用的 Bearer token 在此处通常会被拒绝。
 */

/**
 * 由 username/password 构造 Authorization 头值
 *
 * 使用标准 Basic 方案：`Basic base64(username:password)`。
 *
 * @param username - 用户名（如 GitHub PAT 场景下的 `x-access-token`）
 * @param password - 密码或访问令牌
 * @returns 完整 Authorization 头值（含 "Basic " 前缀）
 *
 * @example
 * ```ts
 * headers.Authorization = buildGitHttpAuthHeader("x-access-token", token);
 * ```
 */
export function buildGitHttpAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf-8").toString("base64")}`;
}
