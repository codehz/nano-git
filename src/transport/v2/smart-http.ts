/**
 * v2 HTTP 传输适配器
 *
 * Git Wire 协议 v2 的 HTTP 传输层。
 * 负责构建 v2 命令式请求并发送到远端。
 *
 * v2 HTTP 传输流程：
 * 1. advertise() — 获取能力广告（含版本声明）
 * 2. command()  — 执行单个命令（ls-refs / fetch / push / object-info）
 *
 * @see https://git-scm.com/docs/protocol-v2#_initial_client_request
 */

import { encodeDelimiterPkt, encodeFlushPkt, encodePktLine } from "../shared/pkt-line.ts";
import { parseV2CapabilityAdvertisement } from "./capability-advert.ts";

import type { V2CapabilityAdvertisement, V2GitServiceTransport } from "./types.ts";

// ============================================================================
// 错误类型
// ============================================================================

/**
 * v2 HTTP 传输错误
 */
export class V2SmartHttpError extends Error {
  constructor(message: string) {
    super(`v2 smart-http error: ${message}`);
    this.name = "V2SmartHttpError";
  }
}

// ============================================================================
// HTTP 端点常量
// ============================================================================

/** v2 advertise 路径（与 v1 相同，但增加 Git-Protocol 头） */
const ADVERTISE_PATH = "/info/refs";

/** v2 命令执行路径 */
const COMMAND_PATH = "/git-upload-pack";

/** v2 receive-pack 命令执行路径 */
const RECEIVE_PACK_PATH = "/git-receive-pack";

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 v2 HTTP 传输适配器
 *
 * @param url - 远端仓库 URL
 * @param options - 可选认证选项
 * @param service - 服务类型（默认 git-upload-pack，push 应传 git-receive-pack）
 * @returns v2 传输接口
 *
 * @example
 * ```ts
 * const transport = createV2HttpTransport("https://github.com/user/repo");
 * const caps = await transport.advertise();
 * const refs = await transport.command("ls-refs", ["symrefs", "peel"]);
 * ```
 */
export function createV2HttpTransport(
  url: string,
  options?: { token?: string; headers?: Record<string, string> },
  service?: "git-upload-pack" | "git-receive-pack",
): V2GitServiceTransport {
  const svc = service ?? "git-upload-pack";
  const baseUrl = url.replace(/\/$/, "");

  const baseHeaders: Record<string, string> = {
    "User-Agent": "nano-git/0.1",
    "Content-Type": "application/x-git-upload-pack-request",
    Accept: "application/x-git-upload-pack-result",
    "Git-Protocol": "version=2",
    ...options?.headers,
  };

  if (options?.token) {
    baseHeaders.Authorization = `Bearer ${options.token}`;
  }

  const endpointPath = svc === "git-receive-pack" ? RECEIVE_PACK_PATH : COMMAND_PATH;

  return {
    async advertise(): Promise<V2CapabilityAdvertisement> {
      const query = `?service=${svc}`;
      const response = await fetch(`${baseUrl}${ADVERTISE_PATH}${query}`, { headers: baseHeaders });

      if (!response.ok) {
        throw new V2SmartHttpError(`advertise failed: ${response.status} ${response.statusText}`);
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
      const lines: Buffer[] = [];

      // command=<name>\n (pkt-line 编码)
      lines.push(encodePktLine(`command=${command}\n`));

      // capability-list (pkt-line 编码)
      if (capabilities) {
        for (const cap of capabilities) {
          lines.push(encodePktLine(`${cap}\n`));
        }
      }

      // delimiter (0001)
      lines.push(encodeDelimiterPkt());

      // command-args (pkt-line 编码)
      if (args) {
        for (const arg of args) {
          lines.push(encodePktLine(`${arg}\n`));
        }
      }

      // flush (0000)
      lines.push(encodeFlushPkt());

      // 附加 body（如 push 的 packfile）
      if (body) {
        lines.push(body);
      }

      const requestBody = Buffer.concat(lines);

      const response = await fetch(`${baseUrl}${endpointPath}`, {
        method: "POST",
        headers: baseHeaders,
        body: requestBody,
      });

      if (!response.ok) {
        throw new V2SmartHttpError(
          `command "${command}" failed: ${response.status} ${response.statusText}`,
        );
      }

      return Buffer.from(await response.arrayBuffer());
    },
  };
}
