/**
 * RefSpec 解析与引用匹配单元测试
 *
 * 覆盖 parseRefSpec、matchesRefSpec、mapRefName。
 */

import { describe, test, expect } from "bun:test";

import { sha1 } from "@/core/types.ts";
import { matchesRefSpec, mapRefName } from "@/transport/ref-match.ts";
import { parseRefSpec } from "@/transport/refspec.ts";

import type { RemoteRef } from "@/transport/types.ts";

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

  // ========================================================================
  // 非法 refspec 校验
  // ========================================================================

  test("单边通配符（src 有 *、dst 无 *）应拒绝", () => {
    expect(() => parseRefSpec("refs/heads/*:refs/remotes/origin/main")).toThrow("Invalid refspec");
  });

  test("单边通配符（src 无 *、dst 有 *）应拒绝", () => {
    expect(() => parseRefSpec("refs/heads/main:refs/remotes/origin/*")).toThrow("Invalid refspec");
  });

  test("带 force 的单边通配符也应拒绝", () => {
    expect(() => parseRefSpec("+refs/heads/*:refs/remotes/origin/main")).toThrow("Invalid refspec");
  });

  test("通配符不在末尾（src 中间带 *）应拒绝", () => {
    expect(() => parseRefSpec("refs/heads/*/abc:refs/heads/*/xyz")).toThrow("Invalid refspec");
  });

  test("通配符不在末尾（src * 后有后缀）应拒绝", () => {
    expect(() => parseRefSpec("refs/heads/*extra:refs/heads/*")).toThrow("Invalid refspec");
  });

  test("通配符不在末尾（dst * 后有后缀）应拒绝", () => {
    expect(() => parseRefSpec("refs/heads/*:refs/heads/*extra")).toThrow("Invalid refspec");
  });

  test("多个通配符应拒绝", () => {
    expect(() => parseRefSpec("refs/heads/*/*:refs/heads/*/*")).toThrow("Invalid refspec");
  });

  test("删除 refspec（:refs/heads/feature）不受影响", () => {
    const spec = parseRefSpec(":refs/heads/feature");
    expect(spec.srcPattern).toBe("");
    expect(spec.dstPattern).toBe("refs/heads/feature");
    expect(spec.isWildcard).toBe(false);
  });

  test("精确 refspec 不受影响", () => {
    const spec = parseRefSpec("+refs/heads/main:refs/remotes/origin/main");
    expect(spec.isWildcard).toBe(false);
    expect(spec.srcPattern).toBe("refs/heads/main");
    expect(spec.dstPattern).toBe("refs/remotes/origin/main");
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

  test("精确 refspec 按字面匹配，不做前缀匹配", () => {
    const exactSpec = parseRefSpec("+refs/heads/main:refs/remotes/origin/main");
    const matchingRef = makeRef("refs/heads/main");
    const nonMatchingRef = makeRef("refs/heads/main-old");
    expect(matchesRefSpec(matchingRef, exactSpec)).toBe(true);
    expect(matchesRefSpec(nonMatchingRef, exactSpec)).toBe(false);
  });

  test("映射 ref 名", () => {
    expect(mapRefName("refs/heads/main", defaultSpec)).toBe("refs/remotes/origin/main");
    expect(mapRefName("refs/heads/feature/xyz", defaultSpec)).toBe(
      "refs/remotes/origin/feature/xyz",
    );
  });
});
