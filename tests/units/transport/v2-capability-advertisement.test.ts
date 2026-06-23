/**
 * transport/client/upload-pack/capability-advertisement.ts 单元测试
 *
 * 覆盖 parseV2CapabilityAdvertisement / hasCommand / getCommandFeatures
 */

import { describe, test, expect } from "bun:test";

import {
  parseV2CapabilityAdvertisement,
  hasCommand,
  getCommandFeatures,
  V2CapabilityError,
} from "@/transport/client/upload-pack/capability-advertisement.ts";
import { encodePktLine, encodeFlushPkt } from "@/transport/protocol/pkt-line.ts";

/** 编码 pkt-line 数据 */
function pkt(text: string): Buffer {
  return encodePktLine(text);
}

describe("parseV2CapabilityAdvertisement()", () => {
  test("解析基本能力广告", () => {
    const buf = Buffer.concat([
      pkt("version 2\n"),
      pkt("ls-refs\n"),
      pkt("fetch=shallow ref-in-want\n"),
      pkt("agent=nano-git/0.1\n"),
      encodeFlushPkt(),
    ]);

    const adv = parseV2CapabilityAdvertisement(buf);
    expect(adv.agent).toBe("nano-git/0.1");
    expect(adv.commands).toHaveLength(2);
    expect(adv.commands[0]?.name).toBe("ls-refs");
    expect(adv.commands[0]?.features).toEqual([]);
    expect(adv.commands[1]?.name).toBe("fetch");
    expect(adv.commands[1]?.features).toEqual(["shallow", "ref-in-want"]);
  });

  test("仅 version 2 行+flush", () => {
    const buf = Buffer.concat([pkt("version 2\n"), encodeFlushPkt()]);

    const adv = parseV2CapabilityAdvertisement(buf);
    expect(adv.commands).toEqual([]);
    expect(adv.capabilities).toEqual({});
  });

  test("无附加特性的命令", () => {
    const buf = Buffer.concat([
      pkt("version 2\n"),
      pkt("ls-refs\n"),
      pkt("object-info\n"),
      encodeFlushPkt(),
    ]);

    const adv = parseV2CapabilityAdvertisement(buf);
    expect(hasCommand(adv, "ls-refs")).toBe(true);
    expect(hasCommand(adv, "object-info")).toBe(true);
    expect(hasCommand(adv, "fetch")).toBe(false);
  });

  test("普通能力（非命令）", () => {
    const buf = Buffer.concat([
      pkt("version 2\n"),
      pkt("no-progress\n"),
      pkt("include-tag\n"),
      encodeFlushPkt(),
    ]);

    const adv = parseV2CapabilityAdvertisement(buf);
    expect(adv.capabilities["no-progress"]).toBe(true);
    expect(adv.capabilities["include-tag"]).toBe(true);
  });

  test("带值的能力", () => {
    const buf = Buffer.concat([
      pkt("version 2\n"),
      pkt("agent=git/2.39\n"),
      pkt("symref=HEAD:refs/heads/main\n"),
      encodeFlushPkt(),
    ]);

    const adv = parseV2CapabilityAdvertisement(buf);
    expect(adv.capabilities.agent).toBe("git/2.39");
    expect(adv.capabilities["symref"]).toBe("HEAD:refs/heads/main");
  });

  test("空数据抛出异常", () => {
    expect(() => parseV2CapabilityAdvertisement(Buffer.from([]))).toThrow(V2CapabilityError);
  });

  test("非 version 2 首行抛出异常", () => {
    const buf = Buffer.concat([pkt("version 1\n"), encodeFlushPkt()]);
    expect(() => parseV2CapabilityAdvertisement(buf)).toThrow(V2CapabilityError);
  });

  test("无数据 pkt-line 被跳过", () => {
    const buf = Buffer.concat([pkt("version 2\n"), pkt("ls-refs\n"), encodeFlushPkt()]);

    const adv = parseV2CapabilityAdvertisement(buf);
    expect(hasCommand(adv, "ls-refs")).toBe(true);
  });
});

describe("hasCommand()", () => {
  test("存在命令返回 true", () => {
    const adv = parseV2CapabilityAdvertisement(
      Buffer.concat([pkt("version 2\n"), pkt("fetch=shallow\n"), encodeFlushPkt()]),
    );
    expect(hasCommand(adv, "fetch")).toBe(true);
  });

  test("不存在命令返回 false", () => {
    const adv = parseV2CapabilityAdvertisement(
      Buffer.concat([pkt("version 2\n"), encodeFlushPkt()]),
    );
    expect(hasCommand(adv, "push")).toBe(false);
  });
});

describe("getCommandFeatures()", () => {
  test("获取命令特性", () => {
    const adv = parseV2CapabilityAdvertisement(
      Buffer.concat([pkt("version 2\n"), pkt("fetch=shallow ref-in-want\n"), encodeFlushPkt()]),
    );
    const features = getCommandFeatures(adv, "fetch");
    expect(features).toEqual(["shallow", "ref-in-want"]);
  });

  test("无特性命令返回空数组", () => {
    const adv = parseV2CapabilityAdvertisement(
      Buffer.concat([pkt("version 2\n"), pkt("ls-refs\n"), encodeFlushPkt()]),
    );
    expect(getCommandFeatures(adv, "ls-refs")).toEqual([]);
  });

  test("未知命令返回空数组", () => {
    const adv = parseV2CapabilityAdvertisement(
      Buffer.concat([pkt("version 2\n"), encodeFlushPkt()]),
    );
    expect(getCommandFeatures(adv, "nonexistent")).toEqual([]);
  });
});
