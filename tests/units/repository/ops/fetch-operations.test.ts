/**
 * repository/ops/fetch-operations.ts 单元测试
 */

import { describe, test, expect } from "bun:test";

import { createMemoryRepositoryBackend } from "@/backend/memory-backend.ts";
import { writeObject } from "@/objects/raw.ts";
import { createFetchRepositoryOperations } from "@/repository/ops/fetch-operations.ts";
import { encodeFlushPkt, encodePktLine, parsePktLines } from "@/transport/protocol/pkt-line.ts";

describe("createFetchRepositoryOperations()", () => {
  test("Fetch 操作应暴露 fetch 方法", () => {
    const backend = createMemoryRepositoryBackend();
    const ops = createFetchRepositoryOperations(backend);
    expect(typeof ops.fetch).toBe("function");
  });

  test("fetch() 使用无效 URL 应抛出错误", async () => {
    const backend = createMemoryRepositoryBackend();
    const ops = createFetchRepositoryOperations(backend);
    const promise = ops.fetch("https://invalid.url/nonexistent.git");
    expect(promise).rejects.toThrow();
  });

  test("fetch() 在远端未广告 HEAD 时仍会跟随默认分支更新本地 HEAD", async () => {
    const backend = createMemoryRepositoryBackend();
    const treeHash = writeObject(backend.objects, {
      type: "tree",
      entries: [],
    });
    const commitHash = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [],
      author: { name: "Test", email: "test@example.com", timestamp: 0, timezone: "+0000" },
      committer: { name: "Test", email: "test@example.com", timestamp: 0, timezone: "+0000" },
      message: "initial\n",
    });

    const ops = createFetchRepositoryOperations(backend);
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (_input, init) => {
      const body = Buffer.from(await new Response(init?.body).arrayBuffer());
      const requestLines = parsePktLines(body)
        .filter((line) => line.type === "data")
        .map((line) => line.payload.toString("utf-8").trimEnd());

      expect(requestLines[0]).toBe("command=ls-refs");
      expect(requestLines).toContain("symrefs");
      expect(requestLines).toContain("peel");
      expect(requestLines).toContain("ref-prefix HEAD");
      expect(requestLines).toContain("ref-prefix refs/heads/");
      expect(requestLines).toContain("ref-prefix refs/tags/");

      return new Response(
        Buffer.concat([encodePktLine(`${commitHash} refs/heads/master\n`), encodeFlushPkt()]),
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      const result = await ops.fetch("https://example.com/repo.git");

      expect(result.updatedRefs).toContainEqual({
        refName: "refs/heads/master",
        oldHash: null,
        newHash: commitHash,
        success: true,
        forced: false,
      });
      expect(backend.refs.read("HEAD")).toBe("ref: refs/heads/master");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
