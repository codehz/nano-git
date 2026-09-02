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

import { concatBytes, toUint8Array } from "../../../bytes.ts";
import { GitError } from "../../../errors.ts";
import { encodeDelimiterPkt, encodeFlushPkt, encodePktLine } from "../../protocol/pkt-line.ts";
import { buildGitHttpAuthHeader } from "../http-auth.ts";
import { parseV2CapabilityAdvertisement } from "./capability-advertisement.ts";

import type { GitErrorOptions } from "../../../errors.ts";
import type { HttpAuth } from "../../../remote/types.ts";
import type { V2CapabilityAdvertisement, V2GitServiceTransport } from "./types.ts";

// ============================================================================
// 错误类型
// ============================================================================

/**
 * v2 HTTP 传输错误选项
 */
export interface V2SmartHttpErrorOptions extends GitErrorOptions {
  readonly statusCode?: number;
  readonly url?: string;
}

/**
 * v2 HTTP 传输错误
 *
 * @example
 * ```ts
 * throw new V2SmartHttpError("advertise failed", { statusCode: 503, url });
 * ```
 */
export class V2SmartHttpError extends GitError {
  readonly statusCode?: number;
  readonly url?: string;

  constructor(message: string, options?: V2SmartHttpErrorOptions) {
    super(`v2 smart-http error: ${message}`, options);
    this.name = "V2SmartHttpError";
    this.statusCode = options?.statusCode;
    this.url = options?.url;
  }
}

// ============================================================================
// HTTP 端点常量
// ============================================================================

/** v2 advertise 路径（与 v1 相同，但增加 Git-Protocol 头） */
const ADVERTISE_PATH = "/info/refs";

/** v2 命令执行路径 */
const COMMAND_PATH = "/git-upload-pack";

/** v2 命令请求中的 agent 标识 */
const CLIENT_AGENT = "nano-git/0.1";

/** nano-git 当前仅支持 SHA-1 对象格式 */
const CLIENT_OBJECT_FORMAT = "sha1";

/** info/refs 广告期望的 Content-Type 片段 */
const ADVERTISE_CONTENT_TYPE = "application/x-git-upload-pack-advertisement";

/** command 请求 Content-Type */
const COMMAND_CONTENT_TYPE = "application/x-git-upload-pack-request";

/** command 响应 Accept */
const COMMAND_ACCEPT = "application/x-git-upload-pack-result";

// ============================================================================
// 请求头构建
// ============================================================================

/**
 * 构建公共 HTTP 头
 *
 * 顺序：User-Agent → 用户 headers → auth Authorization → 强制 Git-Protocol。
 * `Git-Protocol: version=2` 始终写在最后，避免被 options.headers 覆盖导致 v0 回落。
 */
function buildCommonHeaders(options?: {
  auth?: HttpAuth;
  headers?: Record<string, string>;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "nano-git/0.1",
    ...options?.headers,
  };

  // Git Smart HTTP 使用标准 Basic 认证；若与 headers.Authorization 并存，auth 优先
  if (options?.auth) {
    headers.Authorization = buildGitHttpAuthHeader(options.auth.username, options.auth.password);
  }

  // 强制 v2 协商头（必须在用户 headers 之后）
  headers["Git-Protocol"] = "version=2";
  return headers;
}

/**
 * advertise（GET info/refs）专用头：不带 Content-Type，Accept 为 advertisement
 */
function buildAdvertiseHeaders(options?: {
  auth?: HttpAuth;
  headers?: Record<string, string>;
}): Record<string, string> {
  const headers: Record<string, string> = {
    ...buildCommonHeaders(options),
    Accept: ADVERTISE_CONTENT_TYPE,
  };
  // GET info/refs 不应携带 Content-Type（即使用户 headers 里写了也剔除）
  delete headers["Content-Type"];
  delete headers["content-type"];
  return headers;
}

/**
 * command（POST git-upload-pack）专用头
 */
function buildCommandHeaders(options?: {
  auth?: HttpAuth;
  headers?: Record<string, string>;
}): Record<string, string> {
  return {
    ...buildCommonHeaders(options),
    "Content-Type": COMMAND_CONTENT_TYPE,
    Accept: COMMAND_ACCEPT,
  };
}

