/**
 * fetch 协商用本地 have 选择器
 *
 * 目标是让客户端在 v2 fetch 协商时尽量贴近官方 Git 默认 negotiator：
 * - 以本地 ref tip 作为起点
 * - 使用按提交时间排序、按首次入队顺序打破平局的优先队列
 * - known-common ref 会像上游一样先进入队列，并把祖先标记为 common
 * - 一旦某个提交被 ACK 为 common，就跳过其祖先链，避免无效 have
 */

import { tryReadObject } from "../../../objects/raw.ts";
import { sha1 } from "../../../types/index.ts";
import { peelTagChain } from "../../protocol/object-graph.ts";

import type { SHA1 } from "../../../types/index.ts";
import type { ObjectSource } from "../../../types/odb.ts";

/** 节点标记：该提交已知为双方共同拥有 */
const FLAG_COMMON = 1 << 0;
/** 节点标记：该提交对应一个“已知远端也有”的公共 ref */
const FLAG_COMMON_REF = 1 << 1;
/** 节点标记：该提交已进入优先队列 */
const FLAG_SEEN = 1 << 2;
/** 节点标记：该提交已从优先队列弹出 */
const FLAG_POPPED = 1 << 3;
/** 节点标记：该提交已经作为 have 发出 */
const FLAG_SENT = 1 << 4;

interface CommitNegotiationNode {
  readonly oid: SHA1;
  readonly timestamp: number;
  readonly parents: readonly SHA1[];
  pushOrder?: number;
  flags: number;
}

interface CommitNegotiationState {
  readonly source: ObjectSource;
  readonly nodes: Map<SHA1, CommitNegotiationNode>;
  readonly queue: CommitNegotiationNode[];
  nextPushOrder: number;
  nonCommonRevs: number;
}

/**
 * fetch 协商 have 选择器
 *
 * `next()` 返回下一条应发送的 have；`ack()` 吸收服务端返回的 common。
 */
export interface FetchHaveSelector {
  /**
   * 取出下一条 have
   *
   * @returns 下一条 have，若已无可发送项则返回 undefined
   *
   * @example
   * ```ts
   * const oid = selector.next();
   * if (oid) console.log(oid);
   * ```
   */
  next(): SHA1 | undefined;

  /**
   * 吸收 ACK 为 common 的对象
   *
   * @param oid - 服务端确认 common 的对象
   * @returns 该对象此前是否已知为 common
   *
   * @example
   * ```ts
   * selector.ack(sha1("0123456789abcdef0123456789abcdef01234567"));
   * ```
   */
  ack(oid: SHA1): boolean;

  /**
   * 提示一个“远端 ref 已知与本地相同”的公共提交
   *
   * 该提交本身仍可能需要发送一次 have，
   * 但它的祖先可直接视作 common。
   */
  knownCommon(oid: SHA1): void;

  /**
   * 释放祖先遍历阶段
   *
   * 当前实现与官方默认 negotiator 一样会立刻沿祖先链继续扩展，
   * 因此这里保留为兼容空操作。
   */
  releaseAncestors(): void;
}

interface FetchHaveSelectorOptions {
  readonly replayKnownCommonInFirstRound?: boolean;
  readonly localShallowBoundaries?: readonly SHA1[];
  readonly deferAncestorExpansionUntilRelease?: boolean;
}

function compareNodes(a: CommitNegotiationNode, b: CommitNegotiationNode): number {
  if (a.timestamp !== b.timestamp) {
    return b.timestamp - a.timestamp;
  }
  return (a.pushOrder ?? 0) - (b.pushOrder ?? 0);
}

function swapQueue(queue: CommitNegotiationNode[], left: number, right: number): void {
  const temp = queue[left]!;
  queue[left] = queue[right]!;
  queue[right] = temp;
}

function queuePut(queue: CommitNegotiationNode[], node: CommitNegotiationNode): void {
  queue.push(node);

  for (let index = queue.length - 1; index > 0; ) {
    const parent = Math.floor((index - 1) / 2);
    if (compareNodes(queue[parent]!, queue[index]!) <= 0) {
      break;
    }
    swapQueue(queue, parent, index);
    index = parent;
  }
}

