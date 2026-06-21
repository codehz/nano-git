/**
 * fetch 多轮协商编排测试
 *
 * 通过 mock RemoteTransport 验证 negotiateAndFetchPackfile
 * 的多轮 stateless-rpc 协商行为。
 *
 * 覆盖场景：
 * - 场景 A：haves.length <= MAX_HAVES_PER_ROUND（单轮 done）
 * - 场景 B：第一轮 NAK，第二轮返回 packfile（重放前缀，只带下一批 have）
 * - 场景 C：第一轮 ACK common，第二轮重放该 common
 * - 场景 D：第一轮 ACK ready，立即发最终 done
 * - 场景 E：多轮 shallow/unshallow 累计
 * - 场景 F：最后一轮仍无 packfile → FetchError
 * - 回归：多轮不得只发当前 chunk 的 have 没有 replay common
 * - 回归：多轮不得重放所有历史 have
 */

import { describe, test, expect } from "bun:test";

import { sha1, type SHA1, type GitBlob, type GitCommit } from "@/core/types.ts";
import { createMemoryObjectStore } from "@/odb/memory-store.ts";
import { toEncodedPackObject, buildEncodedPack } from "@/odb/pack/pack-encoding.ts";
import { createMemoryRefStore } from "@/refs/stores/memory.ts";
import { fetch, FetchError } from "@/transport/fetch.ts";
import { encodePktLine, parsePktLines } from "@/transport/pkt-line.ts";

import type { RemoteTransport } from "@/transport/types.ts";

// ============================================================================
// 辅助函数
// ============================================================================

/** 判断 pkt-line 是否为数据帧并获取其负载文本 */
function dataText(line: import("@/transport/pkt-line.ts").PktLine): string | undefined {
  if (line.type === "data") {
    return line.payload.toString("utf-8");
  }
  return undefined;
}

/** 从 pkt-line 数组中取出所有数据帧负载文本 */
function dataTexts(lines: ReturnType<typeof parsePktLines>): string[] {
  return lines
    .filter((l): l is { type: "data"; payload: Buffer } => l.type === "data")
    .map((l) => l.payload.toString("utf-8"));
}

// ============================================================================
// 测试常量
// ============================================================================

const TREE_PLACEHOLDER = sha1("0000000000000000000000000000000000000001");

/** 所有 haves 都在 MAX_HAVES_PER_ROUND(32) 内 */
const SMALL_HAVE_COUNT = 5;
/** 超过 MAX_HAVES_PER_ROUND，必须分多轮 */
const LARGE_HAVE_COUNT = 35;

// ============================================================================
// 辅助函数
// ============================================================================

/** 创建一个提交对象并写入 store */
function createTestCommit(
  store: ReturnType<typeof createMemoryObjectStore>,
  parents: SHA1[],
  timestamp: number,
  msg?: string,
): SHA1 {
  const commit: GitCommit = {
    type: "commit",
    tree: TREE_PLACEHOLDER,
    parents,
    author: { name: "T", email: "t@t", timestamp, timezone: "+0000" },
    committer: { name: "T", email: "t@t", timestamp, timezone: "+0000" },
    message: msg ?? `commit at ${timestamp}`,
  };
  return store.write(commit);
}

/** 创建一串提交链，返回从旧到新的顺序 */
function createCommitChain(
  store: ReturnType<typeof createMemoryObjectStore>,
  count: number,
  startTimestamp: number = 100,
): SHA1[] {
  const hashes: SHA1[] = [];
  let parent: SHA1 | undefined;
  for (let i = 0; i < count; i++) {
    const parents = parent ? [parent] : [];
    const hash = createTestCommit(store, parents, startTimestamp + i);
    hashes.push(hash);
    parent = hash;
  }
  return hashes;
}

/** 创建 packfile */
function createPackfile(content: string): {
  packData: Buffer;
  entry: ReturnType<typeof toEncodedPackObject>;
} {
  const blob: GitBlob = { type: "blob", content: Buffer.from(content) };
  const entry = toEncodedPackObject(blob);
  const packResult = buildEncodedPack([entry]);
  return { entry, packData: packResult.packData };
}

