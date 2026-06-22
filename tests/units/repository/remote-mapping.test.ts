/**
 * remote-mapping 单元测试
 *
 * 验证 fetch rule 映射逻辑：
 * - 通配符规则匹配
 * - 精确规则匹配
 * - force 前缀处理
 * - 无匹配时返回 undefined
 */

import { describe, test, expect } from "bun:test";

import { mapDefaultBranchToTrackingRef } from "@/repository/remote-mapping.ts";

import type { RemoteConfig } from "@/repository/remote-types.ts";

describe("mapDefaultBranchToTrackingRef", () => {
  test("通配符规则：匹配默认分支并映射 tracking ref", () => {
    const rules: RemoteConfig["fetchRules"] = [
      { source: "+refs/heads/*", target: "refs/remotes/origin/*" },
    ];

    const result = mapDefaultBranchToTrackingRef("refs/heads/main", rules);
    expect(result).toBe("refs/remotes/origin/main");
  });

  test("通配符规则：非默认命名空间也能正确映射", () => {
    const rules: RemoteConfig["fetchRules"] = [
      { source: "refs/heads/*", target: "refs/remotes/upstream/*" },
    ];

    const result = mapDefaultBranchToTrackingRef("refs/heads/feature", rules);
    expect(result).toBe("refs/remotes/upstream/feature");
  });

  test("通配符规则：多级路径分支映射", () => {
    const rules: RemoteConfig["fetchRules"] = [
      { source: "refs/heads/*", target: "refs/remotes/origin/*" },
    ];

    const result = mapDefaultBranchToTrackingRef("refs/heads/feature/sub", rules);
    expect(result).toBe("refs/remotes/origin/feature/sub");
  });

  test("精确规则：直接匹配", () => {
    const rules: RemoteConfig["fetchRules"] = [
      { source: "refs/heads/main", target: "refs/heads/main" },
    ];

    const result = mapDefaultBranchToTrackingRef("refs/heads/main", rules);
    expect(result).toBe("refs/heads/main");
  });

  test("精确规则：匹配失败时回退到通配符规则", () => {
    const rules: RemoteConfig["fetchRules"] = [
      { source: "refs/heads/develop", target: "refs/remotes/origin/develop" },
      { source: "+refs/heads/*", target: "refs/remotes/origin/*" },
    ];

    const result = mapDefaultBranchToTrackingRef("refs/heads/main", rules);
    // 精确规则不匹配，通配符规则匹配
    expect(result).toBe("refs/remotes/origin/main");
  });

  test("无匹配：返回 undefined", () => {
    const rules: RemoteConfig["fetchRules"] = [
      { source: "refs/heads/main", target: "refs/heads/main" },
    ];

    const result = mapDefaultBranchToTrackingRef("refs/heads/feature", rules);
    expect(result).toBeUndefined();
  });

  test("空规则列表：返回 undefined", () => {
    const result = mapDefaultBranchToTrackingRef("refs/heads/main", []);
    expect(result).toBeUndefined();
  });

  test("force 前缀不影响映射结果", () => {
    const rulesWithForce: RemoteConfig["fetchRules"] = [
      { source: "+refs/heads/*", target: "refs/remotes/origin/*" },
    ];
    const rulesWithoutForce: RemoteConfig["fetchRules"] = [
      { source: "refs/heads/*", target: "refs/remotes/origin/*" },
    ];

    const resultWithForce = mapDefaultBranchToTrackingRef("refs/heads/main", rulesWithForce);
    const resultWithoutForce = mapDefaultBranchToTrackingRef("refs/heads/main", rulesWithoutForce);
    expect(resultWithForce).toBe(resultWithoutForce);
  });
});
