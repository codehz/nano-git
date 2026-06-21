/**
 * Push 删除引用单元测试
 *
 * 验证 parseRefSpec 和 determinePushRefs 对删除 refspec 的正确处理。
 * 删除 refspec 格式为 ":<remote-ref>"（源为空，如 ":refs/heads/feature"），
 * 对应 `git push <remote> :refs/heads/feature`。
 */

import { describe, test, expect } from "bun:test";

import { sha1, type SHA1 } from "@/core/types.ts";
import { parseRefSpec } from "@/transport/fetch.ts";
import { determinePushRefs } from "@/transport/push.ts";

// ============================================================================
// 常量
// ============================================================================

const HASH_A = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const HASH_B = sha1("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

// ============================================================================
// parseRefSpec 对删除 refspec 的解析
// ============================================================================

describe("parseRefSpec 删除 refspec", () => {
  test("解析删除 refspec（:refs/heads/feature）", () => {
    const spec = parseRefSpec(":refs/heads/feature");
    expect(spec.force).toBe(false);
    expect(spec.srcPattern).toBe("");
    expect(spec.dstPattern).toBe("refs/heads/feature");
  });

  test("解析强制删除 refspec（+:refs/heads/feature）", () => {
    const spec = parseRefSpec("+:refs/heads/feature");
    expect(spec.force).toBe(true);
    expect(spec.srcPattern).toBe("");
    expect(spec.dstPattern).toBe("refs/heads/feature");
  });
});

// ============================================================================
// determinePushRefs 对删除 refspec 的处理
// ============================================================================

describe("determinePushRefs 删除 refspec", () => {
  /** 本地 refs：只有一个 main 分支 */
  const localRefs = new Map<string, SHA1>([["refs/heads/main", HASH_A]]);

  /** 远程 refs：有 main 和 feature 两个分支 */
  const remoteRefs = new Map<string, SHA1>([
    ["refs/heads/main", HASH_A],
    ["refs/heads/feature", HASH_B],
  ]);

  test("删除已存在的远程引用", () => {
    const specs = [parseRefSpec(":refs/heads/feature")];
    const items = determinePushRefs(localRefs, remoteRefs, specs);

    expect(items).toHaveLength(1);
    expect(items[0]!.localRef).toBe("");
    expect(items[0]!.remoteRef).toBe("refs/heads/feature");
    expect(items[0]!.localHash).toBeNull();
    expect(items[0]!.remoteHash).toBe(HASH_B);
    expect(items[0]!.force).toBe(false);
  });

  test("删除不存在的远程引用（仍应生成删除命令）", () => {
    const specs = [parseRefSpec(":refs/heads/nonexistent")];
    const items = determinePushRefs(localRefs, remoteRefs, specs);

    expect(items).toHaveLength(1);
    expect(items[0]!.localRef).toBe("");
    expect(items[0]!.remoteRef).toBe("refs/heads/nonexistent");
    expect(items[0]!.localHash).toBeNull();
    expect(items[0]!.remoteHash).toBeNull();
    expect(items[0]!.force).toBe(false);
  });

  test("强制删除远程引用", () => {
    const specs = [parseRefSpec("+:refs/heads/feature")];
    const items = determinePushRefs(localRefs, remoteRefs, specs);

    expect(items).toHaveLength(1);
    expect(items[0]!.force).toBe(true);
    expect(items[0]!.localHash).toBeNull();
  });

  test("混合：删除 refspec + 正常推送 refspec", () => {
    const specs = [
      parseRefSpec(":refs/heads/feature"),
      parseRefSpec("refs/heads/main:refs/heads/main"),
    ];
    const items = determinePushRefs(localRefs, remoteRefs, specs);

    expect(items).toHaveLength(2);

    // 第一个是删除操作
    expect(items[0]!.localRef).toBe("");
    expect(items[0]!.remoteRef).toBe("refs/heads/feature");
    expect(items[0]!.localHash).toBeNull();
    expect(items[0]!.remoteHash).toBe(HASH_B);

    // 第二个是正常推送
    expect(items[1]!.localRef).toBe("refs/heads/main");
    expect(items[1]!.remoteRef).toBe("refs/heads/main");
    expect(items[1]!.localHash).toBe(HASH_A);
    expect(items[1]!.remoteHash).toBe(HASH_A);
  });

  test("纯删除 refspec 不应用 force 到其他 refspec", () => {
    const specs = [
      parseRefSpec("+:refs/heads/feature"),
      parseRefSpec("refs/heads/main:refs/heads/main"),
    ];
    const items = determinePushRefs(localRefs, remoteRefs, specs);

    expect(items).toHaveLength(2);
    expect(items[0]!.force).toBe(true); // 删除带 force
    expect(items[1]!.force).toBe(false); // 正常推送无 force
  });
});

// ============================================================================
// determinePushRefs 功能验证：确保正常场景不受影响
// ============================================================================

describe("determinePushRefs 正常 refspec（回归测试）", () => {
  const localRefs = new Map<string, SHA1>([["refs/heads/main", HASH_A]]);
  const remoteRefs = new Map<string, SHA1>([["refs/heads/main", HASH_A]]);

  test("精确 refspec：推送现有本地分支", () => {
    const specs = [parseRefSpec("refs/heads/main:refs/heads/main")];
    const items = determinePushRefs(localRefs, remoteRefs, specs);

    expect(items).toHaveLength(1);
    expect(items[0]!.localHash).toBe(HASH_A);
    expect(items[0]!.remoteHash).toBe(HASH_A);
  });

  test("精确 refspec：本地分支不存在时抛错", () => {
    const specs = [parseRefSpec("refs/heads/feature:refs/heads/feature")];
    expect(() => determinePushRefs(localRefs, remoteRefs, specs)).toThrow("Local ref not found");
  });

  test("通配符 refspec", () => {
    const localRefsMulti = new Map<string, SHA1>([
      ["refs/heads/main", HASH_A],
      ["refs/heads/feature", HASH_B],
    ]);
    const remoteRefsMulti = new Map<string, SHA1>([["refs/heads/main", HASH_A]]);

    const specs = [parseRefSpec("refs/heads/*:refs/heads/*")];
    const items = determinePushRefs(localRefsMulti, remoteRefsMulti, specs);

    expect(items).toHaveLength(2);
    expect(items[0]!.remoteRef).toBe("refs/heads/main");
    expect(items[0]!.localHash).toBe(HASH_A);
    expect(items[1]!.remoteRef).toBe("refs/heads/feature");
    expect(items[1]!.localHash).toBe(HASH_B);
  });
});
