/**
 * push 请求规划
 *
 * refspec 归一化、能力校验、receive-pack 命令与请求 body 构造。
 */

import { sha1 } from "../core/types.ts";
import { PushError } from "./push-error.ts";
import { resolveDefaultRefSpec } from "./push-ref-plan.ts";
import { buildReceivePackRequest } from "./receive-pack-request.ts";
import { parseRefSpec } from "./refspec.ts";
import { extractCapabilities, PUSH_CAPABILITIES } from "./transport-capabilities.ts";

import type { RefStore } from "../refs/types.ts";
import type { PushRefItem } from "./push-ref-plan.ts";
import type { ReceivePackCommand } from "./receive-pack-request.ts";
import type { ParsedRefSpec } from "./refspec.ts";
import type { RefAdvertisement, PushOptions } from "./types.ts";

/** 零哈希（表示新建引用或删除引用） */
const ZERO_HASH = sha1("0000000000000000000000000000000000000000");

/**
 * 解析并归一化 push refspec
 */
export function resolvePushParsedSpecs(refs: RefStore, options?: PushOptions): ParsedRefSpec[] {
  const refSpecStr = options?.refSpecs ?? [resolveDefaultRefSpec(refs)];
  const parsedSpecs = refSpecStr.map(parseRefSpec);

  if (options?.force) {
    return parsedSpecs.map((s) => ({ ...s, force: true }));
  }
  return parsedSpecs;
}

/**
 * 校验 push 所需远端能力
 */
export function validatePushCapabilities(
  advertisement: RefAdvertisement,
  pushRefs: PushRefItem[],
): string[] {
  const caps = extractCapabilities(advertisement.capabilities, PUSH_CAPABILITIES);

  if (!caps.includes("report-status")) {
    throw new PushError(
      "Remote server does not advertise 'report-status' capability. " +
        "This client requires report-status to reliably determine push results. " +
        "Please use a Git server that supports report-status.",
    );
  }

  const hasDeleteCommand = pushRefs.some((r) => r.localHash === null);
  if (hasDeleteCommand && !caps.includes("delete-refs")) {
    throw new PushError(
      "Remote server does not advertise 'delete-refs' capability, " +
        "but the push includes a delete ref operation.",
    );
  }

  return caps;
}

/**
 * 由 push 引用项构造 receive-pack 命令
 */
export function buildPushCommands(pushRefs: PushRefItem[]): ReceivePackCommand[] {
  return pushRefs.map((r) => ({
    oldHash: r.remoteHash ?? ZERO_HASH,
    newHash: r.localHash ?? ZERO_HASH,
    refName: r.remoteRef,
  }));
}

/**
 * 构造 receive-pack 请求 body
 */
export function buildPushRequestBody(
  commands: ReceivePackCommand[],
  packfile: Buffer,
  capabilities: string[],
): Buffer {
  return buildReceivePackRequest(commands, packfile, capabilities);
}