/**
 * 校验响应 Content-Type 是否包含期望片段
 */
function assertContentType(actual: string, expected: string, context: string): void {
  if (!actual.includes(expected)) {
    throw new V2SmartHttpError(
      `Unexpected content type: ${actual || "(missing)"} (expected ${expected}) (${context})`,
      { url: context },
    );
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 v2 HTTP 传输适配器
 *
 * @param url - 远端仓库 URL
 * @param options - 可选认证选项
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
  options?: { auth?: HttpAuth; headers?: Record<string, string> },
): V2GitServiceTransport {
  const baseUrl = url.replace(/\/$/, "");
  let cachedAdvertisement: V2CapabilityAdvertisement | undefined;
  let advertisePromise: Promise<V2CapabilityAdvertisement> | undefined;

  async function advertiseOnce(): Promise<V2CapabilityAdvertisement> {
    if (cachedAdvertisement) {
      return cachedAdvertisement;
    }

    advertisePromise ??= (async () => {
      const advertiseUrl = `${baseUrl}${ADVERTISE_PATH}?service=git-upload-pack`;
      let response: Response;
      try {
        response = await fetch(advertiseUrl, {
          headers: buildAdvertiseHeaders(options),
        });
      } catch (err: unknown) {
        throw new V2SmartHttpError(`advertise failed: network error`, {
          cause: err,
          url: advertiseUrl,
        });
      }

      if (!response.ok) {
        throw new V2SmartHttpError(`advertise failed: ${response.status} ${response.statusText}`, {
          statusCode: response.status,
          url: advertiseUrl,
        });
      }

      const contentType = response.headers.get("content-type") ?? "";
      assertContentType(contentType, ADVERTISE_CONTENT_TYPE, advertiseUrl);

      const data = toUint8Array(await response.arrayBuffer());
      cachedAdvertisement = parseV2CapabilityAdvertisement(data);
      return cachedAdvertisement;
    })().finally(() => {
      advertisePromise = undefined;
    });

    return advertisePromise;
  }

  return {
    async advertise(): Promise<V2CapabilityAdvertisement> {
      return advertiseOnce();
    },

    async command(
      command: string,
      args?: string[],
      capabilities?: string[],
      body?: Uint8Array,
    ): Promise<Uint8Array> {
      await advertiseOnce();

      const lines: Uint8Array[] = [];
      const advertisedObjectFormat = cachedAdvertisement?.capabilities["object-format"];
      const autoCapabilities: string[] = [];

      if (cachedAdvertisement?.agent && capabilities?.includes(`agent=${CLIENT_AGENT}`) !== true) {
        autoCapabilities.push(`agent=${CLIENT_AGENT}`);
      }

      if (
        advertisedObjectFormat === CLIENT_OBJECT_FORMAT &&
        capabilities?.includes(`object-format=${CLIENT_OBJECT_FORMAT}`) !== true
      ) {
        autoCapabilities.push(`object-format=${CLIENT_OBJECT_FORMAT}`);
      }

      // command=<name>\n (pkt-line 编码)
      lines.push(encodePktLine(`command=${command}\n`));

      // capability-list (pkt-line 编码)
      for (const cap of autoCapabilities) {
        lines.push(encodePktLine(`${cap}\n`));
      }
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

      const requestBody = concatBytes(...lines);

      const commandUrl = `${baseUrl}${COMMAND_PATH}`;
      let response: Response;
      try {
        response = await fetch(commandUrl, {
          method: "POST",
          headers: buildCommandHeaders(options),
          body: requestBody,
        });
      } catch (err: unknown) {
        throw new V2SmartHttpError(`command "${command}" failed: network error`, {
          cause: err,
          url: commandUrl,
        });
      }

      if (!response.ok) {
        throw new V2SmartHttpError(
          `command "${command}" failed: ${response.status} ${response.statusText}`,
          { statusCode: response.status, url: commandUrl },
        );
      }

      return toUint8Array(await response.arrayBuffer());
    },
  };
}
