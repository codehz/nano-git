/**
 * 提交日志遍历核心实现
 *
 * 提供 Generator 风格的 `walkLogEntries`，支持按提交时间降序
 * 或严格拓扑序遍历提交历史。
 *
 * @example
 * ```ts
 * // 从 HEAD 开始遍历最近 10 条提交
 * const headHash = resolveRefHash(repo.refs, "HEAD")!;
 * for (const entry of walkLogEntries(repo.objects, { from: [headHash], maxCount: 10 })) {
 *   console.log(entry.hash, entry.commit.message);
 * }
 *
 * // 等价于 git log main..feature
 * const featureHash = resolveRefHash(repo.refs, "refs/heads/feature")!;
 * const mainHash = resolveRefHash(repo.refs, "refs/heads/main")!;
 * for (const entry of walkLogEntries(repo.objects, { from: [featureHash], exclude: [mainHash] })) {
 *   console.log(entry.hash, entry.commit.message);
 * }
 * ```
 */

import { tryReadObject } from "../objects/raw.ts";
import { addReachableFromCommitBitmap } from "../pack/midx/midx-bitmap.ts";

import type { ObjectSource } from "../odb/types.ts";
import type { MidxBitmapAssist } from "../pack/midx/midx-bitmap.ts";
import type { GitCommit, SHA1 } from "../types/index.ts";
import type { CommitWalkOrder, LogEntry, LogWalkOptions } from "./types.ts";

// ============================================================================
// 优先队列（最大堆，按 committer.timestamp 降序）
// ============================================================================

interface QueueEntry {
  readonly hash: SHA1;
  readonly commit: GitCommit;
}

class MaxHeapByTimestamp {
  private heap: QueueEntry[] = [];

  get size(): number {
    return this.heap.length;
  }

  push(entry: QueueEntry): void {
    this.heap.push(entry);
    this.siftUp(this.heap.length - 1);
  }

  pop(): QueueEntry | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0]!;
    const bottom = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = bottom;
      this.siftDown(0);
    }
    return top;
  }

  private siftUp(idx: number): void {
    const heap = this.heap;
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (heap[parent]!.commit.committer.timestamp >= heap[idx]!.commit.committer.timestamp) {
        break;
      }
      [heap[parent], heap[idx]] = [heap[idx]!, heap[parent]!];
      idx = parent;
    }
  }

  private siftDown(idx: number): void {
    const heap = this.heap;
    const end = heap.length;
    while (true) {
      let largest = idx;
      const left = (idx << 1) + 1;
      const right = left + 1;
      if (
        left < end &&
        heap[left]!.commit.committer.timestamp > heap[largest]!.commit.committer.timestamp
      ) {
        largest = left;
      }
      if (
        right < end &&
        heap[right]!.commit.committer.timestamp > heap[largest]!.commit.committer.timestamp
      ) {
        largest = right;
      }
      if (largest === idx) break;
      [heap[idx], heap[largest]] = [heap[largest]!, heap[idx]!];
      idx = largest;
    }
  }
}

// ============================================================================
// 排除标记
// ============================================================================

/**
 * 递归标记排除提交及其所有祖先
 */
function markExcluded(
  source: ObjectSource,
  hash: SHA1,
  excluded: Set<SHA1>,
  bitmapAssist?: MidxBitmapAssist,
): void {
  if (
    bitmapAssist &&
    addReachableFromCommitBitmap(bitmapAssist.midx, bitmapAssist.bitmap, hash, excluded)
  ) {
    return;
  }

  const stack: SHA1[] = [hash];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (excluded.has(current)) continue;
    excluded.add(current);
    const obj = tryReadObject(source, current);
    if (obj?.type === "commit") {
      for (const parent of obj.parents) {
        if (!excluded.has(parent)) {
          stack.push(parent);
        }
      }
    }
  }
}

// ============================================================================
// 日期序遍历（Generator 风格，惰性求值）
// ============================================================================

/**
 * 按提交时间降序遍历提交历史
 *
 * 使用最大堆按时间戳排序，每次弹出最新提交后将其 parent 入堆。
 * 可配合 firstParent、since、until、skip、maxCount 等过滤条件。
 */
