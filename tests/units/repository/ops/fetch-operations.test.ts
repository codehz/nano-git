/**
 * repository/ops/fetch-operations.ts 单元测试
 */

import { describe, test, expect } from "bun:test";

import { bytesToUtf8, concatBytes, toUint8Array } from "../../../helpers/bytes.ts";
import { createMemoryRepositoryBackend } from "@/backend/memory.ts";
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

  test("fetch() 在远端未广告 HEAD 时不应更新本地 HEAD", async () => {
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

    globalThis.fetch = (async (input, init) => {
      const hasBody = init?.body !== undefined && init?.body !== null;
      if (!hasBody) {
        return new Response(encodeV2CapabilityAdvertisement(), {
          status: 200,
          headers: {
            "Content-Type": "application/x-git-upload-pack-advertisement",
          },
        });
      }

      const body = toUint8Array(await new Response(init?.body).arrayBuffer());
      const requestLines = parsePktLines(body)
        .filter((line) => line.type === "data")
        .map((line) => bytesToUtf8(line.payload).trimEnd());

      const command = requestLines[0];
      if (command === "command=ls-refs") {
        expect(requestLines).toContain("symrefs");
        expect(requestLines).toContain("peel");
        expect(requestLines).toContain("ref-prefix HEAD");
        expect(requestLines).toContain("ref-prefix refs/heads/");
        expect(requestLines).toContain("ref-prefix refs/tags/");

        return new Response(
          concatBytes(encodePktLine(`${commitHash} refs/heads/master\n`), encodeFlushPkt()),
          {
            status: 200,
            headers: { "Content-Type": "application/x-git-upload-pack-result" },
          },
        );
      }

      if (command === "command=fetch") {
        return new Response(encodeFetchNegotiationDone(), {
          status: 200,
          headers: { "Content-Type": "application/x-git-upload-pack-result" },
        });
      }

      const requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : "unknown";
      throw new Error(`unexpected v2 command in mock fetch: ${String(command)} (${requestUrl})`);
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
      // 内存仓库初始 HEAD 指向 main；无远端 HEAD symref 时不应被改成 master
      expect(backend.refs.read("HEAD")).toBe("ref: refs/heads/main");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function encodeV2CapabilityAdvertisement(): Uint8Array {
  return concatBytes(
    encodePktLine("version 2\n"),
    encodePktLine("ls-refs\n"),
    encodePktLine("fetch=shallow sideband-all\n"),
    encodeFlushPkt(),
  );
}

function encodeFetchNegotiationDone(): Uint8Array {
  return concatBytes(encodePktLine("acknowledgments\n"), encodePktLine("NAK\n"), encodeFlushPkt());
}
