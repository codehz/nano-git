# Plan 003: fetch-pack.ts 核心传输协商逻辑补充单元测试

> **Executor instructions**: 按步骤依次执行，每步完成后运行验证命令并确认预期结果。
> 如遇到 STOP conditions 中的情况，停止并报告。
>
> **Drift check**: `git diff --stat 0b84c60..HEAD -- src/transport/fetch-pack.ts tests/units/transport/`
> 如有文件已变化，先对比 "Current state" 摘录与当前代码；不一致则 STOP。

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `0b84c60`, 2026-06-22

## Why this matters

`fetch-pack.ts` 包含 `fetchPack()` 主入口和内部 `negotiateAndFetchPackfile()` 多轮 stateless-rpc 协商逻辑。协商循环处理：

- have chunking（每批 ≤ MAX_HAVES_PER_ROUND）
- common 重放（已确认的 have 重发）
- done 信令（何时发 done 标记）
- ready/nak 响应处理
- shallow/unshallow 合并

目前没有任何直接单元测试覆盖这个核心传输循环。仅在集成测试（如 import-session.test.ts）中通过 mock transport 间接测试，覆盖率严重不足。这是项目中最可能包含复杂 bug 的模块之一。

## Current state

- `src/transport/fetch-pack.ts` — fetch 核心编排模块
- `src/transport/negotiate.ts` — 请求构建和 have 收集工具（已有测试）
- `src/transport/upload-pack-response.ts` — 响应解码工具
- `tests/units/transport/negotiate.test.ts` — 仅测试 `collectHaveCommits` 和 `buildUploadPackRequestPrefix`/`buildUploadPackNegotiationRequest`，不涉及多轮协商
- `tests/units/transport/negotiate-request.test.ts` — 测试请求 body 构建

`negotiateAndFetchPackfile()` 函数（fetch-pack.ts 中约 L95-150）的完整循环逻辑：

1. 构造请求前缀（wants + capabilities + deepen + shallow）
2. 如果 haves 为空 → 发送 done 立即结束
3. 否则循环发送 have chunks，每轮检查 packfile、ready 状态、以及是否已发完最后一轮
4. 每轮调用 `sendRound()` → `buildUploadPackNegotiationRequest()` + `client.request()` + `decodeUploadPackResponse()` + `parseUploadPackNegotiationResponse()` + `mergeShallowInfo()` + `absorbAckCommon()`

已有测试模式（示例来自 `tests/units/transport/push-protocol.test.ts`）：

```ts
import { createMemoryObjectStore } from "@/odb/memory-store.ts";
import { createMemoryRefStore } from "@/refs/stores/memory.ts";

function mockTransport(caps, refs, onRequest): ReceivePackTransport {
  return {
    advertise: async () => ({ capabilities: caps, refs }),
    request: async () => onRequest(),
  };
}
```

## Commands you will need

| Purpose        | Command                                             | Expected on success |
| -------------- | --------------------------------------------------- | ------------------- |
| Install        | `bun install`                                       | exit 0              |
| Run tests      | `bun test tests/units/transport/fetch-pack.test.ts` | all pass            |
| All unit tests | `bun test tests/units/`                             | all pass            |
| Lint           | `bun run lint`                                      | exit 0              |

## Scope

**In scope**:

- `tests/units/transport/fetch-pack.test.ts` — 创建新的测试文件

**Out of scope**:

- 不修改任何源文件（只加测试）
- 不修改已有测试文件

## Steps

### Step 1: 创建测试文件框架

创建 `tests/units/transport/fetch-pack.test.ts`，参考 `push-protocol.test.ts` 的测试模式。

项目约定：

- 导入使用 `@/` 路径别名（`@/transport/fetch-pack.ts` 等）
- 测试使用 `bun:test` 的 `describe` / `test` / `expect`
- 异步异常断言使用 `expect(promise).rejects.toBeInstanceOf(ErrorType)`
- 注释使用中文

框架结构：