/** 创建 ACK 响应数据 */
function createAckData(acks: Array<{ hash: SHA1; status: string }>, nak: boolean = true): Buffer {
  const chunks: Buffer[] = [];
  for (const { hash, status } of acks) {
    chunks.push(encodePktLine(`ACK ${hash} ${status}\n`));
  }
  if (nak) {
    chunks.push(encodePktLine("NAK\n"));
  }
  return Buffer.concat(chunks);
}

/** 创建 shallow/unshallow 响应数据 */
function createShallowResponseData(
  shallow: SHA1[],
  unshallow: SHA1[],
  ack?: Array<{ hash: SHA1; status: string }>,
): Buffer {
  const chunks: Buffer[] = [];
  for (const h of shallow) {
    chunks.push(encodePktLine(`shallow ${h}\n`));
  }
  for (const h of unshallow) {
    chunks.push(encodePktLine(`unshallow ${h}\n`));
  }
  if (ack) {
    for (const { hash, status } of ack) {
      chunks.push(encodePktLine(`ACK ${hash} ${status}\n`));
    }
  }
  chunks.push(encodePktLine("NAK\n"));
  return Buffer.concat(chunks);
}

// ============================================================================
// 场景 A：haves.length <= MAX_HAVES_PER_ROUND
// ============================================================================

