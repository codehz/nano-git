/**
 * v2 ls-refs 解析单元测试
 *
 * 覆盖场景：
 * - 完整解析 ls-refs 响应
 * - symref 属性解析
 * - peeled tag 属性解析
 * - ref-prefix 过滤
 * - unborn 条目
 * - 空响应
 * - 转换为 v1 RefAdvertisement
 */

import { describe, test, expect } from "bun:test";

import { sha1 } from "@/core/types.ts";
import {
  parseLsRefsResponse,
  lsRefsToRefAdvertisement,
} from "@/transport/client/upload-pack/ls-refs.ts";
import { encodePktLine, encodeFlushPkt } from "@/transport/protocol/pkt-line.ts";

import type { LsRefsEntry } from "@/transport/client/upload-pack/types.ts";

// ============================================================================
// 辅助函数
// ============================================================================

/** 构造 ls-refs 响应行 */
function refLine(content: string): Buffer {
  return encodePktLine(content);
}

// ============================================================================
// 测试
// ============================================================================

describe("parseLsRefsResponse()", () => {
  test("解析多条 ref（含 symref 和 peel）", () => {
    const data = Buffer.concat([
      refLine("95d09f2b10159347eece71399a7e2e907ea3df4f HEAD symref-target:refs/heads/main\n"),
      refLine("95d09f2b10159347eece71399a7e2e907ea3df4f refs/heads/main\n"),
      refLine("b8c7d5e7c8e7c8e7c8e7c8e7c8e7c8e7c8e7c8e7 refs/tags/v1.0\n"),
      refLine(
        "f3a2b1c0d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0 refs/tags/v1.0^{} peeled:f3a2b1c0d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0\n",
      ),
      encodeFlushPkt(),
    ]);

    const entries = parseLsRefsResponse(data);

    expect(entries).toHaveLength(4);

    // HEAD with symref
    expect(entries[0]!.refname).toBe("HEAD");
    expect(entries[0]!.oid).toBe("95d09f2b10159347eece71399a7e2e907ea3df4f");
    expect(entries[0]!.symrefTarget).toBe("refs/heads/main");
    expect(entries[0]!.peeled).toBeUndefined();

    // main branch
    expect(entries[1]!.refname).toBe("refs/heads/main");
    expect(entries[1]!.symrefTarget).toBeUndefined();

    // annotated tag
    expect(entries[2]!.refname).toBe("refs/tags/v1.0");

    // peeled tag (^{} 结尾的条目)
    expect(entries[3]!.refname).toBe("refs/tags/v1.0^{}");
    expect(entries[3]!.peeled).toBe("f3a2b1c0d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0");
  });

  test("解析单条 ref（无属性）", () => {
    const data = Buffer.concat([
      refLine("95d09f2b10159347eece71399a7e2e907ea3df4f refs/heads/main\n"),
      encodeFlushPkt(),
    ]);

    const entries = parseLsRefsResponse(data);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.refname).toBe("refs/heads/main");
    expect(entries[0]!.symrefTarget).toBeUndefined();
    expect(entries[0]!.peeled).toBeUndefined();
  });

  test("解析 unborn HEAD", () => {
    const data = Buffer.concat([
      refLine("unborn HEAD symref-target:refs/heads/main\n"),
      encodeFlushPkt(),
    ]);

    const entries = parseLsRefsResponse(data);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.oid).toBe("unborn");
    expect(entries[0]!.refname).toBe("HEAD");
    expect(entries[0]!.symrefTarget).toBe("refs/heads/main");
  });

  test("空响应返回空列表", () => {
    const data = Buffer.concat([encodeFlushPkt()]);
    const entries = parseLsRefsResponse(data);
    expect(entries).toHaveLength(0);
  });

  test("只有 flush 的响应返回空列表", () => {
    const entries = parseLsRefsResponse(Buffer.from("0000", "utf-8"));
    expect(entries).toHaveLength(0);
  });
});

describe("lsRefsToRefAdvertisement()", () => {
  test("将 ls-refs 结果转换为 v1 RefAdvertisement", () => {
    const entries: LsRefsEntry[] = [
      {
        oid: "95d09f2b10159347eece71399a7e2e907ea3df4f",
        refname: "HEAD",
        symrefTarget: "refs/heads/main",
      },
      { oid: "95d09f2b10159347eece71399a7e2e907ea3df4f", refname: "refs/heads/main" },
      { oid: "b8c7d5e7c8e7c8e7c8e7c8e7c8e7c8e7c8e7c8e7", refname: "refs/heads/develop" },
      { oid: "f3a2b1c0d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0", refname: "refs/tags/v1.0" },
    ];

    const adv = lsRefsToRefAdvertisement(entries);

    // defaultBranch 从 HEAD 的 symrefTarget 推断
    expect(adv.defaultBranch).toBe("refs/heads/main");
    expect(adv.refs).toHaveLength(4);
    expect(adv.refs[1]!.name).toBe("refs/heads/main");
    expect(adv.refs[3]!.name).toBe("refs/tags/v1.0");
  });

  test("转换时跳过 unborn 条目", () => {
    const entries: LsRefsEntry[] = [
      { oid: "unborn", refname: "HEAD", symrefTarget: "refs/heads/main" },
      { oid: "95d09f2b10159347eece71399a7e2e907ea3df4f", refname: "refs/heads/main" },
    ];

    const adv = lsRefsToRefAdvertisement(entries);

    // unborn HEAD 被跳过，只保留 refs/heads/main
    expect(adv.refs).toHaveLength(1);
    expect(adv.refs[0]!.name).toBe("refs/heads/main");
  });

  test("无 HEAD symref 时用 main/master 作为默认分支", () => {
    const entries: LsRefsEntry[] = [
      { oid: "95d09f2b10159347eece71399a7e2e907ea3df4f", refname: "refs/heads/main" },
    ];

    const adv = lsRefsToRefAdvertisement(entries);
    expect(adv.defaultBranch).toBe("refs/heads/main");
  });

  test("包含 peeled tag 时转换正确（^{} 条目被过滤，peeled 信息合并到父条目）", () => {
    const entries: LsRefsEntry[] = [
      { oid: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0", refname: "refs/tags/v1.0" },
      {
        oid: "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1",
        refname: "refs/tags/v1.0^{}",
        peeled: "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1",
      },
    ];

    const adv = lsRefsToRefAdvertisement(entries);
    // ^{} 条目被过滤，只有 tag 自身
    expect(adv.refs).toHaveLength(1);
    // peeled 信息合并到 tag 条目
    expect(adv.refs[0]!.peeled).toBe(sha1("b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1"));
  });
});
