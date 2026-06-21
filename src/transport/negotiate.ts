/**
 * 请求生成（negotiate）
 *
 * 构造 Git upload-pack 请求 body。
 *
 * 协议 v1 的请求格式：
 *   want <hash> <capabilities>\n    （首行带 capabilities）
 *   want <hash>\n                    （后续 want）
 *   0000                             （flush）
 *   deepen <n>\n                     （可选，shallow fetch）
 *   0000                             （flush，如果有 deepen）
 *   have <hash>\n                    （批量，每批 ≤ 32 条后加 flush）
 *   done\n
 *
 * @see https://git-scm.com/docs/git-upload-pack#_request
 */

import { encodePktLine, encodeFlushPkt } from "./pkt-line.ts";
import type { SHA1 } from "../core/types.ts";
import type { ObjectStore } from "../odb/types.ts";

// ============================================================================
// 常量
// ============================================================================

/** 每批 have 的最大数量（Git 协议建议 ≤ 32） */
const MAX_HAVES_PER_BATCH = 32;

/** 遍历提交图时的最大深度限制 */
const MAX_HAVE_DEPTH = 65536;

// ============================================================================
// Have 收集（Consecutive 算法）
// ============================================================================

/**
 * 从起始哈希出发遍历 commit 图，收集所有可达 commit 哈希
 *
 * 沿 parent 链回溯，按提交时间戳从旧到新排序。
 * 这实现了 Consecutive 协商算法——发送完整的本地历史，
 * 让服务端能准确定位公共祖先，最小化增量传输。
 *
 * @param store - 对象存储
 * @param tips - 遍历起点（通常是本地远程跟踪 ref 的哈希）
 * @returns 按提交时间从旧到新排序的 commit 哈希列表
 *
 * @example
 * ```ts
 * const haves = collectHaveCommits(store, [localHash]);
 * // => [oldest_commit, ..., newest_commit]
 * ```
 */
export function collectHaveCommits(store: ObjectStore, tips: SHA1[]): SHA1[] {
  const seen = new Set<SHA1>();
  const commits: Array<{ hash: SHA1; timestamp: number }> = [];
  const queue: SHA1[] = [...tips];

  while (queue.length > 0) {
    const hash = queue.pop()!;
    if (seen.has(hash)) continue;
    if (seen.size >= MAX_HAVE_DEPTH) break;

    seen.add(hash);

    try {
      const obj = store.read(hash);
      if (obj.type !== "commit") continue;

      const commit = obj as import("../core/types.ts").GitCommit;
      commits.push({ hash, timestamp: commit.committer.timestamp });

      // 将父 commit 加入遍历队列
      for (const parentHash of commit.parents) {
        if (!seen.has(parentHash)) {
          queue.push(parentHash);
        }
      }
    } catch {
      // 对象不存在时跳过
      continue;
    }
  }

  // 按提交时间从旧到新排序（Consecutive 算法要求 oldest first）
  commits.sort((a, b) => a.timestamp - b.timestamp);
  return commits.map((c) => c.hash);
}

// ============================================================================
// 请求生成
// ============================================================================

/**
 * 构建 upload-pack 请求 body
 *
 * @param wants - 请求的 want 对象哈希列表（至少一个）
 * @param haves - 已有的 have 对象哈希列表（增量 fetch 时用）
 * @param capabilities - 能力列表（如 ["multi_ack", "side-band-64k", "ofs-delta"]）
 * @param depth - 可选 shallow clone 深度（设置后添加 deepen 命令）
 * @returns pkt-line 编码的请求 body Buffer
 *
 * @example
 * ```ts
 * // 初始 clone
 * const body = buildUploadPackRequest(
 *   [sha1("95d09f2b...")],
 *   [],
 *   ["multi_ack", "side-band-64k", "ofs-delta"],
 * );
 * // => "want 95d09f2b... multi_ack side-band-64k ofs-delta\n"
 * //   + "0000"
 * //   + "done\n"
 *
 * // Shallow clone
 * const shallow = buildUploadPackRequest(
 *   [sha1("95d09f2b...")],
 *   [],
 *   [],
 *   3,
 * );
 * // => "want 95d09f2b...\n"
 * //   + "0000"
 * //   + "deepen 3\n"
 * //   + "0000"
 * //   + "done\n"
 * ```
 */
export function buildUploadPackRequest(
  wants: SHA1[],
  haves: SHA1[],
  capabilities: string[],
  depth?: number,
): Buffer {
  if (wants.length === 0) {
    throw new Error("At least one want is required");
  }

  if (depth !== undefined && depth < 1) {
    throw new Error("Depth must be a positive integer");
  }

  const chunks: Buffer[] = [];

  // want 行：首行带 capabilities，后续不带
  for (let i = 0; i < wants.length; i++) {
    const hash = wants[i]!;
    if (i === 0 && capabilities.length > 0) {
      chunks.push(encodePktLine(`want ${hash} ${capabilities.join(" ")}\n`));
    } else {
      chunks.push(encodePktLine(`want ${hash}\n`));
    }
  }

  // want 后的 flush
  chunks.push(encodeFlushPkt());

  // deepen 命令（shallow fetch 时添加）
  if (depth !== undefined) {
    chunks.push(encodePktLine(`deepen ${depth}\n`));
    chunks.push(encodeFlushPkt());
  }

  // have 行：批量发送，每批 MAX_HAVES_PER_BATCH 条后加 flush
  for (let i = 0; i < haves.length; i++) {
    if (i > 0 && i % MAX_HAVES_PER_BATCH === 0) {
      chunks.push(encodeFlushPkt());
    }
    chunks.push(encodePktLine(`have ${haves[i]!}\n`));
  }

  // done 命令
  chunks.push(encodePktLine("done\n"));

  return Buffer.concat(chunks);
}