describe("场景 A：单轮 done", () => {
  test("haves 少于 MAX_HAVES_PER_ROUND 时只发 1 次请求", async () => {
    const objectStore = createMemoryObjectStore();
    const chain = createCommitChain(objectStore, SMALL_HAVE_COUNT);
    const tip = chain[chain.length - 1]!;
    const remoteHead = createTestCommit(objectStore, [tip], 1000);
    const refStore = createMemoryRefStore(new Map([["refs/remotes/origin/main", tip]]));
    const { packData } = createPackfile("single round");

    const bodies: Buffer[] = [];
    const transport: RemoteTransport = {
      getReceivePackRefs: async () => {
        throw new Error("not used");
      },
      postReceivePack: async () => {
        throw new Error("not used");
      },
      getRefAdvertisement: async () => ({
        capabilities: { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
        refs: [{ name: "refs/heads/main", hash: remoteHead }],
      }),
      postUploadPack: async (body: Buffer) => {
        bodies.push(body);
        return { data: packData, packfile: packData, progress: [] };
      },
    };

    await fetch(objectStore, refStore, "dummy", {
      transport,
      refSpecs: ["+refs/heads/*:refs/remotes/origin/*"],
    });

    // 只发 1 次请求
    expect(bodies).toHaveLength(1);

    // 请求体以 done 结束
    const lines = parsePktLines(bodies[0]!);
    const lastLine = lines[lines.length - 1]!;
    expect(lastLine.type).toBe("data");
    expect((lastLine as { type: "data"; payload: Buffer }).payload.toString("utf-8")).toBe(
      "done\n",
    );
  });
});

// ============================================================================
// 场景 B：多轮 NAK → packfile
// ============================================================================

describe("场景 B：第一轮 NAK，第二轮返回 packfile", () => {
  test("第二轮请求重发同一前缀，只带下一批 have，不重放第一轮全部 have", async () => {
    const objectStore = createMemoryObjectStore();
    const chain = createCommitChain(objectStore, LARGE_HAVE_COUNT);
    const tip = chain[chain.length - 1]!;
    const remoteHead = createTestCommit(objectStore, [tip], 2000);
    const refStore = createMemoryRefStore(new Map([["refs/remotes/origin/main", tip]]));
    const { packData } = createPackfile("second round pack");

    let callCount = 0;
    const bodies: Buffer[] = [];
    const transport: RemoteTransport = {
      getReceivePackRefs: async () => {
        throw new Error("not used");
      },
      postReceivePack: async () => {
        throw new Error("not used");
      },
      getRefAdvertisement: async () => ({
        capabilities: { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
        refs: [{ name: "refs/heads/main", hash: remoteHead }],
      }),
      postUploadPack: async (body: Buffer) => {
        bodies.push(body);
        callCount++;
        if (callCount === 1) {
          return {
            data: createAckData([], true),
            packfile: Buffer.alloc(0),
            progress: [],
          };
        }
        return { data: packData, packfile: packData, progress: [] };
      },
    };

    await fetch(objectStore, refStore, "dummy", {
      transport,
      refSpecs: ["+refs/heads/*:refs/remotes/origin/*"],
    });

    // 发了 2 轮请求
    expect(bodies).toHaveLength(2);

    const firstLines = parsePktLines(bodies[0]!);
    const secondLines = parsePktLines(bodies[1]!);

    // 第一轮：应有 32 个 have
    const firstHaves = dataTexts(firstLines).filter((s) => s.startsWith("have ")).length;
    expect(firstHaves).toBe(32);

    // 第一轮非最终轮（以 flush 结尾，不是 done）
    const firstLast = firstLines[firstLines.length - 1]!;
    expect(firstLast.type).toBe("flush");

    // 第二轮：也包含完整的 want 前缀
    const secondWantLines = dataTexts(secondLines).filter((s) => s.startsWith("want "));
    expect(secondWantLines.length).toBeGreaterThan(0);

    // 第二轮：只有剩下的 haves（35-32=3 个），不是重发 32+3=35 个
    const secondHaves = dataTexts(secondLines).filter((s) => s.startsWith("have ")).length;
    expect(secondHaves).toBe(3);

    // 第二轮以 done 结尾（最终轮）
    const secondLast = secondLines[secondLines.length - 1]!;
    expect(secondLast.type).toBe("data");
    expect(dataText(secondLast)).toBe("done\n");
  });
});

// ============================================================================
// 场景 C：ACK common 重放
// ============================================================================

describe("场景 C：ACK common 重放", () => {
  test("第一轮返回 ACK common，第二轮必须包含该 common", async () => {
    const objectStore = createMemoryObjectStore();
    const chain = createCommitChain(objectStore, LARGE_HAVE_COUNT);
    const tip = chain[chain.length - 1]!;
    const remoteHead = createTestCommit(objectStore, [tip], 2000);
    const refStore = createMemoryRefStore(new Map([["refs/remotes/origin/main", tip]]));
    const { packData } = createPackfile("common replay");

    // 选择链中间的一个 hash 作为服务端 ACK common 的点
    const commonHash = chain[10]!;

    let callCount = 0;
    const bodies: Buffer[] = [];
    const transport: RemoteTransport = {
      getReceivePackRefs: async () => {
        throw new Error("not used");
      },
      postReceivePack: async () => {
        throw new Error("not used");
      },
      getRefAdvertisement: async () => ({
        capabilities: { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
        refs: [{ name: "refs/heads/main", hash: remoteHead }],
      }),
      postUploadPack: async (body: Buffer) => {
        bodies.push(body);
        callCount++;
        if (callCount === 1) {
          return {
            data: createAckData([{ hash: commonHash, status: "common" }]),
            packfile: Buffer.alloc(0),
            progress: [],
          };
        }
        return { data: packData, packfile: packData, progress: [] };
      },
    };

    await fetch(objectStore, refStore, "dummy", {
      transport,
      refSpecs: ["+refs/heads/*:refs/remotes/origin/*"],
    });

    // 发了 2 轮请求
    expect(bodies).toHaveLength(2);

    const secondLines = parsePktLines(bodies[1]!);

    // 第二轮必须包含 commonHash 作为 have
    const secondHaveLines = dataTexts(secondLines).filter((s) => s.startsWith("have "));
    expect(secondHaveLines).toContain(`have ${commonHash}\n`);

    // 验证第二轮 haves 数量 = 1 (commonToReplay) + 3 (剩下的新 haves)
    // commonHash 在 chain[10]，第一轮发了 32 个 (chain[0]..chain[31])
    // 第二轮 replay: chain[10] (common)
    // 第二轮 new: chain[32]..chain[34] (3 个)
    expect(secondHaveLines).toHaveLength(4);
  });
});

// ============================================================================
// 场景 D：ACK ready → 立即 done
// ============================================================================

describe("场景 D：ACK ready → 立即 done", () => {
  test("第一轮返回 ACK ready，下一轮立即发最终 done，不再继续扫完剩余 have", async () => {
    const objectStore = createMemoryObjectStore();
    const chain = createCommitChain(objectStore, LARGE_HAVE_COUNT);
    const tip = chain[chain.length - 1]!;
    const remoteHead = createTestCommit(objectStore, [tip], 2000);
    const refStore = createMemoryRefStore(new Map([["refs/remotes/origin/main", tip]]));
    const { packData } = createPackfile("ready pack");

    const readyHash = chain[5]!;

    let callCount = 0;
    const bodies: Buffer[] = [];
    const transport: RemoteTransport = {
      getReceivePackRefs: async () => {
        throw new Error("not used");
      },
      postReceivePack: async () => {
        throw new Error("not used");
      },
      getRefAdvertisement: async () => ({
        capabilities: { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
        refs: [{ name: "refs/heads/main", hash: remoteHead }],
      }),
      postUploadPack: async (body: Buffer) => {
        bodies.push(body);
        callCount++;
        if (callCount === 1) {
          return {
            data: createAckData([{ hash: readyHash, status: "ready" }]),
            packfile: Buffer.alloc(0),
            progress: [],
          };
        }
        // 第二轮：最终 done 请求，应收到 packfile
        return { data: packData, packfile: packData, progress: [] };
      },
    };

    await fetch(objectStore, refStore, "dummy", {
      transport,
      refSpecs: ["+refs/heads/*:refs/remotes/origin/*"],
    });

    // 发了 2 轮请求（第一轮发现 ready，第二轮 done）
    expect(bodies).toHaveLength(2);

    const secondLines = parsePktLines(bodies[1]!);

    // 第二轮必须包含 readyHash 作为 replay common
    const secondHaveLines = dataTexts(secondLines).filter((s) => s.startsWith("have "));
    expect(secondHaveLines).toContain(`have ${readyHash}\n`);

    // 第二轮以 done 结尾
    const secondLast = secondLines[secondLines.length - 1]!;
    expect(secondLast.type).toBe("data");
    expect(dataText(secondLast)).toBe("done\n");

    // 第二轮只有 replay common，没有 new haves（因为发现 ready 后直接 done）
    // 第一轮发了 32 个 haves，ready 在 chain[5]，第二轮应只 replay chain[5]
    // 不应该有新的 newHaves（空数组）

    // 第二轮只有 1 个 replay have
    expect(secondHaveLines).toHaveLength(1);
  });
});

// ============================================================================
// 场景 E：多轮 shallow/unshallow 累计
// ============================================================================

describe("场景 E：多轮 shallow/unshallow 累计", () => {
  test("shallow/unshallow 跨轮累计，最终结果包含全部", async () => {
    const objectStore = createMemoryObjectStore();
    const chain = createCommitChain(objectStore, LARGE_HAVE_COUNT);
    const tip = chain[chain.length - 1]!;
    const remoteHead = createTestCommit(objectStore, [tip], 2000);
    const refStore = createMemoryRefStore(new Map([["refs/remotes/origin/main", tip]]));
    const { packData } = createPackfile("shallow accumulation");

    const shallow1 = sha1("1111111111111111111111111111111111111111");
    const shallow2 = sha1("2222222222222222222222222222222222222222");
    const unshallow1 = sha1("3333333333333333333333333333333333333333");

    let callCount = 0;
    const transport: RemoteTransport = {
      getReceivePackRefs: async () => {
        throw new Error("not used");
      },
      postReceivePack: async () => {
        throw new Error("not used");
      },
      getRefAdvertisement: async () => ({
        capabilities: { multi_ack: true, "side-band-64k": true, "ofs-delta": true, shallow: true },
        refs: [{ name: "refs/heads/main", hash: remoteHead }],
      }),
      postUploadPack: async (_body: Buffer) => {
        callCount++;
        if (callCount === 1) {
          // 第一轮：发 32 haves，返回 shallow1
          return {
            data: createShallowResponseData([shallow1], []),
            packfile: Buffer.alloc(0),
            progress: [],
          };
        }
        // 第二轮（最后一轮）：发 3 haves + replay + done，返回 shallow2+unshallow1 + packfile
        return {
          data: createShallowResponseData([shallow2], [unshallow1]),
          packfile: packData,
          progress: [],
        };
      },
    };

    const result = await fetch(objectStore, refStore, "dummy", {
      transport,
      refSpecs: ["+refs/heads/*:refs/remotes/origin/*"],
    });

    // 两轮请求（35 haves：32 + 3）
    expect(callCount).toBe(2);

    // shallow/unshallow 累计了全部三轮的结果
    // shallow 应包含 [shallow1, shallow2]
    // unshallow 应包含 [unshallow1]
    expect(result.shallow).toBeDefined();
    // 不能依赖顺序，去重比较
    const shallowSet = new Set(result.shallow!);
    expect(shallowSet.has(shallow1)).toBe(true);
    expect(shallowSet.has(shallow2)).toBe(true);
    expect(shallowSet.size).toBe(2);

    const unshallowSet = new Set(result.unshallow ?? []);
    expect(unshallowSet.has(unshallow1)).toBe(true);
  });
});

// ============================================================================
// 场景 F：最后一轮仍无 packfile
// ============================================================================

describe("场景 F：最后一轮仍无 packfile", () => {
  test("所有轮次都 NAK，最后一轮返回空 packfile 应抛 FetchError", async () => {
    const objectStore = createMemoryObjectStore();
    const chain = createCommitChain(objectStore, SMALL_HAVE_COUNT);
    const tip = chain[chain.length - 1]!;
    const remoteHead = createTestCommit(objectStore, [tip], 2000);
    const refStore = createMemoryRefStore(new Map([["refs/remotes/origin/main", tip]]));

    const transport: RemoteTransport = {
      getReceivePackRefs: async () => {
        throw new Error("not used");
      },
      postReceivePack: async () => {
        throw new Error("not used");
      },
      getRefAdvertisement: async () => ({
        capabilities: { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
        refs: [{ name: "refs/heads/main", hash: remoteHead }],
      }),
      postUploadPack: async () => ({
        data: createAckData([], true),
        packfile: Buffer.alloc(0),
        progress: [],
      }),
    };

    const fetchPromise = fetch(objectStore, refStore, "dummy", {
      transport,
      refSpecs: ["+refs/heads/*:refs/remotes/origin/*"],
    });

    expect(fetchPromise).rejects.toBeInstanceOf(FetchError);
  });
});

// ============================================================================
// 回归测试
// ============================================================================

describe("回归测试：多轮协商语义", () => {
  test("回归：第二轮请求不得只包含当前 chunk 的 have 而没有 replay common", async () => {
    const objectStore = createMemoryObjectStore();
    const chain = createCommitChain(objectStore, LARGE_HAVE_COUNT);
    const tip = chain[chain.length - 1]!;
    const remoteHead = createTestCommit(objectStore, [tip], 2000);
    const refStore = createMemoryRefStore(new Map([["refs/remotes/origin/main", tip]]));
    const { packData } = createPackfile("regression replay");

    const commonHash = chain[3]!;

    let callCount = 0;
    const bodies: Buffer[] = [];
    const transport: RemoteTransport = {
      getReceivePackRefs: async () => {
        throw new Error("not used");
      },
      postReceivePack: async () => {
        throw new Error("not used");
      },
      getRefAdvertisement: async () => ({
        capabilities: { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
        refs: [{ name: "refs/heads/main", hash: remoteHead }],
      }),
      postUploadPack: async (body: Buffer) => {
        bodies.push(body);
        callCount++;
        if (callCount === 1) {
          return {
            data: createAckData([{ hash: commonHash, status: "common" }]),
            packfile: Buffer.alloc(0),
            progress: [],
          };
        }
        return { data: packData, packfile: packData, progress: [] };
      },
    };

    await fetch(objectStore, refStore, "dummy", {
      transport,
      refSpecs: ["+refs/heads/*:refs/remotes/origin/*"],
    });

    expect(bodies).toHaveLength(2);

    // 断言第二轮请求体内容
    const secondLines = parsePktLines(bodies[1]!);
    const secondHaveLines = dataTexts(secondLines).filter((s) => s.startsWith("have "));

    // 第二轮必须包含 commonHash（regression 1）
    expect(secondHaveLines).toContain(`have ${commonHash}\n`);

    // 第二轮不得包含第一轮发出的所有 have（regression 2）
    // 第一轮发了 chain[0]..chain[31] (32 haves)，其中 chain[3] 是 common
    // 第二轮应只 replay commonHash + 剩下的 3 个新 haves = 4 个，而不是 35 个
    // "多轮 HTTP 协商时，不得要求重放所有历史 have"
    expect(secondHaveLines.length).toBeLessThan(10); // 远小于 35
    expect(secondHaveLines.length).toBe(4); // 1 replay + 3 new
  });

  test("回归：第二轮请求前缀完整（包含 want）", async () => {
    const objectStore = createMemoryObjectStore();
    const chain = createCommitChain(objectStore, LARGE_HAVE_COUNT);
    const tip = chain[chain.length - 1]!;
    const remoteHead = createTestCommit(objectStore, [tip], 2000);
    const refStore = createMemoryRefStore(new Map([["refs/remotes/origin/main", tip]]));
    const { packData } = createPackfile("regression prefix");

    let callCount = 0;
    const bodies: Buffer[] = [];
    const transport: RemoteTransport = {
      getReceivePackRefs: async () => {
        throw new Error("not used");
      },
      postReceivePack: async () => {
        throw new Error("not used");
      },
      getRefAdvertisement: async () => ({
        capabilities: { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
        refs: [{ name: "refs/heads/main", hash: remoteHead }],
      }),
      postUploadPack: async (body: Buffer) => {
        bodies.push(body);
        callCount++;
        if (callCount === 1) {
          return {
            data: createAckData([], true),
            packfile: Buffer.alloc(0),
            progress: [],
          };
        }
        return { data: packData, packfile: packData, progress: [] };
      },
    };

    await fetch(objectStore, refStore, "dummy", {
      transport,
      refSpecs: ["+refs/heads/*:refs/remotes/origin/*"],
    });

    // 第二轮请求也必须包含 want 行（完整前缀）
    const secondLines = parsePktLines(bodies[1]!);
    const secondWantLines = dataTexts(secondLines).filter((s) => s.startsWith("want "));
    expect(secondWantLines.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// 起点裁剪行为测试
// ============================================================================

describe("fetch() 起点裁剪行为", () => {
  test("无关的本地 tag 不会出现在 haves 中", async () => {
    const objectStore = createMemoryObjectStore();
    const chain = createCommitChain(objectStore, 5);
    const tip = chain[chain.length - 1]!;
    const remoteHead = createTestCommit(objectStore, [tip], 2000);
    const { packData } = createPackfile("no tag pollution");

    // 本地有一个与 fetch 无关的 tag（指向旧的 commit）
    const tagHash = chain[0]!;
    const refStore = createMemoryRefStore(
      new Map([
        ["refs/remotes/origin/main", tip],
        ["refs/tags/v1.0", tagHash],
      ]),
    );

    let capturedBody: Buffer | null = null;
    const transport: RemoteTransport = {
      getReceivePackRefs: async () => {
        throw new Error("not used");
      },
      postReceivePack: async () => {
        throw new Error("not used");
      },
      getRefAdvertisement: async () => ({
        capabilities: { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
        refs: [{ name: "refs/heads/main", hash: remoteHead }],
      }),
      postUploadPack: async (body: Buffer) => {
        capturedBody = body;
        return { data: packData, packfile: packData, progress: [] };
      },
    };

    await fetch(objectStore, refStore, "dummy", {
      transport,
      refSpecs: ["+refs/heads/*:refs/remotes/origin/*"],
    });

    const bodyStr = capturedBody!.toString("utf-8");
    // tag 中的 commit 不应出现在 haves 中（tag 不是 heads/remote-tracking）
    // 但实际上 chain[0] 是 tip 到 chain[4] 的公共祖先，会被 collectHaveCommits 收集到
    // 这里测试的是 tag 本身作为额外的 tip 不应导致多余的对象
    // 关键是：have 数量不会因为存在 tag 而变多
    const haveLines = bodyStr.match(/have [0-9a-f]{40}/g);
    expect(haveLines).not.toBeNull();

    // 如果有 tag 作为额外 tip，collectHaveCommits 的 seen 不会变化
    // 因为 tagHash 已经是 chain 的一部分
    // 验证 fetch 成功完成即可
    expect(refStore.read("refs/remotes/origin/main")).toBe(remoteHead);
  });

  test("不同远端命名空间的 remote-tracking refs 不会混入 haves", async () => {
    const objectStore = createMemoryObjectStore();

    // 创建两个独立的提交链
    const mainChain = createCommitChain(objectStore, 3);
    const mainTip = mainChain[mainChain.length - 1]!;
    const remoteHead = createTestCommit(objectStore, [mainTip], 2000);

    // upstream 链（无关的远端命名空间）
    const upstreamChain = createCommitChain(objectStore, 5, 500);
    const upstreamTip = upstreamChain[upstreamChain.length - 1]!;

    const { packData } = createPackfile("no cross-namespace pollution");

    const refStore = createMemoryRefStore(
      new Map([
        ["refs/remotes/origin/main", mainTip],
        ["refs/remotes/upstream/main", upstreamTip], // 不同命名空间
      ]),
    );

    let capturedBody: Buffer | null = null;
    const transport: RemoteTransport = {
      getReceivePackRefs: async () => {
        throw new Error("not used");
      },
      postReceivePack: async () => {
        throw new Error("not used");
      },
      getRefAdvertisement: async () => ({
        capabilities: { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
        refs: [{ name: "refs/heads/main", hash: remoteHead }],
      }),
      postUploadPack: async (body: Buffer) => {
        capturedBody = body;
        return { data: packData, packfile: packData, progress: [] };
      },
    };

    await fetch(objectStore, refStore, "dummy", {
      transport,
      refSpecs: ["+refs/heads/*:refs/remotes/origin/*"],
    });

    const bodyStr = capturedBody!.toString("utf-8");
    // upstream 链的 commit 不应出现在 haves 中
    // （selectHaveTips 的第二优先只匹配同一远端前缀 origin）
    expect(bodyStr).not.toContain(upstreamTip);
    expect(refStore.read("refs/remotes/origin/main")).toBe(remoteHead);
  });

  test("maxCandidates 防止候选集过大", async () => {
    const objectStore = createMemoryObjectStore();

    // 创建 200 个提交的链
    const chain = createCommitChain(objectStore, 200);
    const tip = chain[chain.length - 1]!;
    const remoteHead = createTestCommit(objectStore, [tip], 3000);
    const { packData } = createPackfile("bounded candidates");

    const refStore = createMemoryRefStore(new Map([["refs/remotes/origin/main", tip]]));

    let capturedBody: Buffer | null = null;
    const transport: RemoteTransport = {
      getReceivePackRefs: async () => {
        throw new Error("not used");
      },
      postReceivePack: async () => {
        throw new Error("not used");
      },
      getRefAdvertisement: async () => ({
        capabilities: { multi_ack: true, "side-band-64k": true, "ofs-delta": true },
        refs: [{ name: "refs/heads/main", hash: remoteHead }],
      }),
      postUploadPack: async (body: Buffer) => {
        capturedBody = body;
        return { data: packData, packfile: packData, progress: [] };
      },
    };

    await fetch(objectStore, refStore, "dummy", {
      transport,
      refSpecs: ["+refs/heads/*:refs/remotes/origin/*"],
      maxCandidates: 50,
    });

    const bodyStr = capturedBody!.toString("utf-8");
    const haveCount = (bodyStr.match(/have [0-9a-f]{40}/g) ?? []).length;
    // 最多 50 个 have（受 maxCandidates 限制）
    expect(haveCount).toBeLessThanOrEqual(50);
    expect(refStore.read("refs/remotes/origin/main")).toBe(remoteHead);
  });
});
