/**
 * fetch 编排单元测试
 *
 * 覆盖 refspec 解析和 wants 确定逻辑（不依赖 HTTP 的纯逻辑部分）。
 */

import { describe, test, expect } from "bun:test";
import {
  parseRefSpec,
  matchesRefSpec,
  mapRefName,
  determineWants,
} from "../../../src/transport/fetch.ts";
import type { RemoteRef } from "../../../src/transport/types.ts";
import { sha1, type SHA1 } from "../../../src/core/types.ts";

// ============================================================================
// 辅助函数
// ============================================================================

function makeRef(name: string, hash?: string): RemoteRef {
  return { name, hash: sha1(hash ?? "95d09f2b10159347eece71399a7e2e907ea3df4f") };
}

// ============================================================================
// RefSpec 解析
// ============================================================================

describe("parseRefSpec()", () => {
  test("默认 refspec", () => {
    const spec = parseRefSpec("+refs/heads/*:refs/remotes/origin/*");
    expect(spec.force).toBe(true);
    expect(spec.srcPattern).toBe("refs/heads/");
    expect(spec.dstPattern).toBe("refs/remotes/origin/");
  });

  test("无 force 的 refspec", () => {
    const spec = parseRefSpec("refs/heads/*:refs/remotes/upstream/*");
    expect(spec.force).toBe(false);
    expect(spec.srcPattern).toBe("refs/heads/");
    expect(spec.dstPattern).toBe("refs/remotes/upstream/");
  });

  test("无通配符的 refspec", () => {
    const spec = parseRefSpec("+refs/heads/main:refs/remotes/origin/main");
    expect(spec.force).toBe(true);
    expect(spec.srcPattern).toBe("refs/heads/main");
    expect(spec.dstPattern).toBe("refs/remotes/origin/main");
  });

  test("缺少冒号应抛出错误", () => {
    expect(() => parseRefSpec("refs/heads/main")).toThrow("Invalid refspec");
  });

  test("tag refspec", () => {
    const spec = parseRefSpec("+refs/tags/*:refs/tags/*");
    expect(spec.srcPattern).toBe("refs/tags/");
    expect(spec.dstPattern).toBe("refs/tags/");
    expect(spec.force).toBe(true);
  });
});

// ============================================================================
// 引用匹配
// ============================================================================

describe("matchesRefSpec / mapRefName", () => {
  const defaultSpec = parseRefSpec("+refs/heads/*:refs/remotes/origin/*");

  test("匹配 refs/heads 分支", () => {
    const ref = makeRef("refs/heads/main");
    expect(matchesRefSpec(ref, defaultSpec)).toBe(true);
  });

  test("不匹配 refs/tags", () => {
    const ref = makeRef("refs/tags/v1.0");
    expect(matchesRefSpec(ref, defaultSpec)).toBe(false);
  });

  test("映射 ref 名", () => {
    expect(mapRefName("refs/heads/main", defaultSpec)).toBe("refs/remotes/origin/main");
    expect(mapRefName("refs/heads/feature/xyz", defaultSpec)).toBe(
      "refs/remotes/origin/feature/xyz",
    );
  });
});

// ============================================================================
// Wants 确定
// ============================================================================

describe("determineWants()", () => {
  const hash1 = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
  const hash2 = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const defaultSpec = parseRefSpec("+refs/heads/*:refs/remotes/origin/*");

  test("初始 clone：所有分支都应 want", () => {
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
      makeRef("refs/heads/develop", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ];
    const wants = determineWants(refs, new Map(), [defaultSpec]);
    expect(wants).toHaveLength(2);
    expect(wants[0]!.localName).toBe("refs/remotes/origin/main");
    expect(wants[1]!.localName).toBe("refs/remotes/origin/develop");
  });

  test("本地已是最新则跳过", () => {
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
      makeRef("refs/heads/develop", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ];
    const localRefs = new Map<string, SHA1>([["refs/remotes/origin/main", hash1]]);
    const wants = determineWants(refs, localRefs, [defaultSpec]);
    // main 已是最新，只有 develop 需要拉取
    expect(wants).toHaveLength(1);
    expect(wants[0]!.localName).toBe("refs/remotes/origin/develop");
  });

  test("本地 hash 不同则应拉取", () => {
    const refs: RemoteRef[] = [
      makeRef("refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"),
    ];
    const localRefs = new Map<string, SHA1>([
      ["refs/remotes/origin/main", hash2], // 不同的 hash
    ]);
    const wants = determineWants(refs, localRefs, [defaultSpec]);
    expect(wants).toHaveLength(1);
  });

  test("空远程返回空 wants", () => {
    const wants = determineWants([], new Map(), [defaultSpec]);
    expect(wants).toHaveLength(0);
  });
});
