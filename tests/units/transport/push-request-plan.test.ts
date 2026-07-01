/**
 * transport/client/receive-pack/push-request-plan.ts 单元测试
 *
 * 覆盖 resolvePushParsedSpecs / validatePushCapabilities /
 *       buildPushCommands / buildPushRequestBody
 */

import { describe, test, expect } from "bun:test";

import { createMemoryRefStore } from "@/refs/memory.ts";
import { PushError } from "@/transport/client/receive-pack/push-error.ts";
import {
  resolvePushParsedSpecs,
  validatePushCapabilities,
  buildPushCommands,
  buildPushRequestBody,
} from "@/transport/client/receive-pack/push-request-plan.ts";
import { sha1 } from "@/types/index.ts";

import type { PushRefItem } from "@/transport/client/receive-pack/push-ref-plan.ts";

const hash = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");

describe("resolvePushParsedSpecs()", () => {
  test("无 options 时使用默认 refspec（当前分支）", () => {
    const refs = createMemoryRefStore();
    refs.write("HEAD", "ref: refs/heads/main");
    refs.write("refs/heads/main", hash);

    const specs = resolvePushParsedSpecs(refs);
    expect(specs.length).toBeGreaterThan(0);
  });

  test("force 选项使所有 refspec 的 force 为 true", () => {
    const refs = createMemoryRefStore();
    refs.write("HEAD", "ref: refs/heads/main");
    refs.write("refs/heads/main", hash);

    const specs = resolvePushParsedSpecs(refs, {
      force: true,
      refSpecs: ["refs/heads/main:refs/heads/main"],
    });
    expect(specs.every((s) => s.force)).toBe(true);
  });

  test("自定义 refspec", () => {
    const refs = createMemoryRefStore();
    const specs = resolvePushParsedSpecs(refs, { refSpecs: ["refs/heads/a:refs/heads/b"] });
    expect(specs[0]?.srcPattern).toBe("refs/heads/a");
    expect(specs[0]?.dstPattern).toBe("refs/heads/b");
  });
});

describe("validatePushCapabilities()", () => {
  test("必需能力存在时通过", () => {
    const adv: import("@/transport/protocol/types.ts").RefAdvertisement = {
      capabilities: { "report-status": true as true, "side-band-64k": true as true },
      refs: [],
      defaultBranch: "refs/heads/main",
    };
    const caps = validatePushCapabilities(adv, []);
    expect(caps).toContain("report-status");
    expect(caps).toContain("side-band-64k");
  });

  test("缺少 report-status 抛出 PushError", () => {
    const adv: import("@/transport/protocol/types.ts").RefAdvertisement = {
      capabilities: {},
      refs: [],
      defaultBranch: "refs/heads/main",
    };
    expect(() => validatePushCapabilities(adv, [])).toThrow(PushError);
  });

  test("包含删除命令且缺少 delete-refs 抛出错误", () => {
    const adv: import("@/transport/protocol/types.ts").RefAdvertisement = {
      capabilities: { "report-status": true as true },
      refs: [],
      defaultBranch: "refs/heads/main",
    };
    const pushRefs: PushRefItem[] = [
      {
        localHash: null,
        remoteHash: hash,
        remoteRef: "refs/heads/main",
        force: false,
        localRef: "refs/heads/main",
      },
    ];
    expect(() => validatePushCapabilities(adv, pushRefs)).toThrow(PushError);
  });

  test("删除命令且 delete-refs 存在时通过", () => {
    const adv: import("@/transport/protocol/types.ts").RefAdvertisement = {
      capabilities: { "report-status": true as true, "delete-refs": true as true },
      refs: [],
      defaultBranch: "refs/heads/main",
    };
    const pushRefs: PushRefItem[] = [
      {
        localHash: null,
        remoteHash: hash,
        remoteRef: "refs/heads/main",
        force: false,
        localRef: "refs/heads/main",
      },
    ];
    expect(() => validatePushCapabilities(adv, pushRefs)).not.toThrow();
  });
});

describe("buildPushCommands()", () => {
  test("常规推送到 ReceivePackCommand", () => {
    const pushRefs: PushRefItem[] = [
      {
        localHash: hash,
        remoteHash: null,
        remoteRef: "refs/heads/main",
        force: false,
        localRef: "refs/heads/main",
      },
    ];
    const commands = buildPushCommands(pushRefs);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.refName).toBe("refs/heads/main");
    expect(commands[0]?.oldHash).toBe(sha1("0000000000000000000000000000000000000000"));
    expect(commands[0]?.newHash).toBe(hash);
  });

  test("删除引用", () => {
    const pushRefs: PushRefItem[] = [
      {
        localHash: null,
        remoteHash: hash,
        remoteRef: "refs/heads/main",
        force: false,
        localRef: "refs/heads/main",
      },
    ];
    const commands = buildPushCommands(pushRefs);
    expect(commands[0]?.newHash).toBe(sha1("0000000000000000000000000000000000000000"));
    expect(commands[0]?.oldHash).toBe(hash);
  });

  test("多个 push ref", () => {
    const h1 = sha1("1111111111111111111111111111111111111111");
    const h2 = sha1("2222222222222222222222222222222222222222");
    const pushRefs: PushRefItem[] = [
      {
        localHash: h1,
        remoteHash: null,
        remoteRef: "refs/heads/a",
        force: false,
        localRef: "refs/heads/a",
      },
      {
        localHash: h2,
        remoteHash: h1,
        remoteRef: "refs/heads/b",
        force: false,
        localRef: "refs/heads/b",
      },
    ];
    const commands = buildPushCommands(pushRefs);
    expect(commands).toHaveLength(2);
  });
});

describe("buildPushRequestBody()", () => {
  test("构造请求 body", () => {
    const commands: import("@/transport/client/receive-pack/request.ts").ReceivePackCommand[] = [
      {
        oldHash: sha1("0000000000000000000000000000000000000000"),
        newHash: hash,
        refName: "refs/heads/main",
      },
    ];
    const packfile = Buffer.from("PACK data");
    const caps = ["report-status", "side-band-64k"];

    const body = buildPushRequestBody(commands, packfile, caps);
    expect(body.length).toBeGreaterThan(0);
    expect(body.toString("utf-8")).toContain("refs/heads/main");
  });
});
