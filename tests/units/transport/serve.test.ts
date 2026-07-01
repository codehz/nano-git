/**
 * upload-pack 服务端单元测试
 *
 * 测试协议解析、能力广告生成、ls-refs 响应生成、fetch 响应生成。
 * 使用内存后端，不依赖 HTTP 或文件系统。
 */

import { describe, test, expect } from "bun:test";

import { createMemoryRepositoryBackend } from "@/backend/memory.ts";
import { writeObject } from "@/objects/raw.ts";
import {
  encodePktLine,
  encodeDelimiterPkt,
  encodeFlushPkt,
  parsePktLines,
} from "@/transport/protocol/pkt-line.ts";
import { createUploadPackService } from "@/transport/server/upload-pack/index.ts";
import {
  parseCommandRequest,
  parseLsRefsArgs,
  parseFetchArgs,
  generateLsRefsResponse,
  generateFetchResponse,
  advertiseUploadPack,
} from "@/transport/server/upload-pack/index.ts";
import { sha1 } from "@/types/index.ts";

import type { SHA1 } from "@/types/index.ts";

// ============================================================================
// 测试辅助：构建一个带提交的内存仓库
// ============================================================================

interface TestRepoFixtures {
  backend: ReturnType<typeof createMemoryRepositoryBackend>;
  mainCommit: SHA1;
  developCommit: SHA1;
  blobHash: SHA1;
}

function createTestRepo(): TestRepoFixtures {
  const backend = createMemoryRepositoryBackend({
    initialRefs: new Map<string, string>([["HEAD", "ref: refs/heads/main"]]),
  });

  // blob
  const blobHash = writeObject(backend.objects, {
    type: "blob" as const,
    content: Buffer.from("hello world"),
  });

  // tree
  const treeHash = writeObject(backend.objects, {
    type: "tree" as const,
    entries: [{ mode: "100644", name: "readme.txt", hash: blobHash }],
  });

  // first commit on main
  const mainCommit = writeObject(backend.objects, {
    type: "commit" as const,
    tree: treeHash,
    parents: [],
    author: { name: "Test", email: "test@test", timestamp: 1000000, timezone: "+0000" },
    committer: { name: "Test", email: "test@test", timestamp: 1000000, timezone: "+0000" },
    message: "initial commit\n",
  });
  backend.refs.write("refs/heads/main", mainCommit);

  // second commit on develop
  const developCommit = writeObject(backend.objects, {
    type: "commit" as const,
    tree: treeHash,
    parents: [mainCommit],
    author: { name: "Test", email: "test@test", timestamp: 1000001, timezone: "+0000" },
    committer: { name: "Test", email: "test@test", timestamp: 1000001, timezone: "+0000" },
    message: "develop commit\n",
  });
  backend.refs.write("refs/heads/develop", developCommit);

  // tag pointing to mainCommit
  const tagHash = writeObject(backend.objects, {
    type: "tag" as const,
    object: mainCommit,
    objectType: "commit" as const,
    tag: "v1.0",
    tagger: { name: "Test", email: "test@test", timestamp: 1000002, timezone: "+0000" },
    message: "v1.0\n",
  });
  backend.refs.write("refs/tags/v1.0", tagHash);

  return { backend, mainCommit, developCommit, blobHash };
}

// ============================================================================
// parseCommandRequest
// ============================================================================

