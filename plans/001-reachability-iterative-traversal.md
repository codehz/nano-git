# Plan 001: reachability.ts 递归遍历改为迭代

> **Executor instructions**: 按步骤依次执行，每步完成后运行验证命令并确认预期结果。
> 如遇到 STOP conditions 中的情况，停止并报告。
>
> **Drift check**: `git diff --stat 0b84c60..HEAD -- src/repository/reachability.ts` 且 `git diff --stat -- src/repository/reachability.ts`
> 如果文件已变化（含未提交的本地修改），先对比 "Current state" 摘录与当前代码；不一致则 STOP。

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: correctness
- **Planned at**: commit `0b84c60`, 2026-06-22

## Why this matters

`reachability.ts` 中的 `collectReachableObjectHashesFrom` 使用递归遍历 commit 的 parent 链和 tree 的子条目。对于深 commit 链（数万次提交）或深层嵌套的目录结构，递归深度会超过调用栈限制，导致 `RangeError: Maximum call stack size exceeded`。这会影响 `listReachableObjects()`、`gc()`、`repack()` 等所有依赖可达性遍历的操作。

`transport/object-graph.ts` 中的 `isAncestor` 已使用 BFS（队列），但 `reachability.ts` 仍在使用递归。

## Current state

- `src/repository/reachability.ts` — 仓库级别的可达性遍历工具函数。
- 同一文件中的 `listReachableObjects()` 调用 `collectReachableObjectHashesFrom()`，后者在遍历 commit 的 parents 时递归调用自身，在遍历 tree entries 时也递归调用自身（见下方摘录）。
- 已有测试：`tests/units/repository/fs-objects.test.ts` 中 3 个 `listReachableObjects()` 测试用例。

当前代码（L34-48）：

```ts
function collectReachableObjectHashesFrom(
  objects: ObjectStore,
  hash: SHA1,
  reachable: Set<SHA1>,
): void {
  if (reachable.has(hash)) {
    return;
  }
  reachable.add(hash);
  const obj = objects.read(hash);
  switch (obj.type) {
    case "blob":
      return;
    case "tree":
      for (const entry of obj.entries) {
        collectReachableObjectHashesFrom(objects, entry.hash, reachable);
      }
      return;
    case "commit":
      collectReachableObjectHashesFrom(objects, obj.tree, reachable);
      for (const parent of obj.parents) {
        collectReachableObjectHashesFrom(objects, parent, reachable);
      }
      return;
    case "tag":
      collectReachableObjectHashesFrom(objects, obj.object, reachable);
      return;
  }
}
```

项目约定（来自 AGENTS.md）：

- "无 class"：全部工厂函数 + 对象字面量模式
- 使用 `node:` 协议导入内置模块
- 所有注释和 JSDoc 使用中文
- JSDoc 每个导出函数必须有，包含 `@example` 代码块

## Commands you will need

| Purpose      | Command                            | Expected on success |
| ------------ | ---------------------------------- | ------------------- |
| Install      | `bun install`                      | exit 0              |
| Test         | `bun test tests/units/repository/` | 所有测试通过        |
| Lint         | `bun run lint`                     | exit 0              |
| Format check | `bun run format:check`             | exit 0              |

## Scope

**In scope** (仅修改此文件):

- `src/repository/reachability.ts`

**Out of scope** (不要修改):

- `src/transport/object-graph.ts` — 内部的 `collectReachableFrom` 也是递归，但它是独立的函数签名，不在本 plan 范围内
- 其他任何文件

## Git workflow

- 直接在 `main` 分支上修改，无需创建新分支。
- 每步完成后提交一次，提交信息风格参考 `git log` 中的 conventional commits。

## Steps

### Step 1: 将 `collectReachableObjectHashesFrom` 重构为迭代版本

将内部递归函数改为显式栈（DFS 迭代），保持相同的行为语义：

- 使用 `Array<{ hash: SHA1; phase: "enter" | "exit" }>` 作为显式遍历栈（两阶段法），或使用一个更简单的栈 + 后处理模式。
- 一个简单的迭代方案：使用一个 `hash[]` 栈（DFS），`reachable` 集合保持不变。
- 对于 commit 节点：将 tree hash 和 parent hashes 都压入栈，每次从栈顶弹出处理。
- 保留 `reachable.has(hash)` 的快速返回检查。

重构后的函数应等价于（保留相同名称和签名）。注意：栈（LIFO）导致 tree entries 的处理顺序与递归版本相反，但最终结果会排序，因此不影响正确性。

```ts
function collectReachableObjectHashesFrom(
  objects: ObjectStore,
  hash: SHA1,
  reachable: Set<SHA1>,
): void {
  const stack: SHA1[] = [hash];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (reachable.has(current)) {
      continue;
    }
    reachable.add(current);

    const obj = objects.read(current);

    switch (obj.type) {
      case "blob":
        break;
      case "tree":
        for (const entry of obj.entries) {
          if (!reachable.has(entry.hash)) {
            stack.push(entry.hash);
          }
        }
        break;
      case "commit":
        if (!reachable.has(obj.tree)) {
          stack.push(obj.tree);
        }
        for (const parent of obj.parents) {
          if (!reachable.has(parent)) {
            stack.push(parent);
          }
        }
        break;
      case "tag":
        if (!reachable.has(obj.object)) {
          stack.push(obj.object);
        }
        break;
    }
  }
}
```

该函数无需修改 import 语句（`SHA1` 和 `ObjectStore` 已在作用域中）。

**Verify**: `bun test tests/units/repository/fs-objects.test.ts` → 原有 3 个 `listReachableObjects` 测试全部通过。

### Step 2: 运行全部单元测试和 lint

```bash
bun test tests/units/
bun run lint
```

**Verify**: `bun test tests/units/` → 全部 581+ 测试通过；`bun run lint` → exit 0。

## Test plan

已有测试（`tests/units/repository/fs-objects.test.ts`）覆盖了：

1. `listReachableObjects()` 只返回从 refs/HEAD 可达的对象
2. `listReachableObjects()` 会跟随 annotated tag
3. `gc()` 只保留可达对象（间接依赖 `listReachableObjects`）

这些测试已能验证重构正确性。无需新增测试。

## Done criteria

- [ ] `bun test tests/units/repository/` 全部通过
- [ ] `bun test tests/units/` 全部通过
- [ ] `bun run lint` 无错误
- [ ] `bun run format:check` 无格式问题
- [ ] 仅 `src/repository/reachability.ts` 被修改（`git status` 确认）
- [ ] `plans/README.md` 中 001 状态行已更新为 DONE

## STOP conditions

- 步骤 1 验证失败且无法修复：推测项目中其他位置可能依赖了递归调用的行为，报告并停止。
- `src/repository/reachability.ts` 在当前工作树中的内容与 "Current state" 摘录不符（包括未提交的本地修改导致的不一致）。
- 修改超出一个文件的范围。
- `git diff --stat -- src/repository/reachability.ts` 在执行前显示有本地未提交的修改，且摘录对比后发现代码已漂移。

## Maintenance notes

- `object-graph.ts` 中的 `collectReachableFrom` 也存在类似递归问题，但它有更复杂的 `missing` 策略和 `shallowBoundaries` 参数。该模块在 push/fetch 路径中使用，不受本 plan 影响。
- 本项目 "无 class" 约定要求函数式风格，本 plan 遵循该约定。
- 迭代版本使用栈（LIFO）导致 tree entries 的处理顺序与递归版本相反（entries 从末尾到开头遍历）。由于 `listReachableObjects()` 最终对结果排序，顺序差异不影响正确性。如果未来增加不排序的可达性遍历，需注意此行为。
