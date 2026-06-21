/**
 * 传输层端到端测试共享辅助函数
 */

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { git, gitInit, createFile } from "../helpers.ts";
import { parsePktLines } from "@/transport/pkt-line.ts";

import type { GitHttpRequestRecord } from "./http-server.ts";

// ============================================================================
// 服务端仓库管理
// ============================================================================

export function enableReceivePack(repoDir: string): void {
  const configPath = join(repoDir, "config");
  const config = readFileSync(configPath, "utf-8");
  if (!config.includes("http.receivepack")) {
    writeFileSync(configPath, config + "\n[http]\n\treceivepack = true\n", "utf-8");
  }
}

/** 用系统 git 创建裸仓库并推送初始提交 */
export function createServerRepo(
  tempDir: string,
  name: string,
  enablePush = false,
): { repoDir: string; projectRoot: string; commitHash: string; workDir: string } {
  const repoDir = join(tempDir, name);
  const projectRoot = tempDir;
  const workDir = join(tempDir, "work-" + name);

  mkdirSync(repoDir);
  git(["init", "--bare"], repoDir);
  if (enablePush) {
    enableReceivePack(repoDir);
  }

  mkdirSync(workDir);
  gitInit(workDir);
  createFile(workDir, "README.md", "# Hello\n");
  git(["add", "README.md"], workDir);
  git(["commit", "-m", "Initial commit"], workDir);
  const commitHash = git(["rev-parse", "HEAD"], workDir);
  git(["push", repoDir, "main"], workDir);

  return { repoDir, projectRoot, commitHash, workDir };
}

// ============================================================================
// Upload-Pack 请求分析
// ============================================================================

/**
 * 解析 upload-pack 请求中的命令文本
 */
export function decodeUploadPackCommands(body: Buffer): string[] {
  return parsePktLines(body)
    .filter((line) => line.type === "data")
    .map((line) => line.payload.toString("utf-8").trimEnd());
}

/**
 * 统计 upload-pack 请求中的 flush 数量
 */
export function countFlushPackets(body: Buffer): number {
  return parsePktLines(body).filter((line) => line.type === "flush").length;
}

/**
 * 过滤服务端记录到的 upload-pack POST 请求
 */
export function getUploadPackRequests(requests: GitHttpRequestRecord[]): GitHttpRequestRecord[] {
  return requests.filter(
    (request) => request.method === "POST" && request.path.endsWith("/git-upload-pack"),
  );
}
