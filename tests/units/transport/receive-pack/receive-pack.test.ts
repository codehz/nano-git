/**
 * v1 receive-pack 服务端单元测试
 *
 * 测试 advertiseReceivePack、parseReceivePackRequest、handleReceivePackRequest。
 */

import { describe, test, expect } from "bun:test";

import { createMemoryRepositoryBackend } from "@/backend/memory.ts";
import { writeObject } from "@/objects/raw.ts";
import { encodePktLine, encodeFlushPkt } from "@/transport/protocol/pkt-line.ts";
import {
  advertiseReceivePack,
  parseReceivePackRequest,
  handleReceivePackRequest,
  createReceivePackService,
  ReceivePackServiceError,
} from "@/transport/server/receive-pack/index.ts";
import { sha1, type SHA1 } from "@/types/index.ts";

// ============================================================================
// 测试辅助
// ============================================================================

function createTestBackend(params?: { withCommitHash?: string; extraRefs?: Map<string, string> }) {
  const backend = createMemoryRepositoryBackend({
    initialRefs: new Map<string, string>([
      ["HEAD", "ref: refs/heads/main"],
      ...(params?.extraRefs ?? []),
    ]),
  });

  const blobHash = writeObject(backend.objects, {
    type: "blob" as const,
    content: Buffer.from("hello"),
  });
  const treeHash = writeObject(backend.objects, {
    type: "tree" as const,
    entries: [{ mode: "100644", name: "f.txt", hash: blobHash }],
  });
  const commitHash = writeObject(backend.objects, {
    type: "commit" as const,
    tree: treeHash,
    parents: [],
    author: { name: "T", email: "t@t", timestamp: 0, timezone: "+0000" },
    committer: { name: "T", email: "t@t", timestamp: 0, timezone: "+0000" },
    message: "init\n",
  });
  backend.refs.write("refs/heads/main", commitHash);

  return {
    backend,
    blobHash,
    treeHash,
    commitHash: (params?.withCommitHash as SHA1) ?? commitHash,
  };
}

const ZERO_HASH = sha1("0000000000000000000000000000000000000000");

// ============================================================================
// advertiseReceivePack
// ============================================================================

describe("advertiseReceivePack", () => {
  test("返回 ref 广告，首行含 # service=git-receive-pack", () => {
    const { backend } = createTestBackend();
    const buf = advertiseReceivePack(backend);
    const text = buf.toString("utf-8");

    expect(text).toContain("# service=git-receive-pack");
  });

  test("首行 ref 带 capabilities（NUL 分隔）", () => {
    const { backend } = createTestBackend();
    const buf = advertiseReceivePack(backend);
    const text = buf.toString("utf-8");

    // 第一行 ref 后应有 NUL + capabilities
    expect(text).toContain("\0report-status");
    expect(text).toContain("delete-refs");
    expect(text).toContain("side-band-64k");
    expect(text).toContain("ofs-delta");
    expect(text).toContain("agent=");
  });

  test("包含 refs/heads/main 和 HEAD", () => {
    const { backend, commitHash } = createTestBackend();
    const buf = advertiseReceivePack(backend);
    const text = buf.toString("utf-8");

    expect(text).toContain(commitHash);
    expect(text).toContain("refs/heads/main");
  });

  test("空仓库发出 capabilities 占位行", () => {
    const backend = createMemoryRepositoryBackend({
      initialRefs: new Map([["HEAD", "ref: refs/heads/main"]]),
    });
    const buf = advertiseReceivePack(backend);
    const text = buf.toString("utf-8");

    // 空仓库时应有 capabilities^{} 占位行
    expect(text).toContain("capabilities^{}");
    expect(text).toContain("report-status");
  });

  test("annotated tag 有 peeled 行", () => {
    const backend = createMemoryRepositoryBackend({
      initialRefs: new Map([["HEAD", "ref: refs/heads/main"]]),
    });

    const blobHash = writeObject(backend.objects, {
      type: "blob" as const,
      content: Buffer.from("hello"),
    });
    const treeHash = writeObject(backend.objects, {
      type: "tree" as const,
      entries: [{ mode: "100644", name: "f.txt", hash: blobHash }],
    });
    const commitHash = writeObject(backend.objects, {
      type: "commit" as const,
      tree: treeHash,
      parents: [],
      author: { name: "T", email: "t@t", timestamp: 0, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 0, timezone: "+0000" },
      message: "init\n",
    });
    const tagHash = writeObject(backend.objects, {
      type: "tag" as const,
      object: commitHash,
      objectType: "commit" as const,
      tag: "v1.0",
      tagger: { name: "T", email: "t@t", timestamp: 0, timezone: "+0000" },
      message: "v1.0\n",
    });
    backend.refs.write("refs/heads/main", commitHash);
    backend.refs.write("refs/tags/v1.0", tagHash);

    const buf = advertiseReceivePack(backend);
    const text = buf.toString("utf-8");
    expect(text).toContain(`${tagHash} refs/tags/v1.0`);
    expect(text).toContain(`${commitHash} refs/tags/v1.0^{}`);
  });
});

// ============================================================================
// parseReceivePackRequest
// ============================================================================