```ts
/**
 * fetch-pack 核心单元测试
 *
 * 覆盖 fetchPack() 和内部 negotiateAndFetchPackfile() 的协商循环：
 * - 初始 clone（无 haves → 直接 done）
 * - 多轮增量协商（have chunking + ack 处理）
 * - shallow fetch
 * - 能力校验（server 不支持 shallow 时拒绝 depth）
 * - 响应完整性校验（packfile 解析）
 * - 空 wants 的错误处理
 */

import { describe, test, expect } from "bun:test";

import { sha1, type SHA1, type GitCommit } from "@/core/types.ts";
import { createMemoryObjectStore } from "@/odb/memory-store.ts";
import { fetchPack, FetchPackError } from "@/transport/fetch-pack.ts";
import { encodePktLine, encodeFlushPkt } from "@/transport/pkt-line.ts";
import { parseRefAdvertisement } from "@/transport/ref-advertisement.ts";
import { createPackWriter } from "@/odb/pack/pack-writer.ts";

import type { UploadPackTransport, RefAdvertisement, RemoteRef } from "@/transport/types.ts";
```

### Step 2: 实现辅助函数

实现 mock transport 和测试数据构建辅助函数。

```ts
/** 创建 mock upload-pack transport */
function createMockTransport(
  onRequest: (body: Buffer) => Buffer | Promise<Buffer>,
): UploadPackTransport {
  return {
    advertise: async (): Promise<RefAdvertisement> => ({
      capabilities: { multi_ack: true, "side-band-64k": true, "ofs-delta": true, shallow: true },
      refs: [],
    }),
    request: async (body: Buffer): Promise<Buffer> => onRequest(body),
  };
}

/** 创建测试 commit 并写入 store */
function createTestCommit(
  store: ReturnType<typeof createMemoryObjectStore>,
  tree: SHA1,
  parents: SHA1[],
  timestamp: number,
): SHA1 {
  const commit: GitCommit = {
    type: "commit",
    tree,
    parents,
    author: { name: "T", email: "t@t", timestamp, timezone: "+0000" },
    committer: { name: "T", email: "t@t", timestamp, timezone: "+0000" },
    message: `commit at ${timestamp}`,
  };
  return store.write(commit);
}

/** 构建一个简单 packfile 并返回其 Buffer */
function buildSimplePack(objects: Array<{ type: string; content: Buffer }>): Buffer {
  const writer = createPackWriter();
  for (const obj of objects) {
    writer.add(obj);
  }
  return writer.build();
}
```

### Step 3: 测试用例 1 — 初始 clone（无 haves）

```ts
describe("fetchPack()", () => {
  test("初始 clone：无 haves 时发送 wants + done 并接收 packfile", async () => {
    const store = createMemoryObjectStore();
    const emptyTree = store.write({ type: "tree", entries: [] });
    const commitHash = createTestCommit(store, emptyTree, [], 1000);

    // 构造服务端返回的 ack + packfile
    const transport = createMockTransport(async (body) => {
      // 验证请求包含 want 和 done
      const text = body.toString("utf-8");
      expect(text).toContain("want ");
      expect(text).toContain("done\n");
      // 返回 nak + packfile
      const packData = buildSimplePack([store.read(commitHash)]);
      const response = encodePktLine("NAK\n") + packData;
      return Buffer.from(response);
    });

    const adv = await transport.advertise();
    const result = await fetchPack(store, transport, adv, {
      wants: [commitHash],
    });

    expect(result.objectCount).toBeGreaterThan(0);
  });
});
```

### Step 4: 测试用例 2 — shallow 能力校验

```ts
test("服务端不支持 shallow 时，指定 depth 抛出 FetchPackError", async () => {
  const store = createMemoryObjectStore();
  const transport = {
    advertise: async (): Promise<RefAdvertisement> => ({
      capabilities: { multi_ack: true }, // 无 "shallow"
      refs: [],
    }),
    request: async () => Buffer.from(""),
  };

  const adv = await transport.advertise();
  const result = fetchPack(store, transport, adv, {
    wants: [sha1("0000000000000000000000000000000000000001")],
    depth: 1,
  });

  expect(result).rejects.toBeInstanceOf(FetchPackError);
  expect(result).rejects.toThrow(/shallow/);
});
```

