/**
 * transport/client/upload-pack/fetch.ts 单元测试
 *
 * 覆盖响应解析与多轮协商关键路径。
 */

import { describe, test, expect } from "bun:test";

import { createMemoryRepositoryBackend } from "@/backend/memory.ts";
import { writeObject } from "@/objects/raw.ts";
import {
  negotiateV2Fetch,
  parseV2FetchResponse,
  v2Fetch,
} from "@/transport/client/upload-pack/fetch.ts";
import {
  encodePktLine,
  encodeFlushPkt,
  encodeDelimiterPkt,
} from "@/transport/protocol/pkt-line.ts";
import { sha1 } from "@/types/index.ts";

import type { V2GitServiceTransport } from "@/transport/client/upload-pack/types.ts";

function pkt(text: string): Buffer {
  return encodePktLine(text);
}

function encodePackfileSection(payload = "PACK\u0000\u0000\u0000\u0002..."): Buffer {
  return Buffer.concat([
    pkt("packfile\n"),
    encodePktLine(Buffer.concat([Buffer.from([0x01]), Buffer.from(payload)])),
    encodeFlushPkt(),
  ]);
}

function createMockTransport(responses: Buffer[], calls: string[][]): V2GitServiceTransport {
  return {
    advertise(): Promise<never> {
      throw new Error("not implemented");
    },

    async command(_command: string, args?: string[]): Promise<Buffer> {
      calls.push([...(args ?? [])]);
      const response = responses.shift();
      if (!response) {
        throw new Error("missing mock response");
      }
      return response;
    },
  };
}

describe("parseV2FetchResponse()", () => {
  test("仅有 acknowledgments + NAK（无 packfile）", () => {
    const buf = Buffer.concat([pkt("acknowledgments\n"), pkt("NAK\n"), encodeFlushPkt()]);

    const result = parseV2FetchResponse(buf, false, false);
    expect(result.acknowledgments?.acks).toEqual([]);
    expect(result.acknowledgments?.nak).toBe(true);
    expect(result.packfile).toBeUndefined();
  });

  test("有 ACK 的响应", () => {
    const buf = Buffer.concat([
      pkt("acknowledgments\n"),
      pkt("ACK 95d09f2b10159347eece71399a7e2e907ea3df4f\n"),
      pkt("ACK aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d\n"),
      pkt("ready\n"),
      encodeDelimiterPkt(),
      encodeFlushPkt(),
    ]);

    const result = parseV2FetchResponse(buf, false, false);
    expect(result.acknowledgments?.acks).toHaveLength(2);
    expect(result.acknowledgments?.acks[0]).toBe("95d09f2b10159347eece71399a7e2e907ea3df4f");
    expect(result.acknowledgments?.acks[1]).toBe("aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");
    expect(result.acknowledgments?.ready).toBe(true);
  });

  test("packfile 数据提取", () => {
    // packfile 节头后跟 pkt-line 编码的包数据
    // 每个数据帧需要 channel 字节: 0x01 = packfile 数据
    const pktLine1 = Buffer.concat([
      Buffer.from([0x01]),
      Buffer.from("PACK\u0000\u0000\u0000\u0002..."),
    ]);
    const pktLine2 = Buffer.concat([Buffer.from([0x01]), Buffer.from("morepackdata")]);
    const buf = Buffer.concat([
      pkt("packfile\n"),
      encodePktLine(pktLine1),
      encodePktLine(pktLine2),
      encodeFlushPkt(),
    ]);

    const result = parseV2FetchResponse(buf, false, false);
    expect(result.packfile).toBeDefined();
    expect(result.packfile!.length).toBeGreaterThan(0);
    expect(result.packfile!.toString()).toContain("PACK");
  });

  test("空 packfile 节返回 undefined", () => {
    const buf = Buffer.concat([pkt("packfile\n"), encodeFlushPkt()]);

    const result = parseV2FetchResponse(buf, true, false);
    // 节头后无数据帧，packfileFrames 为空 → packfile 应为 undefined
    expect(result.packfile).toBeUndefined();
  });

  test("无节头的空响应", () => {
    const buf = Buffer.concat([pkt("\n"), encodeFlushPkt()]);

    const result = parseV2FetchResponse(buf, false, false);
    expect(result.acknowledgments).toBeUndefined();
    expect(result.packfile).toBeUndefined();
  });

  test("sideband-all 响应可正确解复用", () => {
    const channelized = (text: string): Buffer =>
      encodePktLine(Buffer.concat([Buffer.from([0x01]), Buffer.from(text)]));
    const buf = Buffer.concat([
      channelized("acknowledgments\n"),
      channelized("ACK 95d09f2b10159347eece71399a7e2e907ea3df4f\n"),
      encodeDelimiterPkt(),
      channelized("packfile\n"),
      encodePktLine(
        Buffer.concat([Buffer.from([0x01]), Buffer.from("PACK\u0000\u0000\u0000\u0002...")]),
      ),
      encodeFlushPkt(),
    ]);

    const result = parseV2FetchResponse(buf, false, true);
    expect(result.acknowledgments?.acks).toEqual(["95d09f2b10159347eece71399a7e2e907ea3df4f"]);
    expect(result.packfile?.subarray(0, 4).toString("utf-8")).toBe("PACK");
  });

  test("packfile section 中的 fatal channel 应抛错", () => {
    const buf = Buffer.concat([
      pkt("packfile\n"),
      encodePktLine(Buffer.concat([Buffer.from([0x03]), Buffer.from("boom\n")])),
      encodeFlushPkt(),
    ]);

    expect(() => parseV2FetchResponse(buf, false, false)).toThrow(/remote fatal: boom/);
  });
});

