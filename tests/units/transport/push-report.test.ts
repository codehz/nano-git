/**
 * transport/client/receive-pack/push-report.ts 单元测试
 *
 * 覆盖 processPushReport
 */

import { describe, test, expect } from "bun:test";

import { PushError } from "@/transport/client/receive-pack/push-error.ts";
import { processPushReport } from "@/transport/client/receive-pack/push-report.ts";
import { sha1 } from "@/types/index.ts";

import type { PushRefItem } from "@/transport/client/receive-pack/push-ref-plan.ts";
import type { ReceivePackCommand } from "@/transport/client/receive-pack/request.ts";
import type { PushRefUpdate } from "@/transport/protocol/types.ts";

const hash = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");

function makeCommand(refName: string): ReceivePackCommand {
  return {
    oldHash: sha1("0000000000000000000000000000000000000000"),
    newHash: hash,
    refName,
  };
}

function makePushRef(refName: string): PushRefItem {
  return { localHash: hash, remoteHash: null, remoteRef: refName, force: false, localRef: refName };
}

function makeRefUpdate(refName: string, success: boolean, error?: string): PushRefUpdate {
  return { refName, success, error, oldHash: hash, newHash: hash, forced: false };
}

describe("processPushReport()", () => {
  test("成功更新返回富化结果", () => {
    const commands = [makeCommand("refs/heads/main")];
    const refUpdates = [makeRefUpdate("refs/heads/main", true)];
    const pushRefs = [makePushRef("refs/heads/main")];

    const result = processPushReport(commands, refUpdates, pushRefs, []);
    expect(result.refUpdates).toHaveLength(1);
    expect(result.refUpdates[0]?.success).toBe(true);
    expect(result.refUpdates[0]?.refName).toBe("refs/heads/main");
  });

  test("空 refUpdates 抛出错误（已发送命令但无状态返回）", () => {
    const commands = [makeCommand("refs/heads/main")];

    expect(() => processPushReport(commands, [], [], [])).toThrow(PushError);
  });

  test("命令与更新数量不匹配抛出错误", () => {
    const commands = [makeCommand("refs/heads/a"), makeCommand("refs/heads/b")];
    const refUpdates = [makeRefUpdate("refs/heads/a", true)];

    expect(() => processPushReport(commands, refUpdates, [], [])).toThrow(PushError);
  });

  test("ref 名称不匹配抛出错误", () => {
    const commands = [makeCommand("refs/heads/a")];
    const refUpdates = [makeRefUpdate("refs/heads/b", true)];

    expect(() => processPushReport(commands, refUpdates, [], [])).toThrow(PushError);
  });

  test("服务端拒绝时抛出带详情的 PushError", () => {
    const commands = [makeCommand("refs/heads/main")];
    const refUpdates = [makeRefUpdate("refs/heads/main", false, "non-fast-forward")];
    const pushRefs = [makePushRef("refs/heads/main")];

    expect(() => processPushReport(commands, refUpdates, pushRefs, [])).toThrow(PushError);
  });

  test("富化后 refUpdate 补充 oldHash/newHash/forced", () => {
    const commands = [makeCommand("refs/heads/main")];
    const refUpdates = [makeRefUpdate("refs/heads/main", true)];
    const pushRefs: PushRefItem[] = [
      {
        localHash: hash,
        remoteHash: null,
        remoteRef: "refs/heads/main",
        force: true,
        localRef: "refs/heads/main",
      },
    ];

    const result = processPushReport(commands, refUpdates, pushRefs, []);
    expect(result.refUpdates[0]?.oldHash).toBeNull(); // remoteHash undefined 时转为 null
    expect(result.refUpdates[0]?.newHash).toBe(hash);
    expect(result.refUpdates[0]?.forced).toBe(true);
  });

  test("附带进度消息", () => {
    const commands = [makeCommand("refs/heads/main")];
    const refUpdates = [makeRefUpdate("refs/heads/main", true)];
    const pushRefs = [makePushRef("refs/heads/main")];
    const progress = ["Counting objects", "Compressing objects"];

    const result = processPushReport(commands, refUpdates, pushRefs, progress);
    expect(result.progress).toEqual(progress);
  });

  test("命令为空时不校验 refUpdates 数量", () => {
    const result = processPushReport([], [], [], []);
    expect(result.refUpdates).toEqual([]);
  });
});
