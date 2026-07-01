/**
 * transport/protocol/ref-match.ts 单元测试
 *
 * 覆盖 matchesRefSpec / mapRefName
 */

import { describe, test, expect } from "bun:test";

import { matchesRefSpec, mapRefName } from "@/transport/protocol/ref-match.ts";
import { parseRefSpec } from "@/transport/protocol/refspec.ts";
import { sha1 } from "@/types/index.ts";

import type { ParsedRefSpec } from "@/transport/protocol/refspec.ts";
import type { RemoteRef } from "@/transport/protocol/types.ts";

function exactSpec(src: string, dst?: string): ParsedRefSpec {
  return parseRefSpec(`${src}:${dst ?? src}`);
}

describe("matchesRefSpec()", () => {
  const ref: RemoteRef = {
    name: "refs/heads/main",
    hash: sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"),
  };

  test("精确 refspec 匹配", () => {
    const spec = exactSpec("refs/heads/main");
    expect(matchesRefSpec(ref, spec)).toBe(true);
  });

  test("精确 refspec 不匹配", () => {
    const spec = exactSpec("refs/heads/other");
    expect(matchesRefSpec(ref, spec)).toBe(false);
  });

  test("通配符 refspec 匹配", () => {
    const spec = parseRefSpec("refs/heads/*:refs/remotes/origin/*");
    expect(matchesRefSpec(ref, spec)).toBe(true);
  });

  test("通配符 refspec 不匹配", () => {
    const spec = parseRefSpec("refs/tags/*:refs/tags/*");
    expect(matchesRefSpec(ref, spec)).toBe(false);
  });

  test("包含完整 refspec 的目的地不影响匹配判断", () => {
    // matchesRefSpec 只检查源模式
    const spec = exactSpec("refs/heads/main", "refs/remotes/origin/main");
    expect(matchesRefSpec(ref, spec)).toBe(true);
  });
});

describe("mapRefName()", () => {
  test("通配符 refspec 映射", () => {
    const spec = parseRefSpec("refs/heads/*:refs/remotes/origin/*");
    expect(mapRefName("refs/heads/main", spec)).toBe("refs/remotes/origin/main");
  });

  test("精确 refspec 映射", () => {
    const spec = parseRefSpec("refs/heads/main:refs/remotes/origin/main");
    expect(mapRefName("refs/heads/main", spec)).toBe("refs/remotes/origin/main");
  });

  test("多层路径通配符映射", () => {
    const spec = parseRefSpec("refs/heads/*:refs/remotes/origin/*");
    expect(mapRefName("refs/heads/feature/sub", spec)).toBe("refs/remotes/origin/feature/sub");
  });

  test("特殊字符 ref 名", () => {
    const spec = parseRefSpec("refs/heads/*:refs/remotes/origin/*");
    expect(mapRefName("refs/heads/v1.0-rc.1", spec)).toBe("refs/remotes/origin/v1.0-rc.1");
  });
});
