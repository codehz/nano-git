# Plan 004: Transport 模块测试覆盖率补充

> **Executor instructions**: 按步骤依次执行，每步完成后运行验证命令并确认预期结果。
> 如遇到 STOP conditions 中的情况，停止并报告。
>
> **Drift check**: `git diff --stat 0b84c60..HEAD -- src/transport/ tests/units/transport/`
> 如有文件已变化，先对比 "Current state" 摘录与当前代码；不一致则 STOP。

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `0b84c60`, 2026-06-22

## Why this matters

transport 模块共 27 个源文件，目前只有 15 个有对应的测试文件。多个在 fetch/push/import-session 中被依赖的基础模块没有直接单元测试：

- `advertise.ts` — 广告获取入口，被 `repository/remote-operations.ts` 和 `import-session.ts` 依赖
- `object-graph.ts` — 可达性遍历、祖先判断、tag 解引用，在 push-policy.ts、update-refs.ts、push-pack-plan.ts、import-session.ts 中被使用，目前仅被 push 集成测试间接覆盖
- `ref-collection.ts` — `getLocalRefs()` 和 `remoteRefsToMap()`，被 push.ts、fetch-pack.ts、import-session.ts 使用
- `ref-match.ts` — ref 匹配逻辑，被 fetch-ref-plan.ts 使用
- `update-refs.ts` — ref 更新校验与写入，是 fetch 结果消费的核心步骤

这些模块的边界条件（空 refs、缺失对象、循环引用、特殊字符等）仅能被端到端测试间接覆盖，缺少快速反馈的单元测试层。

## Current state

| 源文件                            | 场景角色                                               | 测试现状               |
| --------------------------------- | ------------------------------------------------------ | ---------------------- |
| `src/transport/advertise.ts`      | `advertiseRemote()` 便捷封装                           | 无测试文件             |
| `src/transport/object-graph.ts`   | `collectReachable()`, `isAncestor()`, `peelTagChain()` | 仅被 push 测试间接覆盖 |
| `src/transport/ref-collection.ts` | `getLocalRefs()`, `remoteRefsToMap()`                  | 无测试文件             |
| `src/transport/ref-match.ts`      | ref 名称匹配                                           | 无测试文件             |
| `src/transport/update-refs.ts`    | `resolveBranchTargetHash()`, `applyRefUpdates()`       | 无测试文件             |

项目约定：

- 测试使用 `bun:test`（`describe` / `test` / `expect`）
- 导入使用 `@/` 路径别名
- 异步异常断言使用 `expect(promise).rejects.toBeInstanceOf(ErrorType)`
- 注释使用中文
- 内存存储优先（`createMemoryObjectStore`, `createMemoryRefStore`）

已有测试模式参考：

- `tests/units/transport/push-protocol.test.ts` — mock transport + memory store
- `tests/units/transport/push-fast-forward.test.ts` — 对象图算法间接测试
- `tests/units/transport/fetch-refspec.test.ts` — ref 匹配测试

## Commands you will need

| Purpose        | Command                           | Expected on success |
| -------------- | --------------------------------- | ------------------- |
| Install        | `bun install`                     | exit 0              |
| Run tests      | `bun test tests/units/transport/` | all pass            |
| All unit tests | `bun test tests/units/`           | all pass            |
| Lint           | `bun run lint`                    | exit 0              |

## Scope

**In scope** — 需要创建/修改的测试文件：

- `tests/units/transport/ref-collection.test.ts` — 新建
- `tests/units/transport/object-graph.test.ts` — 新建
- `tests/units/transport/update-refs.test.ts` — 新建

**Low priority**（仅在时间允许时创建）:

- `tests/units/transport/advertise.test.ts` — 测试 `advertiseRemote()` 的 URL 拼接和认证参数传递

**Out of scope**:

- `src/transport/` 下的任何源文件（不改动）
- `tests/units/transport/` 下的已有测试文件（不改动）
- `ref-match.ts` — 功能简单且被 fetch-refspec.test.ts 间接覆盖

## Steps

### Step 1: 创建 `ref-collection.test.ts`

测试 `getLocalRefs()` 和 `remoteRefsToMap()`：

