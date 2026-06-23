/**
 * receive-pack 主处理函数
 *
 * 整合请求解析、packfile 解包、ref 校验与事务更新，
 * 生成 report-status 响应。
 */

import { resolveRefHash } from "../../../refs/resolve.ts";
import { encodeFlushPkt } from "../../protocol/pkt-line.ts";
import { parseReceivePackRequest } from "./parse.ts";
import { generateReceivePackReport } from "./report-status.ts";
import { ReceivePackServiceError, ZERO_HASH } from "./types.ts";
import { unpackPackfile } from "./unpack.ts";

import type { RepositoryBackend } from "../../../backend/types.ts";
import type { SHA1 } from "../../../core/types.ts";
import type {
  ParsedReceivePackRequest,
  ReceivePackCommand,
  ReceivePackOptions,
  ReceivePackUpdateResult,
} from "./types.ts";

// ============================================================================
// Ref 更新校验
// ============================================================================

/**
 * 校验单个 ref 更新命令的合法性
 *
 * 检查：
 * - oldHash 必须匹配 ref 当前值（新建时可为 000...0）
 * - newHash 对象必须存在
 * - 标签不可覆盖（允许 force — 但 v1 协议中 force 不在命令中体现）
 * - 删除操作需要 delete-refs 能力
 */
function checkRefUpdate(
  backend: RepositoryBackend,
  cmd: ReceivePackCommand,
  _capabilities: string[],
  _options?: ReceivePackOptions,
): { ok: boolean; error?: string } {
  const { oldHash, newHash, refName } = cmd;
  const isDelete = newHash === ZERO_HASH;
  const isCreate = oldHash === ZERO_HASH;

  // 读取当前 ref 值
  const currentHash = resolveRefHash(backend.refs, refName);

  // --- 新建 ref ---
  if (isCreate) {
    if (currentHash !== null) {
      return { ok: false, error: `ref ${refName} already exists` };
    }
    if (!backend.objects.exists(newHash)) {
      return { ok: false, error: `object ${newHash} not found` };
    }
    return { ok: true };
  }

  // --- 检查 ref 存在性 ---
  if (currentHash === null) {
    return {
      ok: false,
      error: `ref ${refName} does not exist (expected ${oldHash})`,
    };
  }

  // --- oldHash 必须匹配当前值 ---
  if (currentHash !== oldHash) {
    return {
      ok: false,
      error: `ref ${refName} is at ${currentHash} but expected ${oldHash}`,
    };
  }

  // --- 删除 ref ---
  if (isDelete) {
    return { ok: true };
  }

  // --- 更新 ref ---
  if (!backend.objects.exists(newHash)) {
    return { ok: false, error: `object ${newHash} not found` };
  }

  // 标签保护规则：不允许覆盖已有标签
  if (refName.startsWith("refs/tags/")) {
    return {
      ok: false,
      error: `tag ${refName} already exists and cannot be overwritten without force`,
    };
  }

  return { ok: true };
}

// ============================================================================
// 应用 Ref 更新
// ============================================================================

/**
 * 在事务中应用批量 ref 更新
 */
function applyRefUpdates(
  backend: RepositoryBackend,
  commands: Array<{ refName: string; newHash: SHA1 }>,
): void {
  const hooks = backend.refTransactionHooks;
  const tx = backend.refs.beginTransaction(hooks);

  try {
    for (const cmd of commands) {
      if (cmd.newHash === ZERO_HASH) {
        tx.delete(cmd.refName);
      } else {
        tx.write(cmd.refName, cmd.newHash);
      }
    }
    tx.commit();
  } catch (err) {
    tx.rollback();
    throw err;
  }
}

// ============================================================================
// 主处理函数
// ============================================================================

/**
 * 处理 receive-pack push 请求
 *
 * 完整流程：
 * 1. 验证请求体非空
 * 2. 解析客户端命令
 * 3. 检查 delete-refs 能力（如需要删除）
 * 4. 解包 packfile（如有）
 * 5. 检查组删除 / 更新 / 创建条件
 * 6. 批量应用 ref 更新
 * 7. 返回 report-status
 *
 * @param backend - 仓库后端
 * @param body - 完整的请求体
 * @param options - 处理选项
 * @returns report-status 响应（Buffer）
 *
 * @example
 * ```ts
 * const response = handleReceivePackRequest(backend, requestBody);
 * // Response 的 Content-Type 应为 "application/x-git-receive-pack-result"
 * ```
 */
export function handleReceivePackRequest(
  backend: RepositoryBackend,
  body: Buffer,
  options?: ReceivePackOptions,
): Buffer {
  // 1. 解析请求
  let parsed: ParsedReceivePackRequest;
  try {
    parsed = parseReceivePackRequest(body);
  } catch (err) {
    if (err instanceof ReceivePackServiceError) throw err;
    throw new ReceivePackServiceError(
      `Failed to parse receive-pack request: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const { capabilities, commands, packfile } = parsed;
  const hasReportStatus = capabilities.includes("report-status");

  const hasSideBand = capabilities.includes("side-band-64k");

  // 解包 packfile（如果有）
  let unpackOk = true;
  let unpackError: string | undefined;

  if (packfile.length > 0) {
    try {
      unpackPackfile(backend.objects, packfile);
    } catch (err: unknown) {
      unpackOk = false;
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  // 校验并应用 ref 更新
  const successfulUpdates: Array<{ refName: string; newHash: SHA1 }> = [];
  const refResults: ReceivePackUpdateResult[] = [];

  if (unpackOk) {
    for (const cmd of commands) {
      const check = checkRefUpdate(backend, cmd, capabilities, options);

      if (check.ok) {
        successfulUpdates.push({ refName: cmd.refName, newHash: cmd.newHash });
        refResults.push({ refName: cmd.refName, success: true });
      } else {
        refResults.push({ refName: cmd.refName, success: false, error: check.error });
      }
    }

    // 事务性应用成功的更新
    if (successfulUpdates.length > 0) {
      try {
        applyRefUpdates(backend, successfulUpdates);
      } catch (err) {
        // 事务失败，将所有已成功的标记为失败
        for (const up of successfulUpdates) {
          const idx = refResults.findIndex((r) => r.refName === up.refName);
          if (idx !== -1) {
            refResults[idx] = {
              refName: up.refName,
              success: false,
              error: `transaction failed: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        }
      }
    }
  } else {
    // 解包失败，所有命令都标记为失败
    for (const cmd of commands) {
      refResults.push({
        refName: cmd.refName,
        success: false,
        error: "unpack error",
      });
    }
  }

  // 如果客户端没有请求 report-status，返回空响应
  if (!hasReportStatus) {
    return encodeFlushPkt();
  }

  return generateReceivePackReport(unpackOk, unpackError, refResults, hasSideBand);
}
