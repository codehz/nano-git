/**
 * CGI Transport — 通过 git http-backend CGI 实现 SmartHttpClient
 *
 * 不发起真实 HTTP 请求，而是通过 spawnSync 调用 git-http-backend CGI 程序。
 * 用于端到端测试，覆盖 push/fetch 的完整编排链路（refspec 解析、可达性
 * 遍历、packfile 构建、协议编解码），而无需启动 HTTP 服务器。
 *
 * @example
 * ```ts
 * const transport = createCgiTransport("/tmp/server.git", "/tmp");
 * const result = await push(repo.objects, repo.refs, "dummy", {
 *   refSpecs: [":refs/heads/feature"],
 *   transport,
 * });
 * ```
 */

import { spawnSync } from "node:child_process";
import { parseRefAdvertisement, RefAdvertisementError } from "./ref-advertisement.ts";
import { extractPackfile } from "./side-band.ts";
import { parsePktLines } from "./pkt-line.ts";
import type { PktLineData } from "./pkt-line.ts";
import { parseReceivePackResult, ReceivePackResultError } from "./receive-pack-result.ts";
import type { SmartHttpClient, UploadPackResult, ReceivePackHttpResult } from "./smart-http.ts";
import type { RefAdvertisement, PushRefUpdate } from "./types.ts";

// ============================================================================
// 常量
// ============================================================================

/** git http-backend 的默认路径 */
const DEFAULT_HTTP_BACKEND = "/usr/lib/git-core/git-http-backend";

/** CGI 环境变量（固定值） */
const CGI_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: "CGI Transport",
  GIT_AUTHOR_EMAIL: "cgi@nano-git.test",
  GIT_AUTHOR_DATE: "1700000000 +0800",
  GIT_COMMITTER_NAME: "CGI Transport",
  GIT_COMMITTER_EMAIL: "cgi@nano-git.test",
  GIT_COMMITTER_DATE: "1700000000 +0800",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_HTTP_EXPORT_ALL: "1",
  GIT_HTTP_MAX_REQUEST_BUFFER: "10M",
};

// ============================================================================
// CGI 响应类型
// ============================================================================

/** 调用 CGI 后的解析结果 */
interface CgiResponse {
  /** HTTP 状态码 */
  status: number;
  /** 响应头 */
  headers: Record<string, string>;
  /** 响应体（raw Buffer） */
  body: Buffer;
}

// ============================================================================
// CGI 调用函数
// ============================================================================

/**
 * 调用 git http-backend CGI
 *
 * @param httpBackend - git-http-backend 可执行文件路径
 * @param repoDir - 裸仓库目录
 * @param projectRoot - GIT_PROJECT_ROOT（repoDir 的父目录）
 * @param method - HTTP 方法（GET/POST）
 * @param pathInfo - PATH_INFO（如 /repo.git/git-receive-pack）
 * @param queryString - 可选的 QUERY_STRING
 * @param body - 可选的请求体（POST 时）
 * @returns 解析后的 CGI 响应
 */
function callGitHttpBackend(
  httpBackend: string,
  repoDir: string,
  projectRoot: string,
  method: string,
  pathInfo: string,
  queryString?: string,
  body?: Buffer,
): CgiResponse {
  const contentType =
    method === "POST"
      ? pathInfo.includes("git-receive-pack")
        ? "application/x-git-receive-pack-request"
        : "application/x-git-upload-pack-request"
      : "";

  const env: Record<string, string> = {
    ...CGI_ENV,
    REQUEST_METHOD: method,
    GIT_PROJECT_ROOT: projectRoot,
    PATH_INFO: pathInfo,
    CONTENT_TYPE: contentType,
    QUERY_STRING: queryString ?? "",
  };

  const result = spawnSync(httpBackend, [], {
    env: { ...process.env, ...env },
    input: body,
  });

  const stdout = result.stdout ?? Buffer.alloc(0);
  const stderr = result.stderr?.toString() ?? "";

  const headerEndIndex = stdout.indexOf("\r\n\r\n");
  if (headerEndIndex === -1) {
    throw new Error(
      `CGI output has no header/body separator\n` +
        `stdout: ${stdout.toString("utf-8").slice(0, 200)}\n` +
        `stderr: ${stderr}`,
    );
  }

  const headerSection = stdout.subarray(0, headerEndIndex).toString("utf-8");
  const bodyBuffer = stdout.subarray(headerEndIndex + 4);
  const headers: Record<string, string> = {};
  let status = 200;

  for (const line of headerSection.split("\r\n")) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) continue;
    if (trimmedLine.startsWith("Status: ")) {
      status = parseInt(trimmedLine.slice(8), 10);
      continue;
    }
    const colonIndex = trimmedLine.indexOf(": ");
    if (colonIndex !== -1) {
      headers[trimmedLine.slice(0, colonIndex)] = trimmedLine.slice(colonIndex + 2);
    }
  }

  return { status, headers, body: bodyBuffer };
}