function* walkByDate(
  source: ObjectSource,
  from: SHA1[],
  excluded: Set<SHA1>,
  firstParent: boolean,
  skip: number,
  maxCount: number | undefined,
  since: number | undefined,
  until: number | undefined,
): Generator<LogEntry, void, undefined> {
  const queue = new MaxHeapByTimestamp();
  const seen = new Set<SHA1>();
  const visited = new Set<SHA1>();

  // 将起点入堆
  for (const hash of from) {
    if (excluded.has(hash) || seen.has(hash)) continue;
    const obj = tryReadObject(source, hash);
    if (obj?.type !== "commit") continue;
    seen.add(hash);
    queue.push({ hash, commit: obj });
  }

  let skipped = 0;
  let emitted = 0;

  while (queue.size > 0) {
    if (maxCount !== undefined && emitted >= maxCount) break;

    const entry = queue.pop()!;

    // 已访问过（从另一条路径入堆）
    if (visited.has(entry.hash)) continue;

    // 理论上不会命中（入堆前已检查），但保留防御
    if (excluded.has(entry.hash)) continue;

    // 时间范围过滤
    // since：跳过旧提交，其 parent 时间戳更旧，无需继续遍历
    if (since !== undefined && entry.commit.committer.timestamp < since) continue;
    // until：跳过新提交，但其 parent 可能符合条件，需继续遍历
    if (until !== undefined && entry.commit.committer.timestamp > until) {
      enqueueParents(source, entry.commit.parents, firstParent, excluded, seen, visited, queue);
      continue;
    }

    // skip 过滤
    if (skipped < skip) {
      skipped++;
      visited.add(entry.hash);
      // skip 的提交仍需继续遍历其 parent
      enqueueParents(source, entry.commit.parents, firstParent, excluded, seen, visited, queue);
      continue;
    }

    visited.add(entry.hash);
    emitted++;
    yield { hash: entry.hash, commit: entry.commit };

    // 将 parent 入堆
    enqueueParents(source, entry.commit.parents, firstParent, excluded, seen, visited, queue);
  }
}

/**
 * 将提交的 parent 批量入堆
 */
function enqueueParents(
  source: ObjectSource,
  parents: SHA1[],
  firstParent: boolean,
  excluded: Set<SHA1>,
  seen: Set<SHA1>,
  visited: Set<SHA1>,
  queue: MaxHeapByTimestamp,
): void {
  const targetParents = firstParent && parents.length > 0 ? [parents[0]!] : parents;

  for (const parentHash of targetParents) {
    if (seen.has(parentHash) || excluded.has(parentHash)) continue;
    seen.add(parentHash);
    const obj = tryReadObject(source, parentHash);
    if (obj?.type !== "commit") continue;
    queue.push({ hash: parentHash, commit: obj });
  }
}

// ============================================================================
// 拓扑序遍历（Kahn 算法）
// ============================================================================

/**
 * 生成严格拓扑序（子提交先于父提交）的提交迭代器
 *
 * 实现 Kahn 算法：
 * 1. 收集所有起点可达的提交，构建 parent→children 映射
 * 2. 统计每个提交的未输出子提交数（childCount）
 * 3. 将 childCount === 0 的提交入堆（同层按时间戳降序）
 * 4. 每次弹出堆顶输出，递减其 parent 的 childCount
 * 5. parent 的 childCount 归零时入堆
 */
function* walkTopo(
  source: ObjectSource,
  from: SHA1[],
  excluded: Set<SHA1>,
  firstParent: boolean,
  skip: number,
  maxCount: number | undefined,
  since: number | undefined,
  until: number | undefined,
): Generator<LogEntry, void, undefined> {
  // 收集所有提交，构建 parent→children 映射
  const commits = new Map<SHA1, GitCommit>();
  const children = new Map<SHA1, SHA1[]>();

  const stack = [...from];
  while (stack.length > 0) {
    const hash = stack.pop()!;
    if (commits.has(hash) || excluded.has(hash)) continue;
    const obj = tryReadObject(source, hash);
    if (obj?.type !== "commit") continue;
    commits.set(hash, obj);

    if (!children.has(hash)) {
      children.set(hash, []);
    }

    const targetParents = firstParent && obj.parents.length > 0 ? [obj.parents[0]!] : obj.parents;

    for (const parentHash of targetParents) {
      if (commits.has(parentHash) || excluded.has(parentHash)) continue;
      // 建立反向边 parent → child
      if (!children.has(parentHash)) {
        children.set(parentHash, []);
      }
      children.get(parentHash)!.push(hash);
      stack.push(parentHash);
    }
  }

  if (commits.size === 0) return;

  // 统计 childCount，初始化队列
  const childCount = new Map<SHA1, number>();
  const pq = new MaxHeapByTimestamp();

  for (const hash of commits.keys()) {
    const count = children.get(hash)?.length ?? 0;
    childCount.set(hash, count);
    if (count === 0) {
      pq.push({ hash, commit: commits.get(hash)! });
    }
  }

  // 按拓扑序输出
  let skipped = 0;
  let emitted = 0;

  while (pq.size > 0) {
    if (maxCount !== undefined && emitted >= maxCount) break;

    const entry = pq.pop()!;

    // 时间范围过滤
    // 无论是否过滤当前提交，都需要递减 parent 的 childCount 以维持拓扑序
    if (since !== undefined && entry.commit.committer.timestamp < since) {
      decrementParentCounts(entry.commit.parents, firstParent, childCount, commits, pq);
      continue;
    }
    if (until !== undefined && entry.commit.committer.timestamp > until) {
      decrementParentCounts(entry.commit.parents, firstParent, childCount, commits, pq);
      continue;
    }

    // skip 过滤
    if (skipped < skip) {
      skipped++;
      decrementParentCounts(entry.commit.parents, firstParent, childCount, commits, pq);
      continue;
    }

    emitted++;
    yield { hash: entry.hash, commit: entry.commit };

    // 递减 parent 的 childCount
    decrementParentCounts(entry.commit.parents, firstParent, childCount, commits, pq);
  }
}