function queueGet(queue: CommitNegotiationNode[]): CommitNegotiationNode | undefined {
  if (queue.length === 0) {
    return undefined;
  }

  const result = queue[0]!;
  const tail = queue.pop()!;
  if (queue.length === 0) {
    return result;
  }

  queue[0] = tail;

  for (let index = 0; index * 2 + 1 < queue.length; ) {
    let child = index * 2 + 1;
    if (child + 1 < queue.length && compareNodes(queue[child]!, queue[child + 1]!) >= 0) {
      child++;
    }

    if (compareNodes(queue[index]!, queue[child]!) <= 0) {
      break;
    }

    swapQueue(queue, child, index);
    index = child;
  }

  return result;
}

function loadCommitNode(source: ObjectSource, oid: SHA1): CommitNegotiationNode | undefined {
  const obj = tryReadObject(source, oid);
  if (obj?.type !== "commit") {
    return undefined;
  }

  return {
    oid,
    timestamp: obj.committer.timestamp,
    parents: obj.parents,
    flags: 0,
  };
}

function normalizeNegotiationCommitOid(source: ObjectSource, oid: SHA1): SHA1 | undefined {
  const peeled = peelTagChain(source, oid);
  const obj = tryReadObject(source, peeled);
  if (obj?.type !== "commit") {
    return undefined;
  }
  return peeled;
}

function getCommitNode(
  state: CommitNegotiationState,
  oid: SHA1,
): CommitNegotiationNode | undefined {
  const cached = state.nodes.get(oid);
  if (cached) {
    return cached;
  }

  const loaded = loadCommitNode(state.source, oid);
  if (!loaded) {
    return undefined;
  }

  state.nodes.set(oid, loaded);
  return loaded;
}

function revListPush(
  state: CommitNegotiationState,
  oid: SHA1,
  mark = FLAG_SEEN,
): CommitNegotiationNode | undefined {
  const node = getCommitNode(state, oid);
  if (!node || (node.flags & mark) !== 0) {
    return node;
  }

  node.flags |= mark;
  node.pushOrder ??= state.nextPushOrder++;
  queuePut(state.queue, node);
  if ((node.flags & FLAG_COMMON) === 0) {
    state.nonCommonRevs++;
  }
  return node;
}

function markCommon(state: CommitNegotiationState, oid: SHA1, ancestorsOnly: boolean): boolean {
  const initial = getCommitNode(state, oid);
  if (!initial) {
    return false;
  }

  const knownToBeCommon = (initial.flags & FLAG_COMMON) !== 0;
  if (knownToBeCommon) {
    return true;
  }
  const stack: CommitNegotiationNode[] = [initial];

  if (!ancestorsOnly) {
    initial.flags |= FLAG_COMMON;
    if ((initial.flags & FLAG_SEEN) !== 0 && (initial.flags & FLAG_POPPED) === 0) {
      state.nonCommonRevs--;
    }
  }

  while (stack.length > 0) {
    const current = stack.pop()!;

    if ((current.flags & FLAG_SEEN) === 0) {
      revListPush(state, current.oid, FLAG_SEEN);
      continue;
    }

    for (const parent of current.parents) {
      const parentNode = getCommitNode(state, parent);
      if (!parentNode || (parentNode.flags & FLAG_COMMON) !== 0) {
        continue;
      }

      parentNode.flags |= FLAG_COMMON;
      if ((parentNode.flags & FLAG_SEEN) !== 0 && (parentNode.flags & FLAG_POPPED) === 0) {
        state.nonCommonRevs--;
      }
      stack.push(parentNode);
    }
  }

  return knownToBeCommon;
}

function createLinearSelector(candidates: readonly SHA1[]): FetchHaveSelector {
  const queue = [...new Set(candidates)];
  let offset = 0;

  return {
    next(): SHA1 | undefined {
      const oid = queue[offset];
      offset++;
      return oid;
    },

    ack(_oid: SHA1): boolean {
      return false;
    },

    knownCommon(_oid: SHA1): void {},

    releaseAncestors(): void {},
  };
}

function pushKnownCommon(state: CommitNegotiationState, oid: SHA1): void {
  const commitOid = normalizeNegotiationCommitOid(state.source, oid);
  if (!commitOid) {
    return;
  }

  const node = getCommitNode(state, commitOid);
  if (!node || (node.flags & FLAG_SEEN) !== 0) {
    return;
  }

  revListPush(state, commitOid, FLAG_COMMON_REF | FLAG_SEEN);
  markCommon(state, commitOid, true);
}

