/**
 * v2 协议检测与自动协商
 *
 * 尝试使用 Git Wire 协议 v2 连接服务端，
 * 如不兼容则返回 null 供调用方回退到 v1。
 */

import { parseV2CapabilityAdvertisement, V2CapabilityError } from "./capability-advert.ts";
import { createV2HttpTransport } from "./smart-http.ts";

import type { V2CapabilityAdvertisement, V2GitServiceTransport } from "./types.ts";

// ============================================================================
// v2 检测
// ============================================================================

/**
 * v2 协议检测结果
 *
 * - protocol: "v1" 时表示服务端不支持 v2
 * - protocol: "v2" 时包含能力广告和传输接口
 */
export type ProtocolDetectResult =
  | { protocol: "v1" }
  | {
      protocol: "v2";
      capabilities: V2CapabilityAdvertisement;
      transport: V2GitServiceTransport;
    };

/**
 * 尝试检测远端是否支持 Git Wire 协议 v2
 *
 * 通过发送带有 `Git-Protocol: version=2` 头的请求，
 * 检查服务端响应是否为 `version 2` 开头。
 *
 * @param url - 远端仓库 URL
 * @param options - 可选认证选项
 * @param service - 服务类型（默认 git-upload-pack，push 应传 git-receive-pack）
 * @returns 协议检测结果
 *
 * @example
 * ```ts
 * const result = await detectProtocol("https://github.com/user/repo");
 * if (result.protocol === "v2") {
 *   console.log("Server supports v2:", result.capabilities.commands);
 * }
 * ```
 */
export async function detectProtocol(
  url: string,
  options?: { token?: string; headers?: Record<string, string> },
  service?: "git-upload-pack" | "git-receive-pack",
): Promise<ProtocolDetectResult> {
  const svc = service ?? "git-upload-pack";
  const baseUrl = url.replace(/\/$/, "");
  const advertiseUrl = `${baseUrl}/info/refs?service=${svc}`;

  const headers: Record<string, string> = {
    "Git-Protocol": "version=2",
    "User-Agent": "nano-git/0.1",
    ...options?.headers,
  };

  if (options?.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  let response: Response;
  try {
    response = await fetch(advertiseUrl, { headers });
  } catch {
    // 网络错误视为不支持 v2
    return { protocol: "v1" };
  }

  if (!response.ok) {
    return { protocol: "v1" };
  }

  const data = Buffer.from(await response.arrayBuffer());

  // 检查是否为 v2 响应：必须以 "000eversion 2\n" 开头
  const headerHex = data.subarray(0, 16).toString("utf-8");
  const isV2Response =
    /^000e/i.test(headerHex) && data.subarray(4, 14).toString("utf-8").trim() === "version 2";

  if (isV2Response) {
    try {
      const capabilities = parseV2CapabilityAdvertisement(data);
      const transport = createV2HttpTransport(url, options, svc);
      return { protocol: "v2", capabilities, transport };
    } catch (err) {
      if (err instanceof V2CapabilityError) {
        return { protocol: "v1" };
      }
      throw err;
    }
  }

  return { protocol: "v1" };
}

// ============================================================================
// v2 传输适配器（已移至 smart-http.ts）
// ============================================================================

export { createV2HttpTransport } from "./smart-http.ts";