// ============================================================================
// 响应体解析
// ============================================================================

/**
 * 从 CGI 响应体中解析 receive-pack 结果
 *
 * 处理 side-band 编码和非 side-band 编码两种情况。
 */
function parseCgiReceivePackResult(data: Buffer): {
  refUpdates: PushRefUpdate[];
  progress: string[];
} {
  let progress: string[] = [];
  let refUpdates: PushRefUpdate[] = [];

  try {
    const pktLines = parsePktLines(data);

    if (pktLines.length > 0 && pktLines[0]!.type === "data") {
      const firstPayload = (pktLines[0] as PktLineData).payload;
      if (
        firstPayload.length > 0 &&
        (firstPayload[0] === 0x01 || firstPayload[0] === 0x02 || firstPayload[0] === 0x03)
      ) {
        // Side-band 编码：将所有 channel 1 数据拼接，解析内部 report-status pkt-lines
        const channel1Chunks: Buffer[] = [];
        let unpackError: string | null = null;

        for (const line of pktLines) {
          if (line.type !== "data") continue;
          const payload = line.payload;
          if (payload.length < 2) continue;

          const channel = payload[0]!;
          const frameData = payload.subarray(1);

          if (channel === 0x01) {
            // Channel 1：可能包含 packfile 和/或 report-status（子 pkt-line 编码）
            // 先尝试直接解析 unpack 结果
            const frameText = frameData.toString("utf-8");
            const unpackMatch = frameText.match(/^[0-9a-fA-F]{4}unpack (.+)/);
            if (unpackMatch) {
              const result = unpackMatch[1]!.trimEnd();
              if (result !== "ok") {
                unpackError = result;
              }
            }
            channel1Chunks.push(frameData);
          } else if (channel === 0x02) {
            progress.push(frameData.toString("utf-8").trimEnd());
          } else if (channel === 0x03) {
            throw new Error(`Server reported error: ${frameData.toString("utf-8").trimEnd()}`);
          }
        }

        if (unpackError !== null) {
          throw new Error(`Server failed to unpack packfile: ${unpackError}`);
        }

        // 拼接所有 channel 1 数据作为 pkt-line 流解析
        if (channel1Chunks.length > 0) {
          const combined = Buffer.concat(channel1Chunks);
          refUpdates = parseReceivePackResult(combined);
        }
      } else {
        // 非 side-band：纯 pkt-line report-status
        refUpdates = parseReceivePackResult(data);
      }
    }
  } catch (err) {
    if (err instanceof ReceivePackResultError) {
      throw err;
    }
    throw err;
  }

  return { refUpdates, progress };
}

// ============================================================================
// 创建 CGI Transport
// ============================================================================

/**
 * 创建基于 CGI 的 Smart HTTP 客户端
 *
 * 通过 git http-backend CGI 程序实现 SmartHttpClient 接口，
 * 不发起真实 HTTP 请求。
 *
 * @param repoDir - 裸仓库目录路径（作为 PATH_TRANSLATED）
 * @param projectRoot - GIT_PROJECT_ROOT（repoDir 的父目录）
 * @param httpBackend - git-http-backend 可执行文件路径（默认 /usr/lib/git-core/git-http-backend）
 * @returns SmartHttpClient 实例
 */
