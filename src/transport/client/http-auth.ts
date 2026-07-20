/**
 * Git Smart HTTP 客户端认证辅助
 *
 * Git 托管平台（尤其 GitHub）对 smart HTTP 协议使用 Basic 认证，
 * 并在 401 时返回 `WWW-Authenticate: Basic realm="GitHub"`。
 * REST API 常用的 Bearer token 在此处会被拒绝。
 */

/**
 * 由 token 构造 Authorization 头值
 *
 * 使用 `x-access-token:<token>` 的 Basic 方案：
 * - GitHub 官方推荐的 PAT 用法
 * - 对多数兼容 Basic 的 Git 托管平台可用（token 作为 password）
 *
 * @param token - 访问令牌（如 GitHub PAT）
 * @returns 完整 Authorization 头值（含 "Basic " 前缀）
 *
 * @example
 * ```ts
 * headers.Authorization = buildGitHttpAuthHeader(token);
 * ```
 */
export function buildGitHttpAuthHeader(token: string): string {
  return `Basic ${Buffer.from(`x-access-token:${token}`, "utf-8").toString("base64")}`;
}