### Step 5: 测试用例 3 — 多轮增量协商

模拟服务端在 haves 不足时返回 NAK，在收到足够 haves 后返回 ACK + packfile：

```ts
test("增量协商：先 NAK 再 ACK 的多轮交互", async () => {
  const store = createMemoryObjectStore();
  const emptyTree = store.write({ type: "tree", entries: [] });
  const oldCommit = createTestCommit(store, emptyTree, [], 1000);
  const newCommit = createTestCommit(store, emptyTree, [oldCommit], 2000);
  // 写下 newCommit 但不写下 oldCommit 的 parent 以模拟增量

  let round = 0;
  const transport = createMockTransport(async (body) => {
    round++;
    const packData = buildSimplePack([store.read(newCommit)]);
    if (round === 1) {
      return encodePktLine("NAK\n") + packData;
    }
    return encodePktLine("NAK\n") + packData;
  });

  const adv = await transport.advertise();
  const result = await fetchPack(store, transport, adv, {
    wants: [newCommit],
    haves: [oldCommit],
  });

  expect(result.objectCount).toBeGreaterThan(0);
});
```

### Step 6: 测试用例 4 — ready 响应处理

```ts
test("服务端返回 ready 时立即发送 done 并接收 packfile", async () => {
  const store = createMemoryObjectStore();
  const emptyTree = store.write({ type: "tree", entries: [] });
  const commitHash = createTestCommit(store, emptyTree, [], 1000);

  let round = 0;
  const transport = createMockTransport(async (body) => {
    round++;
    if (round === 1) {
      // 首轮返回 ready
      const ackLine = encodePktLine(`ACK ${commitHash} ready\n`);
      return ackLine;
    }
    // 第二轮（done 后）返回 packfile
    const packData = buildSimplePack([store.read(commitHash)]);
    return encodePktLine("NAK\n") + packData;
  });

  const adv = await transport.advertise();
  const result = await fetchPack(store, transport, adv, {
    wants: [commitHash],
    haves: [commitHash],
  });

  expect(result.objectCount).toBeGreaterThan(0);
});
```

### Step 7: 运行全部测试

```bash
bun test tests/units/transport/fetch-pack.test.ts
bun test tests/units/
bun run lint
```

**Verify**: `bun test` 全部通过，lint 无错误。

## Test plan

测试文件 `tests/units/transport/fetch-pack.test.ts` 应包含：

1. 初始 clone（无 haves → 直接 done）
2. shallow 能力校验失败
3. 多轮增量协商（先 NAK 后 ACK）
4. ready 响应处理
5. 空 wants 的错误处理
6. （可选）服务端返回不完整响应时的错误处理

## Done criteria

- [ ] `bun test tests/units/transport/fetch-pack.test.ts` — 全部测试通过
- [ ] 新增测试文件不修改任何源文件（`git status` 确认）
- [ ] `bun run lint` 无错误
- [ ] `plans/README.md` 状态行已更新

## STOP conditions

- 测试需要在 mock transport 构造上依赖 `fetchPack` 未导出的内部函数 → 报告并讨论是否需要导出
- 需要修改 `fetch-pack.ts` 本身才能进行测试（例如需要调整类型或导出名）→ 停止并报告
- `fetch-pack.ts` 的代码摘录与工作树不符

## Maintenance notes

- 如果将来 `fetch-pack.ts` 的协商逻辑变更（如增加协议 v2 支持），这些测试应同步更新
- mock transport 模式复用自 `push-protocol.test.ts`，保持一致性
- 测试使用最小化 packfile（通过 `createPackWriter` 构建），避免依赖完整 packfile 构建器
