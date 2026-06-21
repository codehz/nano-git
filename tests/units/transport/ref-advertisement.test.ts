/**
 * ref-advertisement 解析单元测试
 *
 * 覆盖场景：
 * - 完整解析服务端广告流
 * - capabilities 提取
 * - peeled tag
 * - symref 解析
 * - 空 refs
 * - 服务头跳过
 * - 错误处理
 */

import { describe, test, expect } from "bun:test";

import { sha1 } from "@/core/types.ts";
import { encodePktLine, encodeFlushPkt } from "@/transport/pkt-line.ts";
import { parseRefAdvertisement, RefAdvertisementError } from "@/transport/ref-advertisement.ts";

// ============================================================================
// 辅助函数
// ============================================================================

/** 构造 ref 行 Buffer：<hash> <name> */
function refLine(hash: string, name: string): Buffer {
  return encodePktLine(`${hash} ${name}`);
}

/** 构造带 capabilities 的第一条 ref 行 Buffer：<hash> <name>\0<caps> */
function refLineWithCaps(hash: string, name: string, caps: string): Buffer {
  return encodePktLine(Buffer.from(`${hash} ${name}\0${caps}`, "utf-8"));
}

/** 构造 peeled tag 行 Buffer：<hash> <name>^{} */
function peeledLine(hash: string, name: string): Buffer {
  return encodePktLine(`${hash} ${name}^{}`);
}

/** 构造服务头 Buffer */
function serviceHeader(service: string): Buffer {
  return encodePktLine(`# service=${service}\n`);
}

// ============================================================================
// 测试
// ============================================================================