function markKnownCommonForReplay(state: CommitNegotiationState, oid: SHA1): void {
  const commitOid = normalizeNegotiationCommitOid(state.source, oid);
  if (!commitOid) {
    return;
  }

  const node = getCommitNode(state, commitOid);
  if (!node) {
    return;
  }

  node.flags |= FLAG_COMMON_REF | FLAG_SEEN | FLAG_SENT;
  markCommon(state, commitOid, true);
}

/**
 * 创建默认 fetch 协商 have 选择器
 *
 * 若提供本地对象源，则尝试按 commit 图和提交时间进行选择；
 * 否则回退为按输入顺序线性发送。
 *
 * @param candidates - 本地 have 候选集合（通常为本地 refs tip）
 * @param source - 本地对象源（可选）
 * @param knownCommonCandidates - 已知与远端一致的公共 ref 提示（可选）
 * @returns have 选择器
 *
 * @example
 * ```ts
 * const selector = createFetchHaveSelector(
 *   [sha1("0123456789abcdef0123456789abcdef01234567")],
 *   objects,
 * );
 * const first = selector.next();
 * ```
 */
export function createFetchHaveSelector(
  candidates: readonly string[],
  source?: ObjectSource,
  knownCommonCandidates?: readonly string[],
  options: FetchHaveSelectorOptions = {},
): FetchHaveSelector {
  const normalized = candidates.map((oid) => sha1(oid));
  if (!source) {
    return createLinearSelector(normalized);
  }

  const state: CommitNegotiationState = {
    source,
    nodes: new Map(),
    queue: [],
    nextPushOrder: 0,
    nonCommonRevs: 0,
  };
  const localShallowBoundaries = new Set(
    (options.localShallowBoundaries ?? []).map((oid) => sha1(oid)),
  );
  const pendingAncestorExpansion: CommitNegotiationNode[] = [];

  function expandParents(current: CommitNegotiationNode): void {
    const parentMark =
      (current.flags & (FLAG_COMMON | FLAG_COMMON_REF)) !== 0 ? FLAG_COMMON | FLAG_SEEN : FLAG_SEEN;

    if (localShallowBoundaries.has(current.oid)) {
      return;
    }

    for (const parent of current.parents) {
      const parentNode = getCommitNode(state, parent);
      if (!parentNode) {
        continue;
      }
      if ((parentNode.flags & FLAG_SEEN) === 0) {
        revListPush(state, parent, parentMark);
      }
      if ((parentMark & FLAG_COMMON) !== 0) {
        markCommon(state, parent, true);
      }
    }
  }

  if (knownCommonCandidates) {
    for (const oid of knownCommonCandidates) {
      if (options.replayKnownCommonInFirstRound === true) {
        markKnownCommonForReplay(state, sha1(oid));
      } else {
        pushKnownCommon(state, sha1(oid));
      }
    }
  }

  for (const rawOid of normalized) {
    const oid = normalizeNegotiationCommitOid(state.source, rawOid);
    if (!oid) {
      continue;
    }
    revListPush(state, oid, FLAG_SEEN);
  }

  return {
    next(): SHA1 | undefined {
      while (state.queue.length > 0 && state.nonCommonRevs > 0) {
        const current = queueGet(state.queue)!;
        current.flags |= FLAG_POPPED;
        if ((current.flags & FLAG_COMMON) === 0) {
          state.nonCommonRevs--;
        }

        const shouldSend = (current.flags & FLAG_COMMON) === 0;
        if (options.deferAncestorExpansionUntilRelease === true) {
          pendingAncestorExpansion.push(current);
        } else {
          expandParents(current);
        }

        if (shouldSend && (current.flags & FLAG_SENT) === 0) {
          current.flags |= FLAG_SENT;
          return current.oid;
        }
      }

      return undefined;
    },

    ack(oid: SHA1): boolean {
      return markCommon(state, oid, false);
    },

    knownCommon(oid: SHA1): void {
      pushKnownCommon(state, oid);
    },

    releaseAncestors(): void {
      if (options.deferAncestorExpansionUntilRelease !== true) {
        return;
      }

      while (pendingAncestorExpansion.length > 0) {
        expandParents(pendingAncestorExpansion.shift()!);
      }
    },
  };
}
