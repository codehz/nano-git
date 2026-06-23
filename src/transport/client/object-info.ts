/**
 * v2 object-info 命令
 *
 * 在 Git Wire 协议 v2 中，object-info 命令用于批量查询对象信息（如 size），
 * 而不需要实际获取对象内容。主要用于 partial clone 场景。
 *
 * 请求格式：
 * ```
 * command=object-info\n
 * 0001
 * size\n
 * oid <oid1>\n
 * oid <oid2>\n
 * 0000
 * ```
 *
 * 响应格式：
 * ```
 * size\n
 * <oid1> <size1>\n
 * <oid2> <size2>\n
 * 0000
 * ```
 *
 * @see https://git-scm.com/docs/protocol-v2#_object_info
 */

import { GitError } from "../../core/errors.ts";
import { parsePktLines } from "../shared/pkt-line.ts";

import type { V2GitServiceTransport } from "./protocol-types.ts";

// ============================================================================
// 错误类型
// ============================================================================

/**
 * object-info 命令错误
 */
export class ObjectInfoError extends GitError {
  constructor(message: string) {
    super(`object-info error: ${message}`);
    this.name = "ObjectInfoError";
  }
}

// ============================================================================
// 类型
// ============================================================================

/**
 * object-info 查询结果条目
 */
export interface ObjectInfoResult {
  readonly oid: string;
  readonly size?: number;
}

/**
 * object-info 查询响应
 */
export interface ObjectInfoQueryResult {
  readonly attrs: string[];
  readonly objects: ObjectInfoResult[];
}

// ============================================================================
// object-info 命令
// ============================================================================

/**
 * 执行 object-info 命令
 *
 * 批量查询远端对象的元数据（如 size），无需下载对象内容。
 *
 * @param transport - v2 传输接口
 * @param oids - 要查询的 OID 列表
 * @returns 查询结果
 *
 * @example
 * ```ts
 * const result = await objectInfo(transport, [
 *   "95d09f2b10159347eece71399a7e2e907ea3df4f",
 * ]);
 * console.log(result.objects[0]?.size); // 文件大小（字节）
 * ```
 */
export async function objectInfo(
  transport: V2GitServiceTransport,
  oids: string[],
): Promise<ObjectInfoQueryResult> {
  if (oids.length === 0) {
    throw new ObjectInfoError("No OIDs specified for object-info");
  }

  // 构建 arguments
  const args: string[] = ["size"];
  for (const oid of oids) {
    args.push(`oid ${oid}`);
  }

  const response = await transport.command("object-info", args);

  return parseObjectInfoResponse(response);
}

// ============================================================================
// 响应解析
// ============================================================================

/**
 * 解析 object-info 响应
 *
 * 格式：
 * ```
 * size\n
 * <oid1> <size1>\n
 * <oid2> <size2>\n
 * 0000
 * ```
 *
 * @param data - 原始响应数据
 * @returns 解析后的查询结果
 *
 * @example
 * ```ts
 * const result = parseObjectInfoResponse(response);
 * console.log(result.attrs); // ["size"]
 * ```
 */
export function parseObjectInfoResponse(data: Buffer): ObjectInfoQueryResult {
  const pktLines = parsePktLines(data);
  const objects: ObjectInfoResult[] = [];
  let attrs: string[] = [];

  for (const line of pktLines) {
    if (line.type !== "data") continue;

    const text = line.payload.toString("utf-8").trim();
    if (text.length === 0) continue;

    // 第一行是 attrs（以空格分隔）
    if (attrs.length === 0) {
      attrs = text.split(" ");
      continue;
    }

    // 后续行：<oid> <size>
    const spaceIdx = text.indexOf(" ");
    if (spaceIdx === -1) {
      // 只有 oid，没有 size
      objects.push({ oid: text });
    } else {
      const oid = text.substring(0, spaceIdx);
      const sizeStr = text.substring(spaceIdx + 1).trim();
      objects.push({
        oid,
        size: parseInt(sizeStr, 10),
      });
    }
  }

  return { attrs, objects };
}
