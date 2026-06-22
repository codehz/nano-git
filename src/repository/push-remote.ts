/**
 * Push remote 内部编排
 *
 * 与 fetch-remote 对称：支持 preAdvertised、transportFactory 注入。
 */

import { push as transportPush } from "../transport/push.ts";
import { createReceivePackHttpClient } from "../transport/smart-http.ts";
import {
  resolveEffectivePushBoundaries,
  resolveEffectivePushRefSpecs,
  resolveEffectivePushUrl,
} from "./remote-resolution.ts";

import type { SHA1 } from "../core/types.ts";
import type { ReceivePackTransport, RefAdvertisement } from "../transport/types.ts";
import type { RepositoryBackend } from "./backend/types.ts";
import type { RemoteConfig, PushRemoteOptions, PushRemoteResult } from "./remote-types.ts";

/**
 * 执行 push remote 内部流程
 */
export async function runPushRemote(
  backend: RepositoryBackend,
  remote: RemoteConfig,
  options?: PushRemoteOptions,
  preAdvertised?: RefAdvertisement,
  transportFactory?: (url: string, options?: PushRemoteOptions) => ReceivePackTransport,
): Promise<PushRemoteResult> {
  const effectivePushUrl = resolveEffectivePushUrl(remote, options);
  const pushOptions: PushRemoteOptions = {
    ...options,
    refSpecs: resolveEffectivePushRefSpecs(remote, options),
  };

  return runPushWithUrl(backend, effectivePushUrl, pushOptions, preAdvertised, transportFactory);
}

/**
 * 按 URL push（不依赖 remote 配置）
 */
export async function runPushToUrl(
  backend: RepositoryBackend,
  url: string,
  options?: PushRemoteOptions,
  preAdvertised?: RefAdvertisement,
  transportFactory?: (url: string, options?: PushRemoteOptions) => ReceivePackTransport,
): Promise<PushRemoteResult> {
  return runPushWithUrl(backend, url, options, preAdvertised, transportFactory);
}

async function runPushWithUrl(
  backend: RepositoryBackend,
  pushUrl: string,
  options?: PushRemoteOptions,
  preAdvertised?: RefAdvertisement,
  transportFactory?: (url: string, options?: PushRemoteOptions) => ReceivePackTransport,
): Promise<PushRemoteResult> {
  const createTransport =
    transportFactory ??
    ((url: string) =>
      createReceivePackHttpClient(url, {
        token: options?.token,
        headers: options?.headers,
      }));
  const transport = createTransport(pushUrl, options);

  const advertisement: RefAdvertisement = preAdvertised ?? (await transport.advertise());
  const shallowBoundaries = resolveEffectivePushBoundaries(options, backend.shallow.read());

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
): PushRemoteResult {
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