export function createCgiTransport(
  repoDir: string,
  projectRoot: string,
  httpBackend?: string,
): SmartHttpClient {
  const backendPath = httpBackend ?? DEFAULT_HTTP_BACKEND;
  const repoName = repoDir.split("/").pop()!;

  return {
    async getRefAdvertisement(): Promise<RefAdvertisement> {
      const cgiResult = callGitHttpBackend(
        backendPath,
        repoDir,
        projectRoot,
        "GET",
        `/${repoName}/info/refs`,
        "service=git-upload-pack",
      );

      if (cgiResult.status !== 200) {
        throw new Error(`CGI getRefAdvertisement failed with status ${cgiResult.status}`);
      }

      try {
        return parseRefAdvertisement(cgiResult.body, "git-upload-pack");
      } catch (err) {
        if (err instanceof RefAdvertisementError) {
          throw err;
        }
        throw new Error(`Failed to parse ref advertisement: ${(err as Error).message}`);
      }
    },

    async postUploadPack(body: Buffer): Promise<UploadPackResult> {
      const cgiResult = callGitHttpBackend(
        backendPath,
        repoDir,
        projectRoot,
        "POST",
        `/${repoName}/git-upload-pack`,
        undefined,
        body,
      );

      if (cgiResult.status !== 200) {
        throw new Error(`CGI postUploadPack failed with status ${cgiResult.status}`);
      }

      const expectedType = "application/x-git-upload-pack-result";
      if ((cgiResult.headers["Content-Type"] ?? "").includes(expectedType)) {
        // 正常响应
      }

      const progress: string[] = [];
      let packfile: Buffer;

      const pktLines = parsePktLines(cgiResult.body);
      if (
        pktLines.length > 0 &&
        pktLines[0]!.type === "data" &&
        (pktLines[0] as PktLineData).payload[0] === 0x01
      ) {
        // Side-band 编码
        const packfileChunks: Buffer[] = [];
        for (const line of pktLines) {
          if (line.type !== "data") continue;
          const payload = line.payload;
          if (payload.length < 2) continue;
          const channel = payload[0]!;
          const frameData = payload.subarray(1);
          if (channel === 0x01) {
            packfileChunks.push(frameData);
          } else if (channel === 0x02) {
            progress.push(frameData.toString("utf-8").trimEnd());
          } else if (channel === 0x03) {
            throw new Error(`Server error: ${frameData.toString("utf-8").trimEnd()}`);
          }
        }
        packfile = Buffer.concat(packfileChunks);
      } else {
        packfile = extractPackfile(cgiResult.body);
      }

      return { packfile, progress };
    },

    async getReceivePackRefs(): Promise<RefAdvertisement> {
      const cgiResult = callGitHttpBackend(
        backendPath,
        repoDir,
        projectRoot,
        "GET",
        `/${repoName}/info/refs`,
        "service=git-receive-pack",
      );

      if (cgiResult.status !== 200) {
        throw new Error(`CGI getReceivePackRefs failed with status ${cgiResult.status}`);
      }

      try {
        return parseRefAdvertisement(cgiResult.body, "git-receive-pack");
      } catch (err) {
        if (err instanceof RefAdvertisementError) {
          throw err;
        }
        throw new Error(`Failed to parse receive-pack refs: ${(err as Error).message}`);
      }
    },

    async postReceivePack(body: Buffer): Promise<ReceivePackHttpResult> {
      const cgiResult = callGitHttpBackend(
        backendPath,
        repoDir,
        projectRoot,
        "POST",
        `/${repoName}/git-receive-pack`,
        undefined,
        body,
      );

      if (cgiResult.status !== 200) {
        throw new Error(`CGI postReceivePack failed with status ${cgiResult.status}`);
      }

      const expectedType = "application/x-git-receive-pack-result";
      if (!(cgiResult.headers["Content-Type"] ?? "").includes(expectedType)) {
        throw new Error(
          `Unexpected content type: ${cgiResult.headers["Content-Type"]} (expected ${expectedType})`,
        );
      }

      const { refUpdates, progress } = parseCgiReceivePackResult(cgiResult.body);

      return {
        data: cgiResult.body,
        refUpdates,
        progress,
      };
    },
  };
}