```ts
/**
 * ref-collection 单元测试
 *
 * 覆盖 getLocalRefs() 和 remoteRefsToMap() 的基础功能：
 * - 正常收集本地 refs
 * - 空 refs 存储
 * - 损坏/循环引用的 refs 不影响其他 ref（getLocalRefs 内部 catch）
 * - HEAD 指向 refs/ 外的引用
 * - HEAD 循环引用被安全忽略
 * - 远程 refs 转 map
 * - 空远程 refs 列表
 */

import { describe, test, expect } from "bun:test";

import { sha1, type SHA1 } from "@/core/types.ts";
import { createMemoryRefStore } from "@/refs/stores/memory.ts";
import { getLocalRefs, remoteRefsToMap } from "@/transport/ref-collection.ts";

describe("getLocalRefs()", () => {
  test("正常收集多个 refs", () => {
    const refs = createMemoryRefStore(
      new Map([
        ["HEAD", "ref: refs/heads/main"],
        ["refs/heads/main", "95d09f2b10159347eece71399a7e2e907ea3df4f"],
        ["refs/heads/dev", "1111111111111111111111111111111111111111"],
        ["refs/tags/v1", "2222222222222222222222222222222222222222"],
      ]),
    );
    const result = getLocalRefs(refs);
    expect(result.has("HEAD")).toBe(true);
    expect(result.has("refs/heads/main")).toBe(true);
    expect(result.has("refs/heads/dev")).toBe(true);
    expect(result.has("refs/tags/v1")).toBe(true);
  });

  test("空 refs 存储返回空 Map", () => {
    const refs = createMemoryRefStore(new Map());
    const result = getLocalRefs(refs);
    expect(result.size).toBe(0);
  });

  test("损坏的 ref 被忽略，不影响其他 ref", () => {
    const refs = createMemoryRefStore(
      new Map([
        ["HEAD", "ref: refs/heads/main"],
        ["refs/heads/main", "not-a-valid-hash"], // 解析时 sha1() 会抛出 InvalidSHA1Error
      ]),
    );
    const result = getLocalRefs(refs);
    // HEAD 解析失败（因为 main 返回无效 hash），所以 HEAD 不在结果中
    // 但 main 本身因为无效哈希，resolveRefHash 返回 null
    expect(result.size).toBe(0);
  });

  test("循环引用的 HEAD 被安全忽略", () => {
    const refs = createMemoryRefStore(
      new Map([
        ["HEAD", "ref: refs/heads/main"],
        ["refs/heads/main", "ref: HEAD"],
      ]),
    );
    const result = getLocalRefs(refs);
    expect(result.size).toBe(0);
  });
});

describe("remoteRefsToMap()", () => {
  test("正常转换", () => {
    const refs = [
      { name: "refs/heads/main", hash: sha1("95d09f2b10159347eece71399a7e2e907ea3df4f") },
      { name: "refs/heads/dev", hash: sha1("1111111111111111111111111111111111111111") },
    ];
    const map = remoteRefsToMap(refs);
    expect(map.size).toBe(2);
    expect(map.get("refs/heads/main")).toBeDefined();
    expect(map.get("refs/heads/dev")).toBeDefined();
  });

  test("空列表返回空 Map", () => {
    const map = remoteRefsToMap([]);
    expect(map.size).toBe(0);
  });
});
```

**Verify**: `bun test tests/units/transport/ref-collection.test.ts` → 全部通过。

### Step 2: 创建 `object-graph.test.ts`

测试 `collectReachable()`、`isAncestor()` 和 `peelTagChain()`：

```ts
/**
 * object-graph 单元测试
 *
 * 覆盖 collectReachable()、isAncestor()、peelTagChain() 的核心功能：
 * - collectReachable: 基本可达性、missing skip/throw/skip-commit-parents
 * - isAncestor: 直接祖先、非祖先、相同哈希、带 shallow boundaries
 * - peelTagChain: 单层 tag、多层 tag、非 tag 直接返回、缺失对象
 */

import { describe, test, expect } from "bun:test";

import { sha1, type SHA1, type GitCommit, type GitTag, type GitBlob } from "@/core/types.ts";
import { createMemoryObjectStore } from "@/odb/memory-store.ts";
import { collectReachable, isAncestor, peelTagChain } from "@/transport/object-graph.ts";
import { ObjectNotFoundError } from "@/core/errors.ts";

// 辅助：创建测试 commit
function createCommit(
  store: ReturnType<typeof createMemoryObjectStore>,
  tree: SHA1,
  parents: SHA1[],
  timestamp = 1000,
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
```

