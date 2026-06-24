/**
 * 基于 HTTP 的远端 Git 查询 API
 *
 * 将纯远端查询能力从 Repository 中拆出：
 * - refs 快照
 * - v2 object-info
 * - 协议能力广告
 */

import { createV2HttpTransport } from "../transport/client/upload-pack/http.ts";
import { lsRefs, lsRefsToRefAdvertisement } from "../transport/client/upload-pack/ls-refs.ts";
import { objectInfo } from "../transport/client/upload-pack/object-info.ts";

import type { LsRefsEntry, LsRefsOptions } from "../transport/client/upload-pack/ls-refs.ts";
import type { ObjectInfoQueryResult } from "../transport/client/upload-pack/object-info.ts";
import type { V2CapabilityAdvertisement } from "../transport/client/upload-pack/types.ts";
import type { RefAdvertisement } from "../transport/protocol/types.ts";
import type { RemoteSource } from "./types.ts";

/**
 * 远端 HTTP 查询接口
 */
export interface HttpRemote {
  /** 远端来源配置 */
  readonly source: Readonly<RemoteSource>;

  /** 读取 v2 能力广告 */
  advertise(): Promise<V2CapabilityAdvertisement>;

  /** 原样执行 ls-refs 查询 */
  listRefs(options?: LsRefsOptions): Promise<LsRefsEntry[]>;

  /** 读取适合高层 API 使用的 ref 快照 */
  readRefAdvertisement(): Promise<RefAdvertisement>;

  /** 查询对象元数据（协议 v2 object-info） */
  fetchObjectInfo(oids: string[]): Promise<ObjectInfoQueryResult>;
}

/**
 * 创建基于 Smart HTTP 的远端查询对象
 *
 * 适用于只依赖远端 URL / 认证信息的查询，
 * 例如 refs 快照和 object-info，不需要本地 repo 上下文。
 *
 * @param source - 远端来源
 * @returns 远端查询对象
 *
 * @example
 * ```ts
 * import { createHttpRemote } from "nano-git/remote/http";
 *
 * const remote = createHttpRemote({
 *   url: "https://github.com/user/repo.git",
 * });
 *
 * const snapshot = await remote.readRefAdvertisement();
 * const info = await remote.fetchObjectInfo([
 *   "95d09f2b10159347eece71399a7e2e907ea3df4f",
 * ]);
 *
 * console.log(snapshot.defaultBranch);
 * console.log(info.objects[0]?.size);
 * ```
 */
export function createHttpRemote(source: RemoteSource): HttpRemote {
  const frozenSource = Object.freeze({
    url: source.url,
    token: source.token,
    headers: source.headers ? Object.freeze({ ...source.headers }) : undefined,
  }) as Readonly<RemoteSource>;

  const transport = createV2HttpTransport(frozenSource.url, {
    token: frozenSource.token,
    headers: frozenSource.headers,
  });

  return {
    source: frozenSource,

    advertise(): Promise<V2CapabilityAdvertisement> {
      return transport.advertise();
    },

    listRefs(options?: LsRefsOptions): Promise<LsRefsEntry[]> {
      return lsRefs(transport, options);
    },

    async readRefAdvertisement(): Promise<RefAdvertisement> {
      const entries = await lsRefs(transport, {
        symrefs: true,
        peel: true,
        refPrefixes: ["HEAD", "refs/heads/", "refs/tags/"],
      });
      return lsRefsToRefAdvertisement(entries);
    },

    fetchObjectInfo(oids: string[]): Promise<ObjectInfoQueryResult> {
      return objectInfo(transport, oids);
    },
  };
}
