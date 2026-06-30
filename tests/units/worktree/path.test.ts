/**
 * worktree/path.ts 单元测试
 */
import { describe, test, expect } from "bun:test";

import {
  VIRTUAL_ROOT_PATH,
  assertValidVirtualPath,
  baseName,
  joinPath,
  normalizeDirectoryPath,
  parentPath,
  splitPathSegments,
} from "@/worktree/path.ts";

describe("normalizeDirectoryPath()", () => {
  test("undefined 与空串为根", () => {
    expect(normalizeDirectoryPath(undefined)).toBe(VIRTUAL_ROOT_PATH);
    expect(normalizeDirectoryPath("")).toBe(VIRTUAL_ROOT_PATH);
  });

  test("合法子路径原样返回", () => {
    expect(normalizeDirectoryPath("src/lib")).toBe("src/lib");
  });
});

describe("assertValidVirtualPath()", () => {
  test("拒绝空路径", () => {
    expect(() => assertValidVirtualPath("")).toThrow(/empty/);
  });

  test("拒绝绝对路径与 ..", () => {
    expect(() => assertValidVirtualPath("/a")).toThrow();
    expect(() => assertValidVirtualPath("a/../b")).toThrow();
  });
});

describe("路径分段与组合", () => {
  test("splitPathSegments / parentPath / baseName / joinPath", () => {
    const path = "src/lib/foo.ts";
    expect(splitPathSegments(path)).toEqual(["src", "lib", "foo.ts"]);
    expect(parentPath(path)).toBe("src/lib");
    expect(baseName(path)).toBe("foo.ts");
    expect(joinPath("src/lib", "foo.ts")).toBe(path);
    expect(joinPath(null, "README.md")).toBe("README.md");
  });
});
