/**
 * transport/client/upload-pack/capability-advertisement.ts 单元测试
 *
 * 覆盖 parseV2CapabilityAdvertisement / hasCommand / getCommandFeatures
 */

import { describe, test, expect } from "bun:test";

import { allocBytes, concatBytes, toUint8Array } from "../../helpers/bytes.ts";
import {
  parseV2CapabilityAdvertisement,
  hasCommand,
  getCommandFeatures,
  V2CapabilityError,
} from "@/transport/client/upload-pack/capability-advertisement.ts";
import { encodePktLine, encodeFlushPkt } from "@/transport/protocol/pkt-line.ts";

/** 编码 pkt-line 数据 */
function pkt(text: string): Uint8Array {
  return encodePktLine(text);
}

describe("parseV2CapabilityAdvertisement()", () => {
  test("解析基本能力广告", () => {
    const buf = concatBytes(
      pkt("version 2\n"),
      pkt("ls-refs\n"),
      pkt("fetch=shallow ref-in-want\n"),
      pkt("agent=nano-git/0.1\n"),
      encodeFlushPkt(),
    );

    const adv = parseV2CapabilityAdvertisement(buf);
    expect(adv.agent).toBe("nano-git/0.1");
    expect(adv.commands).toHaveLength(2);
    expect(adv.commands[0]?.name).toBe("ls-refs");
    expect(adv.commands[0]?.features).toEqual([]);
    expect(adv.commands[1]?.name).toBe("fetch");
    expect(adv.commands[1]?.features).toEqual(["shallow", "ref-in-want"]);
  });

  test("仅 version 2 行+flush", () => {
    const buf = concatBytes(pkt("version 2\n"), encodeFlushPkt());

    const adv = parseV2CapabilityAdvertisement(buf);
    expect(adv.commands).toEqual([]);
    expect(adv.capabilities).toEqual({});
  });

  test("无附加特性的命令", () => {
    const buf = concatBytes(
      pkt("version 2\n"),
      pkt("ls-refs\n"),
      pkt("object-info\n"),
      encodeFlushPkt(),
    );

    const adv = parseV2CapabilityAdvertisement(buf);
    expect(hasCommand(adv, "ls-refs")).toBe(true);
    expect(hasCommand(adv, "object-info")).toBe(true);
    expect(hasCommand(adv, "fetch")).toBe(false);
  });

  test("普通能力（非命令）", () => {
    const buf = concatBytes(
      pkt("version 2\n"),
      pkt("no-progress\n"),
      pkt("include-tag\n"),
      encodeFlushPkt(),
    );

    const adv = parseV2CapabilityAdvertisement(buf);
    expect(adv.capabilities["no-progress"]).toBe(true);
    expect(adv.capabilities["include-tag"]).toBe(true);
  });

  test("带值的能力", () => {
    const buf = concatBytes(
      pkt("version 2\n"),
      pkt("agent=git/2.39\n"),
      pkt("symref=HEAD:refs/heads/main\n"),
      encodeFlushPkt(),
    );

    const adv = parseV2CapabilityAdvertisement(buf);
    expect(adv.capabilities.agent).toBe("git/2.39");
    expect(adv.capabilities["symref"]).toBe("HEAD:refs/heads/main");
  });

  test("空数据抛出异常", () => {
    expect(() => parseV2CapabilityAdvertisement(allocBytes(0))).toThrow(V2CapabilityError);
  });

  test("非 version 2 首行抛出异常", () => {
    const buf = concatBytes(pkt("version 1\n"), encodeFlushPkt());
    expect(() => parseV2CapabilityAdvertisement(buf)).toThrow(V2CapabilityError);
    expect(() => parseV2CapabilityAdvertisement(buf)).toThrow(/Git-Protocol: version=2/);
  });

  test("无数据 pkt-line 被跳过", () => {
    const buf = concatBytes(pkt("version 2\n"), pkt("ls-refs\n"), encodeFlushPkt());

    const adv = parseV2CapabilityAdvertisement(buf);
    expect(hasCommand(adv, "ls-refs")).toBe(true);
  });

  test("剥离 Smart HTTP service 包装后解析 version 2", () => {
    const buf = concatBytes(
      pkt("# service=git-upload-pack\n"),
      encodeFlushPkt(),
      pkt("version 2\n"),
      pkt("ls-refs\n"),
      pkt("fetch=shallow ref-in-want\n"),
      pkt("agent=git/2.39\n"),
      encodeFlushPkt(),
    );

    const adv = parseV2CapabilityAdvertisement(buf);
    expect(adv.agent).toBe("git/2.39");
    expect(hasCommand(adv, "ls-refs")).toBe(true);
    expect(getCommandFeatures(adv, "fetch")).toEqual(["shallow", "ref-in-want"]);
  });

  test("service 包装后为 v0 ref 广告时给出清晰错误", () => {
    const buf = concatBytes(
      pkt("# service=git-upload-pack\n"),
      encodeFlushPkt(),
      // v0 风格首行（含 NUL + capabilities）
      pkt("95d09f2b10159347eece71399a7e2e907ea3df4f HEAD\0multi_ack thin-pack side-band-64k\n"),
      encodeFlushPkt(),
    );

    expect(() => parseV2CapabilityAdvertisement(buf)).toThrow(V2CapabilityError);
    expect(() => parseV2CapabilityAdvertisement(buf)).toThrow(/protocol v2/);
    expect(() => parseV2CapabilityAdvertisement(buf)).toThrow(/Git-Protocol: version=2/);
    // 不应只把 service 行当作 got 内容（service 已被消费）
    expect(() => parseV2CapabilityAdvertisement(buf)).not.toThrow(/got "# service=/);
  });

  test("错误的 service 名抛出异常", () => {
    const buf = concatBytes(
      pkt("# service=git-receive-pack\n"),
      encodeFlushPkt(),
      pkt("version 2\n"),
      encodeFlushPkt(),
    );

    expect(() => parseV2CapabilityAdvertisement(buf)).toThrow(V2CapabilityError);
    expect(() => parseV2CapabilityAdvertisement(buf)).toThrow(/git-upload-pack/);
    expect(() => parseV2CapabilityAdvertisement(buf)).toThrow(/git-receive-pack/);
  });

  test("service 头后缺少 flush 抛出异常", () => {
    const buf = concatBytes(
      pkt("# service=git-upload-pack\n"),
      pkt("version 2\n"),
      encodeFlushPkt(),
    );

    expect(() => parseV2CapabilityAdvertisement(buf)).toThrow(V2CapabilityError);
    expect(() => parseV2CapabilityAdvertisement(buf)).toThrow(/flush-pkt/);
  });
});

describe("hasCommand()", () => {
  test("存在命令返回 true", () => {
    const adv = parseV2CapabilityAdvertisement(
      concatBytes(pkt("version 2\n"), pkt("fetch=shallow\n"), encodeFlushPkt()),
    );
    expect(hasCommand(adv, "fetch")).toBe(true);
  });

  test("不存在命令返回 false", () => {
    const adv = parseV2CapabilityAdvertisement(concatBytes(pkt("version 2\n"), encodeFlushPkt()));
    expect(hasCommand(adv, "push")).toBe(false);
  });
});

describe("getCommandFeatures()", () => {
  test("获取命令特性", () => {
    const adv = parseV2CapabilityAdvertisement(
      concatBytes(pkt("version 2\n"), pkt("fetch=shallow ref-in-want\n"), encodeFlushPkt()),
    );
    const features = getCommandFeatures(adv, "fetch");
    expect(features).toEqual(["shallow", "ref-in-want"]);
  });

  test("无特性命令返回空数组", () => {
    const adv = parseV2CapabilityAdvertisement(
      concatBytes(pkt("version 2\n"), pkt("ls-refs\n"), encodeFlushPkt()),
    );
    expect(getCommandFeatures(adv, "ls-refs")).toEqual([]);
  });

  test("未知命令返回空数组", () => {
    const adv = parseV2CapabilityAdvertisement(concatBytes(pkt("version 2\n"), encodeFlushPkt()));
    expect(getCommandFeatures(adv, "nonexistent")).toEqual([]);
  });
});