describe("v2 fetch 协商请求", () => {
  test("带 done 时仍发送 have 行", async () => {
    const calls: string[][] = [];
    const transport = createMockTransport([encodePackfileSection()], calls);

    await v2Fetch(
      transport,
      {
        wants: ["1111111111111111111111111111111111111111"],
        haves: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
        done: true,
        ofsDelta: true,
      },
      [],
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("have aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(calls[0]).toContain("done");
  });

  test("ready 响应已携带 packfile 时不再额外补发 done", async () => {
    const calls: string[][] = [];
    const common = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const response = Buffer.concat([
      pkt("acknowledgments\n"),
      pkt(`ACK ${common}\n`),
      pkt("ready\n"),
      encodeDelimiterPkt(),
      encodePackfileSection(),
    ]);
    const transport = createMockTransport([response], calls);

    const result = await negotiateV2Fetch(
      transport,
      ["1111111111111111111111111111111111111111"],
      [common],
    );

    expect(calls).toHaveLength(1);
    expect(result.packfile).toBeDefined();
  });

  test("ACK 过的 common 会在下一轮带 done replay", async () => {
    const calls: string[][] = [];
    const common = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const transport = createMockTransport(
      [
        Buffer.concat([pkt("acknowledgments\n"), pkt(`ACK ${common}\n`), encodeFlushPkt()]),
        encodePackfileSection(),
      ],
      calls,
    );

    await negotiateV2Fetch(transport, ["1111111111111111111111111111111111111111"], [common]);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain(`have ${common}`);
    expect(calls[0]).not.toContain("done");
    expect(calls[1]).toContain(`have ${common}`);
    expect(calls[1]).toContain("done");
  });

  test("多条 ACK common 会按 Git oidset 顺序在下一轮 replay", async () => {
    const calls: string[][] = [];
    const main = "b52f41dc702f7c75bdaf095f588179e449b893d4";
    const topicOld = "e0a43b5c93718a394575306cf257cce6e587baea";
    const topicRecent = "57d610da821e9d1500b28e901be034760391af43";
    const transport = createMockTransport(
      [
        Buffer.concat([
          pkt("acknowledgments\n"),
          pkt(`ACK ${main}\n`),
          pkt(`ACK ${topicOld}\n`),
          pkt(`ACK ${topicRecent}\n`),
          encodeFlushPkt(),
        ]),
        encodePackfileSection(),
      ],
      calls,
    );

    await negotiateV2Fetch(
      transport,
      ["1111111111111111111111111111111111111111"],
      [main, topicOld, topicRecent],
    );

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual([
      "thin-pack",
      "no-progress",
      "include-tag",
      "ofs-delta",
      "want 1111111111111111111111111111111111111111",
      `have ${topicOld}`,
      `have ${main}`,
      `have ${topicRecent}`,
      "done",
    ]);
  });

  test("提供本地对象源时优先发送较新的 commit have", async () => {
    const backend = createMemoryRepositoryBackend();
    const treeHash = writeObject(backend.objects, { type: "tree", entries: [] });
    const root = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [],
      author: { name: "T", email: "t@t", timestamp: 1, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 1, timezone: "+0000" },
      message: "root\n",
    });
    const older = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [root],
      author: { name: "T", email: "t@t", timestamp: 2, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 2, timezone: "+0000" },
      message: "older\n",
    });
    const newer = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [root],
      author: { name: "T", email: "t@t", timestamp: 3, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 3, timezone: "+0000" },
      message: "newer\n",
    });

    const calls: string[][] = [];
    const transport = createMockTransport([encodePackfileSection()], calls);

    await negotiateV2Fetch(
      transport,
      [sha1("1111111111111111111111111111111111111111")],
      [root, older, newer],
      [],
      backend.objects,
    );

    const haveLines = calls[0]!.filter((line) => line.startsWith("have "));
    expect(haveLines).toEqual([`have ${newer}`, `have ${older}`, `have ${root}`]);
  });

  test("无 known common 约束时，多 tip 首轮会继续沿祖先链发送 have", async () => {
    const backend = createMemoryRepositoryBackend();
    const treeHash = writeObject(backend.objects, { type: "tree", entries: [] });
    const root = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [],
      author: { name: "T", email: "t@t", timestamp: 1, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 1, timezone: "+0000" },
      message: "root\n",
    });
    const base = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [root],
      author: { name: "T", email: "t@t", timestamp: 2, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 2, timezone: "+0000" },
      message: "base\n",
    });
    const mainTip = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [base],
      author: { name: "T", email: "t@t", timestamp: 3, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 3, timezone: "+0000" },
      message: "main\n",
    });
    const featureTip = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [base],
      author: { name: "T", email: "t@t", timestamp: 4, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 4, timezone: "+0000" },
      message: "feature\n",
    });

    const calls: string[][] = [];
    const transport = createMockTransport([encodePackfileSection()], calls);

    await negotiateV2Fetch(
      transport,
      [sha1("1111111111111111111111111111111111111111")],
      [mainTip, featureTip],
      [],
      backend.objects,
    );

    const haveLines = calls[0]!.filter((line) => line.startsWith("have "));
    expect(haveLines).toEqual([
      `have ${featureTip}`,
      `have ${mainTip}`,
      `have ${base}`,
      `have ${root}`,
    ]);
  });

  test("仅有单个本地 tip 时，首轮会沿祖先链继续发送 have", async () => {
    const backend = createMemoryRepositoryBackend();
    const treeHash = writeObject(backend.objects, { type: "tree", entries: [] });
    const root = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [],
      author: { name: "T", email: "t@t", timestamp: 1, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 1, timezone: "+0000" },
      message: "root\n",
    });
    const middle = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [root],
      author: { name: "T", email: "t@t", timestamp: 2, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 2, timezone: "+0000" },
      message: "middle\n",
    });
    const tip = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [middle],
      author: { name: "T", email: "t@t", timestamp: 3, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 3, timezone: "+0000" },
      message: "tip\n",
    });

    const calls: string[][] = [];
    const transport = createMockTransport([encodePackfileSection()], calls);

    await negotiateV2Fetch(
      transport,
      [sha1("1111111111111111111111111111111111111111")],
      [tip],
      [],
      backend.objects,
    );

    const haveLines = calls[0]!.filter((line) => line.startsWith("have "));
    expect(haveLines).toEqual([`have ${tip}`, `have ${middle}`, `have ${root}`]);
  });

  test("若覆盖者不是远端已知公共 ref，首轮仍保留被覆盖 tip 并继续祖先协商", async () => {
    const backend = createMemoryRepositoryBackend();
    const treeHash = writeObject(backend.objects, { type: "tree", entries: [] });
    const root = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [],
      author: { name: "T", email: "t@t", timestamp: 1, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 1, timezone: "+0000" },
      message: "root\n",
    });
    const mainTip = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [root],
      author: { name: "T", email: "t@t", timestamp: 2, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 2, timezone: "+0000" },
      message: "main\n",
    });
    const featureTip = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [mainTip],
      author: { name: "T", email: "t@t", timestamp: 3, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 3, timezone: "+0000" },
      message: "feature\n",
    });

    const calls: string[][] = [];
    const transport = createMockTransport([encodePackfileSection()], calls);

    await negotiateV2Fetch(
      transport,
      [sha1("1111111111111111111111111111111111111111")],
      [mainTip, featureTip],
      [],
      backend.objects,
    );

    const haveLines = calls[0]!.filter((line) => line.startsWith("have "));
    expect(haveLines).toEqual([`have ${featureTip}`, `have ${mainTip}`, `have ${root}`]);
  });

  test("远端已知公共 ref 会抑制更老祖先的无效 have", async () => {
    const backend = createMemoryRepositoryBackend();
    const treeHash = writeObject(backend.objects, { type: "tree", entries: [] });
    const root = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [],
      author: { name: "T", email: "t@t", timestamp: 1, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 1, timezone: "+0000" },
      message: "root\n",
    });
    const mainTip = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [root],
      author: { name: "T", email: "t@t", timestamp: 2, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 2, timezone: "+0000" },
      message: "main\n",
    });
    const featureTip = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [mainTip],
      author: { name: "T", email: "t@t", timestamp: 3, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 3, timezone: "+0000" },
      message: "feature\n",
    });

    const calls: string[][] = [];
    const transport = createMockTransport([encodePackfileSection()], calls);

    await negotiateV2Fetch(
      transport,
      [sha1("1111111111111111111111111111111111111111")],
      [featureTip],
      [],
      backend.objects,
      [mainTip],
    );

    const haveLines = calls[0]!.filter((line) => line.startsWith("have "));
    expect(haveLines).toEqual([`have ${featureTip}`, `have ${mainTip}`]);
  });

  test("若被覆盖的 tip 同时是远端已知公共 ref，首轮仍保留该 tip", async () => {
    const backend = createMemoryRepositoryBackend();
    const treeHash = writeObject(backend.objects, { type: "tree", entries: [] });
    const root = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [],
      author: { name: "T", email: "t@t", timestamp: 1, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 1, timezone: "+0000" },
      message: "root\n",
    });
    const mainTip = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [root],
      author: { name: "T", email: "t@t", timestamp: 2, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 2, timezone: "+0000" },
      message: "main\n",
    });
    const featureTip = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [mainTip],
      author: { name: "T", email: "t@t", timestamp: 3, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 3, timezone: "+0000" },
      message: "feature\n",
    });

    const calls: string[][] = [];
    const transport = createMockTransport([encodePackfileSection()], calls);

    await negotiateV2Fetch(
      transport,
      [sha1("1111111111111111111111111111111111111111")],
      [mainTip, featureTip],
      [],
      backend.objects,
      [mainTip],
    );

    const haveLines = calls[0]!.filter((line) => line.startsWith("have "));
    expect(haveLines).toEqual([`have ${mainTip}`, `have ${featureTip}`]);
  });

  test("commit-aware 协商会先 peel annotated tag，并避免发送 tag 对象 have", async () => {
    const backend = createMemoryRepositoryBackend();
    const treeHash = writeObject(backend.objects, { type: "tree", entries: [] });
    const root = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [],
      author: { name: "T", email: "t@t", timestamp: 1, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 1, timezone: "+0000" },
      message: "root\n",
    });
    const mainTip = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [root],
      author: { name: "T", email: "t@t", timestamp: 2, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 2, timezone: "+0000" },
      message: "main\n",
    });
    const tagHash = writeObject(backend.objects, {
      type: "tag",
      object: mainTip,
      objectType: "commit",
      tag: "v1.0.0",
      tagger: { name: "T", email: "t@t", timestamp: 3, timezone: "+0000" },
      message: "v1.0.0\n",
    });

    const calls: string[][] = [];
    const transport = createMockTransport([encodePackfileSection()], calls);

    await negotiateV2Fetch(
      transport,
      [sha1("1111111111111111111111111111111111111111")],
      [mainTip, tagHash],
      [],
      backend.objects,
    );

    const haveLines = calls[0]!.filter((line) => line.startsWith("have "));
    expect(haveLines).toEqual([`have ${mainTip}`, `have ${root}`]);
    expect(haveLines).not.toContain(`have ${tagHash}`);
  });

  test("协商默认不主动请求 sideband-all", async () => {
    const calls: string[][] = [];
    const transport = createMockTransport([encodePackfileSection()], calls);

    await negotiateV2Fetch(
      transport,
      ["1111111111111111111111111111111111111111"],
      [],
      ["sideband-all"],
    );

    expect(calls[0]).not.toContain("sideband-all");
  });

  test("协商默认携带 thin-pack、no-progress 与 include-tag", async () => {
    const calls: string[][] = [];
    const transport = createMockTransport([encodePackfileSection()], calls);

    await negotiateV2Fetch(
      transport,
      ["1111111111111111111111111111111111111111"],
      ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    );

    expect(calls[0]).toContain("thin-pack");
    expect(calls[0]).toContain("no-progress");
    expect(calls[0]).toContain("include-tag");
    expect(calls[0]).toContain("ofs-delta");
  });
});