/**
 * 递减 parent 的 childCount，归零时入堆
 */
function decrementParentCounts(
  parents: SHA1[],
  firstParent: boolean,
  childCount: Map<SHA1, number>,
  commits: Map<SHA1, GitCommit>,
  pq: MaxHeapByTimestamp,
): void {
  const targetParents = firstParent && parents.length > 0 ? [parents[0]!] : parents;

  for (const parentHash of targetParents) {
    const count = childCount.get(parentHash);
    if (count === undefined) continue;
    const newCount = count - 1;
    childCount.set(parentHash, newCount);
    if (newCount === 0) {
      const parentCommit = commits.get(parentHash);
      if (parentCommit) {
        // 延迟检查 parentCommit 的 since/until——在弹出时过滤
        pq.push({ hash: parentHash, commit: parentCommit });
      }
    }
  }
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 遍历提交历史日志
 *
 * 从指定的起点哈希出发，沿 parent 链回溯，按指定排序策略输出提交。
 * 不涉及 ref 解析——调用方需自行将 ref 名称解析为 SHA1。
 *
 * @param source - 对象源（通常是 `Repository.objects`）
 * @param options - 遍历选项
 * @returns 按序输出的提交日志条目生成器
 *
 * @example
 * ```ts
 * const headHash = resolveRefHash(repo.refs, "HEAD")!;
 * for (const entry of walkLogEntries(repo.objects, { from: [headHash], maxCount: 5 })) {
 *   console.log(entry.hash, entry.commit.subject);
 * }
 * ```
 *
 * @example
 * ```ts
 * // 等价于 git log --oneline --since=1600000000 --until=1700000000
 * for (const entry of walkLogEntries(repo.objects, {
 *   from: [headHash],
 *   since: 1600000000,
 *   until: 1700000000,
 * })) {
 *   console.log(entry.hash.slice(0, 7), entry.commit.message.split("\n")[0]);
 * }
 * ```
 */
export function walkLogEntries(
  source: ObjectSource,
  options: LogWalkOptions = {},
): Generator<LogEntry, void, undefined> {
  const {
    from = [],
    exclude = [],
    skip: skipCount = 0,
    order = "date" as CommitWalkOrder,
    since,
    until,
    firstParent = false,
    maxCount,
    bitmapAssist,
  } = options;

  // 无起点时立即返回空生成器
  if (from.length === 0) {
    return emptyGenerator();
  }

  // 构建排除集
  const excluded = new Set<SHA1>();
  for (const hash of exclude) {
    markExcluded(source, hash, excluded, bitmapAssist);
  }

  if (order === "topo") {
    return walkTopo(source, from, excluded, firstParent, skipCount, maxCount, since, until);
  }

  return walkByDate(source, from, excluded, firstParent, skipCount, maxCount, since, until);
}

// ============================================================================
// 空生成器
// ============================================================================

/** 返回一个空的 Generator（不产生任何值，直接 done） */
function emptyGenerator(): Generator<LogEntry, void, undefined> {
  // 通过空数组的迭代器创建无需 yield 的空 Generator
  const empty: LogEntry[] = [];
  return empty[Symbol.iterator]() as Generator<LogEntry, void, undefined>;
}
