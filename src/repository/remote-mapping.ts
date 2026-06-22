/**
 * Remote 映射规则
 *
 * 处理 remote fetch rule 映射、default branch 映射、push default refspec 推导等
 * 纯规则推导逻辑。bootstrapRemote() 等编排函数只负责调用，不内嵌映射算法。
 *
 * @example
 * ```ts
 * import { mapDefaultBranchToTrackingRef } from "./remote-mapping.ts";
 *
 * const trackingRef = mapDefaultBranchToTrackingRef(
 *   "refs/heads/main",
 *   [{ source: "+refs/heads/*", target: "refs/remotes/origin/*" }],
 * );
 * console.log(trackingRef); // "refs/remotes/origin/main"
 * ```
 */

import type { RemoteConfig } from "./remote-types.ts";

/**
 * 将远端默认分支通过 fetchRules 映射为本地 tracking ref
 *
 * 注意：source 可能以 + 开头（表示 force），需要先去除。
 *
 * @param defaultBranch - 远端默认分支，如 "refs/heads/main"
 * @param fetchRules - fetch 映射规则列表
 * @returns 本地 tracking ref 名称，未匹配时返回 undefined
 *
 * @example
 * ```ts
 * const ref = mapDefaultBranchToTrackingRef(
 *   "refs/heads/main",
 *   [{ source: "+refs/heads/*", target: "refs/remotes/origin/*" }],
 * );
 * // => "refs/remotes/origin/main"
 * ```
 */
export function mapDefaultBranchToTrackingRef(
  defaultBranch: string,
  fetchRules: RemoteConfig["fetchRules"],
): string | undefined {
  for (const rule of fetchRules) {
    const cleanSource = rule.source.startsWith("+") ? rule.source.slice(1) : rule.source;

    if (!cleanSource.includes("*")) {
      if (cleanSource === defaultBranch) {
        return rule.target;
      }
    } else {
      const srcPattern = cleanSource.replace("*", "");
      if (defaultBranch.startsWith(srcPattern)) {
        const suffix = defaultBranch.slice(srcPattern.length);
        return rule.target.replace("*", suffix);
      }
    }
  }
  return undefined;
}
