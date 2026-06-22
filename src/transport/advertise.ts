/**
 * 远端广告获取
 *
 * 只负责一次 GET /info/refs?service=git-upload-pack 并标准化结果，
 * 不再承担传输层注入职责（由调用方自行创建 UploadPackTransport）。
 *
 * @example
 * ```ts
 * const adv = await advertiseRemote("https://github.com/user/repo");
 * console.log(adv.defaultBranch); // "refs/heads/main"
 * ```
 */

import { createUploadPackHttpClient } from "./smart-http.ts";

import type { AdvertiseOptions, RemoteAdvertisement } from "./types.ts";

/**
 * 获取远端广告
 *
 * 请求 upload-pack advertisement 并解析为标准化结构。
 * `defaultBranch` 在此统一提取，后续流程不再解析原始 `symref`。
 *
 * @param url - 远端仓库 URL
 * @param options - 可选配置（认证、自定义头）
 * @returns 标准化远端广告
 *
 * @example
 * ```ts
 * const adv = await advertiseRemote("https://github.com/user/repo");
 * for (const ref of adv.refs) {
 *   console.log(ref.name, ref.hash);
 * }
 * ```
 */
export async function advertiseRemote(
  url: string,
  options?: AdvertiseOptions,
): Promise<RemoteAdvertisement> {
  const client = createUploadPackHttpClient(url, {
    token: options?.token,
    headers: options?.headers,
  });

  const adv = await client.getRefAdvertisement();

  // 从 capabilities 中提取 defaultBranch
  let defaultBranch: string | undefined;
  const symref = adv.capabilities["symref"];
  if (typeof symref === "string") {
    // symref 格式：HEAD:<target>（例如 "HEAD:refs/heads/main"）
    const colonIndex = symref.indexOf(":");
    if (colonIndex !== -1) {
      const headName = symref.substring(0, colonIndex);
      if (headName === "HEAD") {
        defaultBranch = symref.substring(colonIndex + 1);
      }
    }
  }

  // 后备：某些 git http-backend 不广告 symref 能力，
  // 此时尝试从 refs 中推断默认分支。
  // 如果有且仅有一个 refs/heads/*，将其视为默认分支。
  if (defaultBranch === undefined) {
    const heads = adv.refs.filter((r) => r.name.startsWith("refs/heads/"));
    if (heads.length === 1) {
      defaultBranch = heads[0]!.name;
    }
  }

  return {
    capabilities: adv.capabilities,
    refs: adv.refs,
    defaultBranch,
  };
}
