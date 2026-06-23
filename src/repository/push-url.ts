/**
 * 仓库 push 内部编排
 *
 * 支持 preAdvertised、transportFactory 注入。
 * 使用 v1 receive-pack 协议进行推送。
 */

import { createReceivePackHttpClient } from "../transport/client/push/http.ts";
import { push as transportPush } from "../transport/client/push/push.ts";
import { resolveEffectivePushBoundaries } from "./push-resolution.ts";

import type { SHA1 } from "../core/types.ts";
import type { ReceivePackTransport, RefAdvertisement } from "../transport/shared/types.ts";
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
      shallowBoundaries: resolveEffectivePushBoundaries(options, backend.shallow.read()),
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