describe("parseCommandRequest", () => {
  test("解析 ls-refs 命令请求", () => {
    const body = Buffer.concat([
      encodePktLine("command=ls-refs\n"),
      encodePktLine("agent=nano-git/0.1\n"),
      encodeDelimiterPkt(),
      encodePktLine("symrefs\n"),
      encodePktLine("peel\n"),
      encodeFlushPkt(),
    ]);

    const cmd = parseCommandRequest(body);
    expect(cmd.command).toBe("ls-refs");
    expect(cmd.capabilities).toEqual(["agent=nano-git/0.1"]);
    expect(cmd.args).toEqual(["symrefs", "peel"]);
  });

  test("解析 fetch 命令（带 want + done）", () => {
    const hash = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
    const body = Buffer.concat([
      encodePktLine("command=fetch\n"),
      encodePktLine("agent=nano-git/0.1\n"),
      encodeDelimiterPkt(),
      encodePktLine(`want ${hash}\n`),
      encodePktLine("done\n"),
      encodeFlushPkt(),
    ]);

    const cmd = parseCommandRequest(body);
    expect(cmd.command).toBe("fetch");
    expect(cmd.args).toEqual([`want ${hash}`, "done"]);
  });

  test("解析 fetch 命令（带 want + have 无 done）", () => {
    const wantHash = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
    const haveHash = sha1("0000000000000000000000000000000000000001");
    const body = Buffer.concat([
      encodePktLine("command=fetch\n"),
      encodeDelimiterPkt(),
      encodePktLine(`want ${wantHash}\n`),
      encodePktLine(`have ${haveHash}\n`),
      encodeFlushPkt(),
    ]);

    const cmd = parseCommandRequest(body);
    expect(cmd.command).toBe("fetch");
    expect(cmd.args).toEqual([`want ${wantHash}`, `have ${haveHash}`]);
  });

  test("解析带 want-ref 的 fetch 命令", () => {
    const body = Buffer.concat([
      encodePktLine("command=fetch\n"),
      encodeDelimiterPkt(),
      encodePktLine("want-ref refs/heads/main\n"),
      encodePktLine("done\n"),
      encodeFlushPkt(),
    ]);

    const cmd = parseCommandRequest(body);
    expect(cmd.command).toBe("fetch");
    expect(cmd.args).toContain("want-ref refs/heads/main");
    expect(cmd.args).toContain("done");
  });

  test("解析 inline args（无 delimiter）", () => {
    // 没有 delimiter 时，首行之后的所有行都是 capabilities
    const body = Buffer.concat([
      encodePktLine("command=ls-refs\n"),
      encodePktLine("symrefs\n"),
      encodeFlushPkt(),
    ]);

    const cmd = parseCommandRequest(body);
    expect(cmd.command).toBe("ls-refs");
    expect(cmd.args).toEqual([]);
    expect(cmd.capabilities).toEqual(["symrefs"]);
  });
});

// ============================================================================
// parseLsRefsArgs
// ============================================================================

describe("parseLsRefsArgs", () => {
  test("解析全部选项", () => {
    const opts = parseLsRefsArgs(["symrefs", "peel", "ref-prefix refs/heads/"]);
    expect(opts.symrefs).toBe(true);
    expect(opts.peel).toBe(true);
    expect(opts.refPrefixes).toEqual(["refs/heads/"]);
    expect(opts.unborn).toBe(false);
  });

  test("解析 unborn 和多个 ref-prefix", () => {
    const opts = parseLsRefsArgs([
      "symrefs",
      "unborn",
      "ref-prefix refs/heads/",
      "ref-prefix refs/tags/",
    ]);
    expect(opts.symrefs).toBe(true);
    expect(opts.unborn).toBe(true);
    expect(opts.refPrefixes).toEqual(["refs/heads/", "refs/tags/"]);
  });

  test("空 args", () => {
    const opts = parseLsRefsArgs([]);
    expect(opts.symrefs).toBe(false);
    expect(opts.peel).toBe(false);
    expect(opts.unborn).toBe(false);
    expect(opts.refPrefixes).toEqual([]);
  });
});

// ============================================================================
// parseFetchArgs
// ============================================================================

