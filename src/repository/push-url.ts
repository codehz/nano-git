/**
 * 仓库 push 内部编排
 *
 * 支持 preAdvertised、transportFactory 注入。
 * 自动检测远端 v2 协议支持，优先使用 v2 push。
 */

import { sha1 } from "../core/types.ts";
import { createPackWriter } from "../odb/pack/pack-writer.ts";
import { PushError } from "../transport/push-error.ts";
import { mergePushBoundaries, computeObjectsToSend } from "../transport/push-pack-plan.ts";
import { checkFastForward } from "../transport/push-policy.ts";
import { determinePushRefs } from "../transport/push-ref-plan.ts";
import { resolvePushParsedSpecs } from "../transport/push-request-plan.ts";
import { push as transportPush } from "../transport/push.ts";
import { getLocalRefs, remoteRefsToMap } from "../transport/ref-collection.ts";
import { createReceivePackHttpClient } from "../transport/smart-http.ts";
import { detectProtocol } from "../transport/v2/detect.ts";
import { lsRefs, lsRefsToRefAdvertisement } from "../transport/v2/ls-refs.ts";
import { v2Push } from "../transport/v2/push.ts";
import { resolveEffectivePushBoundaries } from "./push-resolution.ts";

import type { SHA1 } from "../core/types.ts";
import type { ReceivePackTransport, RefAdvertisement } from "../transport/types.ts";
import type { RepositoryBackend } from "./backend/types.ts";
import type { RepositoryPushOptions, RepositoryPushResult } from "./push-types.ts";

/**
 * 按 URL push（不依赖任何命名 endpoint 配置）
 */
export async function runPushToUrl(
  backend: RepositoryBackend,
  url: string,
  options?: RepositoryPushOptions,
  preAdvertised?: RefAdvertisement,
  transportFactory?: (url: string, options?: RepositoryPushOptions) => ReceivePackTransport,
): Promise<RepositoryPushResult> {
  return runPushWithUrl(backend, url, options, preAdvertised, transportFactory);
}

async function runPushWithUrl(
  backend: RepositoryBackend,
  pushUrl: string,
  options?: RepositoryPushOptions,
  preAdvertised?: RefAdvertisement,
  transportFactory?: (url: string, options?: RepositoryPushOptions) => ReceivePackTransport,
): Promise<RepositoryPushResult> {
  const shallowBoundaries = resolveEffectivePushBoundaries(options, backend.shallow.read());

  // 尝试 v2 协议（使用 git-receive-pack 服务）
  const v2Result = await detectProtocol(
    pushUrl,
    {
      token: options?.token,
      headers: options?.headers,
    },
    "git-receive-pack",
  );

  if (v2Result.protocol === "v2") {
    return runV2Push(
      backend,
      pushUrl,
      v2Result.transport,
      v2Result.capabilities,
      options,
      shallowBoundaries,
    );
  }

  // v1 回退
  const createTransport =
    transportFactory ??
    ((url: string) =>
      createReceivePackHttpClient(url, {
        token: options?.token,
        headers: options?.headers,
      }));
  const transport = createTransport(pushUrl, options);

  const advertisement: RefAdvertisement = preAdvertised ?? (await transport.advertise());

  const transportResult = await transportPush(
    backend.objects,
    backend.refs,
    transport,
    advertisement,
    {
      refSpecs: options?.refSpecs,
      force: options?.force,
      shallowBoundaries,
    },
  );

  return convertPushResult(
    transportResult.refUpdates,
    transportResult.objectCount,
    transportResult.progress,
  );
}

/**
 * 使用 v2 协议执行 push
 */
async function runV2Push(
  backend: RepositoryBackend,
  pushUrl: string,
  v2Transport: import("../transport/v2/types.ts").V2GitServiceTransport,
  capabilities: import("../transport/v2/types.ts").V2CapabilityAdvertisement,
  options?: RepositoryPushOptions,
  shallowBoundaries?: SHA1[],
): Promise<RepositoryPushResult> {
  // 检查服务端是否支持 v2 push
  const pushCmd = capabilities.commands.find((c) => c.name === "push");
  if (!pushCmd) {
    throw new PushError("Remote server does not support v2 push command");
  }

  // 使用 ls-refs 获取远端 refs（替代 v1 的 advertisement）
  const lsRefsEntries = await lsRefs(v2Transport, {
    symrefs: true,
    peel: true,
  });
  const advertisement = lsRefsToRefAdvertisement(lsRefsEntries);

  // 解析 refspec
  const effectiveSpecs = resolvePushParsedSpecs(backend.refs, options);

  // 获取本地和远端 refs
  const localRefs = getLocalRefs(backend.refs);
  const remoteRefs = remoteRefsToMap(advertisement.refs);

  // 确定要推送的引用
  const pushRefs = determinePushRefs(localRefs, remoteRefs, effectiveSpecs);

  if (pushRefs.length === 0) {
    return { pushedRefs: [], objectCount: 0, progress: [] };
  }

  const shallowSet: Set<SHA1> | undefined = shallowBoundaries
    ? new Set(shallowBoundaries)
    : undefined;

  const pushBoundaries = mergePushBoundaries(shallowSet, pushRefs);

  // non-fast-forward 预检
  checkFastForward(backend.objects, pushRefs, shallowSet);

  // 计算需要发送的对象
  const objectsToSend = computeObjectsToSend(backend.objects, pushRefs, remoteRefs, pushBoundaries);

  // 构建 packfile
  const packWriter = createPackWriter();
  for (const hash of objectsToSend) {
    const obj = backend.objects.read(hash);
    packWriter.addObject(obj);
  }
  const packfile = packWriter.build();

  // 构建 v2 push 命令
  const pushCommands = pushRefs.map((r) => ({
    oldHash: r.remoteHash ?? sha1("0000000000000000000000000000000000000000"),
    newHash: r.localHash ?? sha1("0000000000000000000000000000000000000000"),
    refName: r.remoteRef,
  }));

  const caps = ["report-status", "side-band-64k", "ofs-delta"];

  const v2Result = await v2Push(v2Transport, pushCommands, packfile, caps);

  return convertPushResult(v2Result.refUpdates, packWriter.objectCount, v2Result.progress);
}

function convertPushResult(
  refUpdates: Array<{
    refName: string;
    oldHash: SHA1 | null;
    newHash: SHA1 | null;
    success: boolean;
    error?: string;
    forced?: boolean;
  }>,
  objectCount: number,
  progress: string[],
): RepositoryPushResult {
  return {
    pushedRefs: refUpdates.map((u) => ({
      refName: u.refName,
      oldHash: u.oldHash,
      newHash: u.newHash,
      success: u.success,
      error: u.error,
      forced: u.forced ?? false,
    })),
    objectCount,
    progress,
  };
}