describe("parseReceivePackRequest", () => {
  test("解析单条命令（新建 ref）", () => {
    const body = Buffer.concat([
      encodePktLine(
        `${ZERO_HASH} aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/heads/new\0report-status\n`,
      ),
      encodeFlushPkt(),
    ]);

    const parsed = parseReceivePackRequest(body);
    expect(parsed.commands).toHaveLength(1);
    expect(parsed.commands[0]!.refName).toBe("refs/heads/new");
    expect(parsed.commands[0]!.oldHash).toBe(ZERO_HASH);
    expect(parsed.capabilities).toContain("report-status");
  });

  test("解析多条命令", () => {
    const body = Buffer.concat([
      encodePktLine(
        `${ZERO_HASH} aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/heads/a\0report-status\n`,
      ),
      encodePktLine(`${ZERO_HASH} bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb refs/heads/b\n`),
      encodeFlushPkt(),
    ]);

    const parsed = parseReceivePackRequest(body);
    expect(parsed.commands).toHaveLength(2);
    expect(parsed.commands[0]!.refName).toBe("refs/heads/a");
    expect(parsed.commands[1]!.refName).toBe("refs/heads/b");
  });

  test("解析带 packfile 的请求", () => {
    const packfileData = Buffer.from("PACK...."); // 不是合法 packfile，但解析器不校验
    const body = Buffer.concat([
      encodePktLine(
        `${ZERO_HASH} aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/heads/a\0report-status\n`,
      ),
      encodeFlushPkt(),
      packfileData,
    ]);

    const parsed = parseReceivePackRequest(body);
    expect(parsed.packfile).toEqual(packfileData);
  });

  test("空 body 抛出错误", () => {
    expect(() => parseReceivePackRequest(Buffer.alloc(0))).toThrow(ReceivePackServiceError);
  });

  test("无效命令格式抛出错误", () => {
    const body = Buffer.concat([encodePktLine("invalid command\n"), encodeFlushPkt()]);
    expect(() => parseReceivePackRequest(body)).toThrow(ReceivePackServiceError);
  });
});

// ============================================================================
// handleReceivePackRequest （集成测试）
// ============================================================================

describe("handleReceivePackRequest", () => {
  test("新建分支成功", () => {
    const { backend, commitHash } = createTestBackend();

    // 模拟 push: 新建 refs/heads/new -> commitHash
    const body = Buffer.concat([
      encodePktLine(`${ZERO_HASH} ${commitHash} refs/heads/new\0report-status side-band-64k\n`),
      encodeFlushPkt(),
    ]);

    const response = handleReceivePackRequest(backend, body);
    const text = response.toString("utf-8");

    expect(text).toContain("unpack ok");
    expect(text).toContain("ok refs/heads/new");
  });

  test("快速推进分支成功", () => {
    const { backend, commitHash } = createTestBackend();

    const body = Buffer.concat([
      encodePktLine(`${commitHash} ${commitHash} refs/heads/main\0report-status\n`),
      encodeFlushPkt(),
    ]);

    const response = handleReceivePackRequest(backend, body);
    const text = response.toString("utf-8");

    expect(text).toContain("unpack ok");
    expect(text).toContain("ok refs/heads/main");
  });

  test("旧哈希不匹配时拒绝", () => {
    const { backend, commitHash } = createTestBackend();

    const fakeOld = "0000000000000000000000000000000000000001" as SHA1;
    const body = Buffer.concat([
      encodePktLine(`${fakeOld} ${commitHash} refs/heads/main\0report-status\n`),
      encodeFlushPkt(),
    ]);

    const response = handleReceivePackRequest(backend, body);
    const text = response.toString("utf-8");

    expect(text).toContain("unpack ok");
    expect(text).toContain("ng refs/heads/main");
  });

  test("覆盖标签被拒绝", () => {
    const { backend, commitHash } = createTestBackend();

    // 先创建标签
    backend.refs.write("refs/tags/v1", commitHash);

    const body = Buffer.concat([
      encodePktLine(`${commitHash} ${commitHash} refs/tags/v1\0report-status\n`),
      encodeFlushPkt(),
    ]);

    const response = handleReceivePackRequest(backend, body);
    const text = response.toString("utf-8");

    expect(text).toContain("unpack ok");
    expect(text).toContain("ng refs/tags/v1");
  });

  test("删除 ref 成功（带 delete-refs 能力）", () => {
    const { backend, commitHash } = createTestBackend();

    const body = Buffer.concat([
      encodePktLine(`${commitHash} ${ZERO_HASH} refs/heads/main\0report-status delete-refs\n`),
      encodeFlushPkt(),
    ]);

    const response = handleReceivePackRequest(backend, body);
    const text = response.toString("utf-8");

    expect(text).toContain("unpack ok");
    expect(text).toContain("ok refs/heads/main");
  });

  test("删除 ref 不带 delete-refs 能力成功（允许删除是默认行为）", () => {
    const { backend, commitHash } = createTestBackend();

    const body = Buffer.concat([
      encodePktLine(`${commitHash} ${ZERO_HASH} refs/heads/main\0report-status\n`),
      encodeFlushPkt(),
    ]);

    const response = handleReceivePackRequest(backend, body);
    const text = response.toString("utf-8");

    expect(text).toContain("unpack ok");
    expect(text).toContain("ok refs/heads/main");
  });
});

// ============================================================================
// createReceivePackService
// ============================================================================

describe("createReceivePackService", () => {
  test("advertise 返回 receive-pack ref 广告", () => {
    const { backend } = createTestBackend();
    const service = createReceivePackService(backend);

    const buf = service.advertise();
    const text = buf.toString("utf-8");

    expect(text).toContain("# service=git-receive-pack");
    expect(text).toContain("report-status");
  });

  test("handleRequest 返回 report-status 响应", () => {
    const { backend, commitHash } = createTestBackend();
    const service = createReceivePackService(backend);

    const body = Buffer.concat([
      encodePktLine(`${ZERO_HASH} ${commitHash} refs/heads/new\0report-status\n`),
      encodeFlushPkt(),
    ]);

    const response = service.handleRequest(body);
    const text = response.toString("utf-8");

    expect(text).toContain("unpack ok");
    expect(text).toContain("ok refs/heads/new");
  });
});