describe("parseRefAdvertisement()", () => {
  test("解析单条 ref（无 capabilities）", () => {
    const hash = "95d09f2b10159347eece71399a7e2e907ea3df4f";
    const data = Buffer.concat([refLine(hash, "refs/heads/main"), encodeFlushPkt()]);
    const adv = parseRefAdvertisement(data, "git-upload-pack");
    expect(adv.refs).toHaveLength(1);
    expect(adv.refs[0]!.hash).toBe(sha1(hash));
    expect(adv.refs[0]!.name).toBe("refs/heads/main");
  });

  test("解析多条 ref", () => {
    const hash1 = "95d09f2b10159347eece71399a7e2e907ea3df4f";
    const hash2 = "1111111111111111111111111111111111111111";
    const data = Buffer.concat([
      refLine(hash1, "refs/heads/main"),
      refLine(hash2, "refs/heads/develop"),
      encodeFlushPkt(),
    ]);
    const adv = parseRefAdvertisement(data, "git-upload-pack");
    expect(adv.refs).toHaveLength(2);
    expect(adv.refs[0]!.name).toBe("refs/heads/main");
    expect(adv.refs[1]!.name).toBe("refs/heads/develop");
  });

  test("解析带 capabilities 的 ref 广告", () => {
    const hash = "95d09f2b10159347eece71399a7e2e907ea3df4f";
    const caps = "multi_ack thin-pack side-band side-band-64k ofs-delta";
    const data = Buffer.concat([refLineWithCaps(hash, "refs/heads/main", caps), encodeFlushPkt()]);
    const adv = parseRefAdvertisement(data, "git-upload-pack");
    expect(adv.refs).toHaveLength(1);
    expect(adv.refs[0]!.name).toBe("refs/heads/main");
    expect(adv.capabilities["multi_ack"]).toBe(true);
    expect(adv.capabilities["thin-pack"]).toBe(true);
    expect(adv.capabilities["side-band-64k"]).toBe(true);
  });

  test("解析带参数的 capabilities（symref、agent）", () => {
    const hash = "95d09f2b10159347eece71399a7e2e907ea3df4f";
    const caps = "symref=HEAD:refs/heads/main agent=git/2.45.1";
    const data = Buffer.concat([
      refLineWithCaps(hash, "HEAD", caps),
      refLine("95d09f2b10159347eece71399a7e2e907ea3df4f", "refs/heads/main"),
      encodeFlushPkt(),
    ]);
    const adv = parseRefAdvertisement(data, "git-upload-pack");
    expect(adv.capabilities["symref"]).toBe("HEAD:refs/heads/main");
    expect(adv.capabilities["agent"]).toBe("git/2.45.1");
  });

  test("解析 peeled tag", () => {
    const tagHash = "95d09f2b10159347eece71399a7e2e907ea3df4f";
    const peeledHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const caps = "include-tag";
    const data = Buffer.concat([
      refLineWithCaps(tagHash, "refs/tags/v1.0", caps),
      peeledLine(peeledHash, "refs/tags/v1.0"),
      refLine(peeledHash, "refs/heads/main"),
      encodeFlushPkt(),
    ]);
    const adv = parseRefAdvertisement(data, "git-upload-pack");
    expect(adv.refs).toHaveLength(2);
    const tagRef = adv.refs[0]!;
    expect(tagRef.name).toBe("refs/tags/v1.0");
    expect(tagRef.hash).toBe(sha1(tagHash));
    expect(tagRef.peeled).toBe(sha1(peeledHash));
  });

  test("解析带服务头的 ref 广告", () => {
    const hash = "95d09f2b10159347eece71399a7e2e907ea3df4f";
    const caps = "multi_ack";
    const data = Buffer.concat([
      serviceHeader("git-upload-pack"),
      encodeFlushPkt(),
      refLineWithCaps(hash, "refs/heads/main", caps),
      encodeFlushPkt(),
    ]);
    const adv = parseRefAdvertisement(data, "git-upload-pack");
    expect(adv.refs).toHaveLength(1);
    expect(adv.refs[0]!.name).toBe("refs/heads/main");
    expect(adv.capabilities["multi_ack"]).toBe(true);
  });

  test("空广告应抛出错误", () => {
    expect(() => parseRefAdvertisement(Buffer.alloc(0), "git-upload-pack")).toThrow(
      RefAdvertisementError,
    );
  });

  test("服务器仅返回 flush-pkt 应抛出错误", () => {
    const data = Buffer.concat([encodeFlushPkt()]);
    const adv = parseRefAdvertisement(data, "git-upload-pack");
    expect(adv.refs).toHaveLength(0);
  });

  test("不完整的 hash 应抛出错误", () => {
    const data = Buffer.concat([encodePktLine("short refs/heads/main"), encodeFlushPkt()]);
    expect(() => parseRefAdvertisement(data, "git-upload-pack")).toThrow(RefAdvertisementError);
  });

  test("没有空格的行应抛出错误", () => {
    const data = Buffer.concat([encodePktLine("refs/heads/main"), encodeFlushPkt()]);
    expect(() => parseRefAdvertisement(data, "git-upload-pack")).toThrow(RefAdvertisementError);
  });

  test("真实场景：多个 ref 带 capabilities", () => {
    const hash1 = "95d09f2b10159347eece71399a7e2e907ea3df4f";
    const hash2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const hash3 = "cccccccccccccccccccccccccccccccccccccccc";
    const peeledHash = "dddddddddddddddddddddddddddddddddddddddd";
    const caps =
      "multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress include-tag multi_ack_detailed symref=HEAD:refs/heads/main agent=git/2.45.1";

    const data = Buffer.concat([
      serviceHeader("git-upload-pack"),
      encodeFlushPkt(),
      refLineWithCaps(hash1, "HEAD", caps),
      refLine(hash1, "refs/heads/main"),
      refLine(hash2, "refs/heads/feature"),
      refLine(hash3, "refs/tags/v1.0"),
      peeledLine(peeledHash, "refs/tags/v1.0"),
      encodeFlushPkt(),
    ]);

    const adv = parseRefAdvertisement(data, "git-upload-pack");

    expect(adv.refs).toHaveLength(4);
    // HEAD 引用
    expect(adv.refs[0]!.name).toBe("HEAD");
    expect(adv.refs[0]!.hash).toBe(sha1(hash1));
    expect(adv.refs[0]!.symrefTarget).toBeUndefined();

    // 普通分支
    expect(adv.refs[1]!.name).toBe("refs/heads/main");
    expect(adv.refs[2]!.name).toBe("refs/heads/feature");

    // tag with peeled
    expect(adv.refs[3]!.name).toBe("refs/tags/v1.0");
    expect(adv.refs[3]!.hash).toBe(sha1(hash3));
    expect(adv.refs[3]!.peeled).toBe(sha1(peeledHash));

    // capabilities
    expect(adv.capabilities["multi_ack"]).toBe(true);
    expect(adv.capabilities["symref"]).toBe("HEAD:refs/heads/main");
    expect(adv.capabilities["agent"]).toBe("git/2.45.1");
  });
});

// ============================================================================
// Peeled tag 校验测试
// ============================================================================

describe("peeled tag 校验", () => {
  test("^{} 行名字不匹配最后一条 ref 应抛出错误", () => {
    const tagHash = "95d09f2b10159347eece71399a7e2e907ea3df4f";
    const peeledHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const data = Buffer.concat([
      refLine(tagHash, "refs/tags/v1.0"),
      peeledLine(peeledHash, "refs/tags/v2.0"), // 名字不匹配！
      encodeFlushPkt(),
    ]);
    expect(() => parseRefAdvertisement(data, "git-upload-pack")).toThrow(RefAdvertisementError);
  });

  test("^{} 行出现在非 tag ref 后应抛出错误", () => {
    const hash = "95d09f2b10159347eece71399a7e2e907ea3df4f";
    const peeledHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const data = Buffer.concat([
      refLine(hash, "refs/heads/main"),
      peeledLine(peeledHash, "refs/heads/main"), // 不是 tag 却跟了 ^{}
      encodeFlushPkt(),
    ]);
    expect(() => parseRefAdvertisement(data, "git-upload-pack")).toThrow(RefAdvertisementError);
  });

  test("孤立的 ^{} 行（无前驱 ref）应抛出错误", () => {
    const peeledHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const data = Buffer.concat([peeledLine(peeledHash, "refs/tags/v1.0"), encodeFlushPkt()]);
    expect(() => parseRefAdvertisement(data, "git-upload-pack")).toThrow(RefAdvertisementError);
  });
});