关键测试用例：

- `collectReachable`: 单链 commits、叉合并、blob/tree 可达性、missing "skip" 模式
- `collectReachable`: missing "throw" 模式遇到缺失对象抛出
- `isAncestor`: 直接祖先关系、非祖先关系、相同哈希、shallow boundaries
- `peelTagChain`: 直接 commit、annotated tag → commit、多层 annotated tag

**Verify**: `bun test tests/units/transport/object-graph.test.ts` → 全部通过。

### Step 3: 创建 `update-refs.test.ts`

测试 `resolveBranchTargetHash()` 和 `applyRefUpdates()`：

```ts
/**
 * update-refs 单元测试
 *
 * 覆盖 resolveBranchTargetHash() 和 applyRefUpdates()：
 * - resolveBranchTargetHash: commit 通过、tag 拒绝、tree/blob 拒绝、缺失对象
 * - applyRefUpdates: 基本 ref 更新、refs/heads/* 的 commit 校验
 * - refs/tags/* 的替换拒绝、fast-forward 检查
 */

import { describe, test, expect } from "bun:test";

import { sha1, type SHA1, type GitCommit, type GitTag } from "@/core/types.ts";
import { createMemoryObjectStore } from "@/odb/memory-store.ts";
import { createMemoryRefStore } from "@/refs/stores/memory.ts";
import { resolveBranchTargetHash, applyRefUpdates } from "@/transport/update-refs.ts";
import { RefUpdateError } from "@/transport/update-refs.ts";

import type { RefUpdatePlanItem } from "@/transport/types.ts";
```

**Verify**: `bun test tests/units/transport/update-refs.test.ts` → 全部通过。

### Step 4: 运行全部运输层测试和 lint

```bash
bun test tests/units/transport/
bun test tests/units/
bun run lint
```

**Verify**: 全部测试通过，lint 无错误。

## Test plan

### 新增测试文件 1: `ref-collection.test.ts`

- `getLocalRefs()`: 正常收集、空 refs、损坏 ref 跳过、循环引用跳过
- `remoteRefsToMap()`: 正常转换、空列表

### 新增测试文件 2: `object-graph.test.ts`

- `collectReachable()`: 单链、叉合并、skip missing、throw missing、树条目
- `isAncestor()`: 祖先、非祖先、相同哈希、shallow boundary
- `peelTagChain()`: 直接非 tag、单层 tag、多层 tag

### 新增测试文件 3: `update-refs.test.ts`

- `resolveBranchTargetHash()`: commit 通过、tag 拒绝、tree 拒绝、missing 对象
- `applyRefUpdates()`: 简单更新、tag 拒绝替换、缺失对象优雅拒绝

## Done criteria

- [ ] `bun test tests/units/transport/ref-collection.test.ts` — 全部通过
- [ ] `bun test tests/units/transport/object-graph.test.ts` — 全部通过
- [ ] `bun test tests/units/transport/update-refs.test.ts` — 全部通过
- [ ] `bun test tests/units/transport/` — 全部通过（含已有测试）
- [ ] `bun test tests/units/` — 全部通过
- [ ] `bun run lint` — 无错误
- [ ] 仅新建的 3 个测试文件被修改（`git status` 确认）
- [ ] `plans/README.md` 状态行已更新

## STOP conditions

- 任何测试用例需要修改源文件才能通过 → 停止并报告
- 代码摘录与工作树不符
- 测试需要依赖未导出的函数 → 报告并讨论是否要将函数改为 `export`（可选的极端情况）

## Maintenance notes

- 这些测试文件应随对应源文件的改动而更新，确保回归保护持续有效
- `object-graph.test.ts` 特别重要，因为 `collectReachable` 和 `isAncestor` 被 push、fetch、import-session 三方依赖
