/**
 * v2 协议检测与自动协商
 *
 * 尝试使用 Git Wire 协议 v2 连接服务端，
 * 如不兼容则返回 null 供调用方回退到 v1。
 */

import { parsePktLines } from "../shared/pkt-line.ts";
import { parseV2CapabilityAdvertisement, V2CapabilityError } from "./capability-advert.ts";

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
): Promise<ProtocolDetectResult> {
  // 构建 advertise URL
  const baseUrl = url.replace(/\/$/, "");
  const advertiseUrl = `${baseUrl}/info/refs?service=git-upload-pack`;

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
  const firstPkt = parsePktLines(data.subarray(0, 32))[0];
  if (firstPkt?.type === "data" && firstPkt.payload.toString("utf-8").trim() === "version 2") {
    try {
      const capabilities = parseV2CapabilityAdvertisement(data);
      const transport = createV2Transport(url, options);
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
// v2 传输适配器
// ============================================================================

/**
 * 创建 v2 HTTP 传输适配器
 *
 * v2 使用相同的 HTTP 端点但不同的请求/响应格式。
 *
 * @param url - 远端仓库 URL
 * @param options - 可选认证选项
 * @returns v2 传输接口
 */
function createV2Transport(
  url: string,
  options?: { token?: string; headers?: Record<string, string> },
): V2GitServiceTransport {
  const baseUrl = url.replace(/\/$/, "");
  const commandUrl = `${baseUrl}/git-upload-pack`;

  const baseHeaders: Record<string, string> = {
    "User-Agent": "nano-git/0.1",
    "Content-Type": "application/x-git-upload-pack-request",
    Accept: "application/x-git-upload-pack-result",
    ...options?.headers,
  };

  if (options?.token) {
    baseHeaders.Authorization = `Bearer ${options.token}`;
  }

  return {
    async advertise(): Promise<V2CapabilityAdvertisement> {
      const headers: Record<string, string> = {
        ...baseHeaders,
        "Git-Protocol": "version=2",
      };

      const response = await fetch(`${baseUrl}/info/refs?service=git-upload-pack`, { headers });

      if (!response.ok) {
        throw new Error(`v2 advertise failed: ${response.status} ${response.statusText}`);
      }

      const data = Buffer.from(await response.arrayBuffer());
      return parseV2CapabilityAdvertisement(data);
    },

    async command(
      command: string,
      args?: string[],
      capabilities?: string[],
      body?: Buffer,
    ): Promise<Buffer> {
      // 构建 v2 命令请求体
      const lines: Buffer[] = [];

      // command=<name>\n
      lines.push(Buffer.from(`command=${command}\n`, "utf-8"));

      // capability-list（agent 等）
      const allCaps = [...(capabilities ?? [])];
      for (const cap of allCaps) {
        lines.push(Buffer.from(`${cap}\n`, "utf-8"));
      }

      // delimiter
      const { encodeDelimiterPkt } = await import("../shared/pkt-line.ts");
      lines.push(encodeDelimiterPkt());

      // command-args
      if (args) {
        for (const arg of args) {
          lines.push(Buffer.from(`${arg}\n`, "utf-8"));
        }
      }

      // flush
      const { encodeFlushPkt } = await import("../shared/pkt-line.ts");
      lines.push(encodeFlushPkt());

      // 附加 body（如 push 的 packfile）
      if (body) {
        lines.push(body);
      }

      const requestBody = Buffer.concat(lines);

      const response = await fetch(commandUrl, {
        method: "POST",
        headers: baseHeaders,
        body: requestBody,
      });

      if (!response.ok) {
        throw new Error(
          `v2 command "${command}" failed: ${response.status} ${response.statusText}`,
        );
      }

      return Buffer.from(await response.arrayBuffer());
    },
  };
}
