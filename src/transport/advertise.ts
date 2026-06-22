/**
 * 远端广告获取（便捷入口）
 *
 * 请求 upload-pack advertisement，解析结果含 defaultBranch。
 */

import { createUploadPackHttpClient } from "./smart-http.ts";

import type { AdvertiseOptions, RefAdvertisement } from "./types.ts";

/**
 * 获取远端 upload-pack 广告
 *
 * @param url - 远端仓库 URL
 * @param options - 可选配置（认证、自定义头）
 *
 * @example
 * ```ts
 * const adv = await advertiseRemote("https://github.com/user/repo");
 * console.log(adv.defaultBranch);
 * ```
 */
export async function advertiseRemote(
  url: string,
  options?: AdvertiseOptions,
): Promise<RefAdvertisement> {
  const client = createUploadPackHttpClient(url, {
    token: options?.token,
    headers: options?.headers,
  });

  return client.advertise();
}
