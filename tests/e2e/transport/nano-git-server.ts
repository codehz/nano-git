/**
 * Smart HTTP 服务端端到端测试辅助函数
 *
 * 使用 createSmartHttpHandler + Bun.serve 启动一个真实的 HTTP 服务，
 * 供 e2e 测试使用（git CLI 和 nano-git 客户端）。
 */

import { createMemoryRepositoryBackend } from "@/backend/index.ts";
import { writeObject } from "@/objects/raw.ts";
import { createSmartHttpHandler } from "@/transport/http/smart-http.ts";

import type { RepositoryBackend } from "@/backend/types.ts";

// ============================================================================
// 测试服务句柄
// ============================================================================

export interface NanoGitServer {
  /** 服务器 base URL */
  url: string;
  /** 后端引用（测试可直接操作） */
  backend: RepositoryBackend;
  /** 停止服务 */
  stop(): void;
}

/**
 * 使用 createSmartHttpHandler 启动测试服务
 *
 * @param backend - 可选的仓库后端（不提供时创建默认内存仓库）
 * @returns 测试服务句柄
 *
 * @example
 * ```ts
 * const server = startNanoGitServer();
 * // 使用 server.url 连接
 * server.stop();
 * ```
 */
export function startNanoGitServer(backend?: RepositoryBackend): NanoGitServer {
  const b = backend ?? createDefaultBackend();
  const handler = createSmartHttpHandler(b);

  const bunServer = Bun.serve({ port: 0, fetch: handler });
  bunServer.unref();

  const { port } = bunServer;

  return {
    url: `http://localhost:${port}`,
    backend: b,
    stop() {
      bunServer.stop(true).catch(() => {});
    },
  };
}

/**
 * 创建默认的测试仓库后端
 *
 * 包含一个分支和一个初始提交。
 *
 * @returns 已填充数据的后端
 */
export function createDefaultBackend(): RepositoryBackend {
  const backend = createMemoryRepositoryBackend({
    initialRefs: new Map<string, string>([["HEAD", "ref: refs/heads/main"]]),
  });

  const blobHash = writeObject(backend.objects, {
    type: "blob" as const,
    content: Buffer.from("nano-git e2e test\n"),
  });
  const treeHash = writeObject(backend.objects, {
    type: "tree" as const,
    entries: [{ mode: "100644", name: "README.txt", hash: blobHash }],
  });
  const commitHash = writeObject(backend.objects, {
    type: "commit" as const,
    tree: treeHash,
    parents: [],
    author: { name: "E2E", email: "e2e@test", timestamp: 2000000000, timezone: "+0000" },
    committer: { name: "E2E", email: "e2e@test", timestamp: 2000000000, timezone: "+0000" },
    message: "Initial commit\n",
  });
  backend.refs.write("refs/heads/main", commitHash);

  return backend;
}