describe("parseFetchArgs", () => {
  test("解析 want + done", () => {
    const hash = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
    const params = parseFetchArgs([`want ${hash}`, "done"]);
    expect(params.wants).toEqual([hash]);
    expect(params.done).toBe(true);
    expect(params.haves).toEqual([]);
  });

  test("解析多个 want 和 have", () => {
    const want1 = sha1("1111111111111111111111111111111111111111");
    const want2 = sha1("2222222222222222222222222222222222222222");
    const have1 = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const have2 = sha1("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

    const params = parseFetchArgs([
      `want ${want1}`,
      `want ${want2}`,
      `have ${have1}`,
      `have ${have2}`,
    ]);
    expect(params.wants).toEqual([want1, want2]);
    expect(params.haves).toEqual([have1, have2]);
    expect(params.done).toBe(false);
  });

  test("解析 want-ref", () => {
    const hash = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
    const params = parseFetchArgs([`want ${hash}`, "want-ref refs/heads/main", "done"]);
    expect(params.wants).toEqual([hash]);
    expect(params.wantRefs).toEqual(["refs/heads/main"]);
    expect(params.done).toBe(true);
  });

  test("解析 thin-pack / no-progress / ofs-delta 标记", () => {
    const hash = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
    const params = parseFetchArgs([
      `want ${hash}`,
      "thin-pack",
      "no-progress",
      "ofs-delta",
      "done",
    ]);
    expect(params.thinPack).toBe(true);
    expect(params.noProgress).toBe(true);
    expect(params.ofsDelta).toBe(true);
  });
});

// ============================================================================
// advertiseUploadPack
// ============================================================================

describe("advertiseUploadPack", () => {
  test("upload-pack 广告包含 version 2、ls-refs、fetch", () => {
    const buf = advertiseUploadPack();
    const text = buf.toString("utf-8");

    expect(text).toContain("version 2");
    expect(text).toContain("ls-refs");
    expect(text).toContain("fetch=shallow ref-in-want filter");
    expect(text).toContain("agent=nano-git/0.1");
  });
});

// ============================================================================
// generateLsRefsResponse
// ============================================================================

describe("generateLsRefsResponse", () => {
  test("返回所有 refs（无前缀过滤）", () => {
    const { backend, mainCommit } = createTestRepo();
    const buf = generateLsRefsResponse(backend, {
      symrefs: false,
      peel: false,
      unborn: false,
      refPrefixes: [],
    });

    const text = buf.toString("utf-8");
    // 应包含 refs/heads/main
    expect(text).toContain(`refs/heads/main`);
    expect(text).toContain(mainCommit);
    // 应包含 refs/heads/develop
    expect(text).toContain(`refs/heads/develop`);
    // HEAD 符号引用应包含（unborn=false 时 unborn 分支不显示，但 HEAD 有 resolved 值时应显示）
    // mainCommit 在 HEAD 中作为 resolved 值
    expect(text).toContain("HEAD");
  });

  test("ref-prefix 过滤只返回匹配的 refs", () => {
    const { backend } = createTestRepo();
    const buf = generateLsRefsResponse(backend, {
      symrefs: false,
      peel: false,
      unborn: false,
      refPrefixes: ["refs/heads/"],
    });

    const text = buf.toString("utf-8");
    expect(text).toContain("refs/heads/main");
    expect(text).toContain("refs/heads/develop");
    // refs/tags/ 不应出现
    expect(text).not.toContain("refs/tags/");
  });

  test("symrefs 选项返回符号引用目标", () => {
    const { backend } = createTestRepo();
    const buf = generateLsRefsResponse(backend, {
      symrefs: true,
      peel: false,
      unborn: false,
      refPrefixes: [],
    });

    const text = buf.toString("utf-8");
    expect(text).toMatch(/HEAD.*symref-target:refs\/heads\/main/);
  });

  test("peel 选项对 annotated tag 返回 peeled 信息", () => {
    const { backend, mainCommit } = createTestRepo();

    // 创建 annotated tag ref
    const tagHash = writeObject(backend.objects, {
      type: "tag" as const,
      object: mainCommit,
      objectType: "commit" as const,
      tag: "v1.0",
      tagger: { name: "Tagger", email: "tag@test", timestamp: 1000000, timezone: "+0000" },
      message: "v1.0\n",
    });
    backend.refs.write("refs/tags/v1.0", tagHash);

    const buf = generateLsRefsResponse(backend, {
      symrefs: false,
      peel: true,
      unborn: false,
      refPrefixes: [],
    });

    const text = buf.toString("utf-8");
    // 应包含 peeled: 信息
    expect(text).toContain(`peeled:${mainCommit}`);
  });

  test("过滤掉前缀不匹配的 refs", () => {
    const { backend } = createTestRepo();
    const buf = generateLsRefsResponse(backend, {
      symrefs: false,
      peel: false,
      unborn: false,
      refPrefixes: ["refs/tags/"],
    });

    const text = buf.toString("utf-8");
    expect(text).not.toContain("refs/heads/");
  });
});

// ============================================================================
// generateFetchResponse（clone — 无 haves）
// ============================================================================

describe("generateFetchResponse — clone", () => {
  test("发送 done 时返回 packfile", () => {
    const { backend, mainCommit } = createTestRepo();
    const buf = generateFetchResponse(backend, {
      wants: [mainCommit],
      haves: [],
      wantRefs: [],
      done: true,
      thinPack: false,
      noProgress: false,
      ofsDelta: true,
    });

    const text = buf.toString("utf-8");
    // 应包含 packfile 节
    expect(text).toContain("packfile");
    // 不应有 acknowledgments 节
    expect(text).not.toContain("acknowledgments");
    // packfile 数据应存在
    const pktLines = parsePktLines(buf);
    expect(pktLines.length).toBeGreaterThan(0);
  });

  test("packfile 包含所有可达对象", () => {
    const { backend, mainCommit } = createTestRepo();
    const buf = generateFetchResponse(backend, {
      wants: [mainCommit],
      haves: [],
      wantRefs: [],
      done: true,
      thinPack: false,
      noProgress: false,
      ofsDelta: true,
    });

    // packfile 节后的 side-band 数据应包含 "PACK"
    const fullText = buf.toString("hex");
    expect(fullText).toContain("5041434b"); // "PACK" in hex
  });

  test("want 不存在的对象返回 side-band fatal 错误", () => {
    const { backend } = createTestRepo();
    const fakeHash = sha1("0000000000000000000000000000000000000000");
    const buf = generateFetchResponse(backend, {
      wants: [fakeHash],
      haves: [],
      wantRefs: [],
      done: true,
      thinPack: false,
      noProgress: false,
      ofsDelta: true,
    });

    const text = buf.toString("utf-8");
    expect(text).toContain(`want ${fakeHash} not found`);
  });

  test("空 wants 且无 want-refs 时抛出错误", () => {
    const { backend } = createTestRepo();
    expect(() =>
      generateFetchResponse(backend, {
        wants: [],
        haves: [],
        wantRefs: [],
        done: true,
        thinPack: false,
        noProgress: false,
        ofsDelta: true,
      }),
    ).toThrow("no wants or want-refs");
  });

  test("want-ref 解析并追加到 wants", () => {
    const { backend } = createTestRepo();
    const buf = generateFetchResponse(backend, {
      wants: [],
      haves: [],
      wantRefs: ["refs/heads/main"],
      done: true,
      thinPack: false,
      noProgress: false,
      ofsDelta: true,
    });

    // 应返回 packfile
    const text = buf.toString("utf-8");
    expect(text).toContain("packfile");
  });
});

// ============================================================================
// generateFetchResponse（增量 fetch — 有 haves）
// ============================================================================

describe("generateFetchResponse — incremental fetch", () => {
  test("有 haves 时返回丢勒集 packfile", () => {
    const { backend, mainCommit, developCommit } = createTestRepo();
    const buf = generateFetchResponse(backend, {
      wants: [developCommit],
      haves: [mainCommit],
      wantRefs: [],
      done: true,
      thinPack: false,
      noProgress: false,
      ofsDelta: true,
    });

    const text = buf.toString("utf-8");
    expect(text).toContain("packfile");
  });

  test("无 done 时返回协商响应（NAK）", () => {
    const { backend, developCommit } = createTestRepo();
    const buf = generateFetchResponse(backend, {
      wants: [developCommit],
      haves: [],
      wantRefs: [],
      done: false,
      thinPack: false,
      noProgress: false,
      ofsDelta: true,
    });

    const text = buf.toString("utf-8");
    expect(text).toContain("acknowledgments");
    expect(text).toContain("NAK");
  });

  test("haves 包含已有对象时返回 ACK + ready，并在同一响应中紧接 packfile", () => {
    const { backend, mainCommit, developCommit } = createTestRepo();
    const buf = generateFetchResponse(backend, {
      wants: [developCommit],
      haves: [mainCommit],
      wantRefs: [],
      done: false,
      thinPack: false,
      noProgress: false,
      ofsDelta: true,
    });

    const text = buf.toString("utf-8");
    expect(text).toContain("acknowledgments");
    expect(text).toContain("ACK");
    expect(text).toContain("ready");
    // 协议要求：服务端发送 ready 后必须在同一响应中跟随 packfile，
    // 否则 git CLI 报 "fatal: expected packfile after 'ready'"。
    expect(text).toContain("packfile");
    // packfile 节必须出现在 ready 之后
    expect(text.indexOf("packfile")).toBeGreaterThan(text.indexOf("ready"));
  });

  test("want-ref + done 时在 packfile 前回送 wanted-refs 节且无前导 delimiter", () => {
    const { backend, mainCommit } = createTestRepo();
    const buf = generateFetchResponse(backend, {
      wants: [],
      haves: [],
      wantRefs: ["refs/heads/main"],
      done: true,
      thinPack: false,
      noProgress: false,
      ofsDelta: true,
    });

    const text = buf.toString("utf-8");
    // 必须回送 wanted-refs 映射（git 通过 want-ref 克隆时必需）
    expect(text).toContain("wanted-refs");
    expect(text).toContain(`${mainCommit} refs/heads/main`);
    expect(text).toContain("packfile");
    // wanted-refs 必须在 packfile 之前
    expect(text.indexOf("wanted-refs")).toBeLessThan(text.indexOf("packfile"));
    // 首节不能以 delimiter (0001) 开头——否则 git 报 "fatal: expected 'packfile'"
    expect(buf.subarray(0, 4).toString("utf-8")).not.toBe("0001");
  });
});

// ============================================================================
// createUploadPackService（集成测试）
// ============================================================================

describe("createUploadPackService", () => {
  test("advertise 返回 v2 能力广告", () => {
    const { backend } = createTestRepo();
    const service = createUploadPackService(backend);

    const buf = service.advertise();
    const text = buf.toString("utf-8");
    expect(text).toContain("version 2");
    expect(text).toContain("ls-refs");
    expect(text).toContain("fetch");
  });

  test("handleRequest ls-refs 返回 refs 列表", () => {
    const { backend, mainCommit } = createTestRepo();
    const service = createUploadPackService(backend);

    const body = Buffer.concat([
      encodePktLine("command=ls-refs\n"),
      encodeDelimiterPkt(),
      encodePktLine("symrefs\n"),
      encodeFlushPkt(),
    ]);

    const buf = service.handleRequest(body);
    const text = buf.toString("utf-8");
    expect(text).toContain(mainCommit);
    expect(text).toContain("refs/heads/main");
  });

  test("handleRequest fetch 返回 packfile", () => {
    const { backend, mainCommit } = createTestRepo();
    const service = createUploadPackService(backend);

    const body = Buffer.concat([
      encodePktLine("command=fetch\n"),
      encodeDelimiterPkt(),
      encodePktLine(`want ${mainCommit}\n`),
      encodePktLine("done\n"),
      encodeFlushPkt(),
    ]);

    const buf = service.handleRequest(body);
    const text = buf.toString("utf-8");
    expect(text).toContain("packfile");
  });

  test("handleRequest 未知命令抛出错误", () => {
    const { backend } = createTestRepo();
    const service = createUploadPackService(backend);

    const body = Buffer.concat([
      encodePktLine("command=unknown\n"),
      encodeDelimiterPkt(),
      encodeFlushPkt(),
    ]);

    expect(() => service.handleRequest(body)).toThrow("unknown command");
  });
});
