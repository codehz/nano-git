/**
 * fetch 协商用本地 have 选择器
 *
 * 目标是让客户端在 v2 fetch 协商时更接近官方 Git 的默认 negotiator：
 * - 以本地 ref tip 作为起点
 * - 按 commit 时间逆序优先发送较新的提交
 * - 一旦某个提交被 ACK 为 common，就跳过其祖先链，避免无效 have
 *
 * 这里不尝试完整复刻 Git C 实现中的所有 flag 与模式切换，
 * 但保留了最关键的行为轮廓，供 upload-pack/fetch.ts 复用。
 */

import { tryReadObject } from "../../../objects/raw.ts";
import { sha1 } from "../../../types/index.ts";
import { isAncestor, peelTagChain } from "../../protocol/object-graph.ts";

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
  readonly order: number;
  readonly parents: readonly SHA1[];
  flags: number;
}

interface CommitNegotiationState {
  readonly source: ObjectSource;
  readonly nodes: Map<SHA1, CommitNegotiationNode>;
  readonly queue: CommitNegotiationNode[];
  nextOrder: number;
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
   * 首轮优先只发送本地 ref 的直接 tip；
   * 若仍未收敛，再继续向祖先回溯。
   */
  releaseAncestors(): void;
}

function compareNodes(a: CommitNegotiationNode, b: CommitNegotiationNode): number {
  if (a.timestamp !== b.timestamp) {
    return b.timestamp - a.timestamp;
  }
  return a.order - b.order;
}

function insertQueue(queue: CommitNegotiationNode[], node: CommitNegotiationNode): void {
  let low = 0;
  let high = queue.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const current = queue[mid]!;
    if (compareNodes(node, current) < 0) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }

  queue.splice(low, 0, node);
}

function loadCommitNode(
  source: ObjectSource,
  oid: SHA1,
  order: number,
): CommitNegotiationNode | undefined {
  const obj = tryReadObject(source, oid);
  if (obj?.type !== "commit") {
    return undefined;
  }

  return {
    oid,
    timestamp: obj.committer.timestamp,
    order,
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

  const loaded = loadCommitNode(state.source, oid, state.nextOrder);
  if (!loaded) {
    return undefined;
  }

  state.nextOrder++;
  state.nodes.set(oid, loaded);
  return loaded;
}

function revListPush(state: CommitNegotiationState, oid: SHA1): CommitNegotiationNode | undefined {
  const node = getCommitNode(state, oid);
  if (!node || (node.flags & FLAG_SEEN) !== 0) {
    return node;
  }

  node.flags |= FLAG_SEEN;
  insertQueue(state.queue, node);
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
  const stack: CommitNegotiationNode[] = [initial];

  if (!ancestorsOnly && (initial.flags & FLAG_COMMON) === 0) {
    initial.flags |= FLAG_COMMON;
    if ((initial.flags & FLAG_SEEN) !== 0 && (initial.flags & FLAG_POPPED) === 0) {
      state.nonCommonRevs--;
    }
  }

  while (stack.length > 0) {
    const current = stack.pop()!;

    if ((current.flags & FLAG_SEEN) === 0) {
      revListPush(state, current.oid);
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

function hasDirectCandidate(
  candidates: readonly CommitNegotiationNode[],
  node: CommitNegotiationNode,
): boolean {
  return candidates.some((candidate) => candidate === node);
}

function getDirectCandidateIndex(
  candidates: readonly CommitNegotiationNode[],
  node: CommitNegotiationNode,
): number {
  return candidates.findIndex((candidate) => candidate === node);
}

function insertDirectCandidate(
  candidates: CommitNegotiationNode[],
  node: CommitNegotiationNode,
  directCommitCandidates: readonly CommitNegotiationNode[],
): void {
  if (hasDirectCandidate(candidates, node)) {
    return;
  }

  const nodeDirectIndex = getDirectCandidateIndex(directCommitCandidates, node);
  if ((node.flags & FLAG_COMMON_REF) !== 0 && nodeDirectIndex !== -1) {
    let insertAt = candidates.length;
    for (let index = 0; index < candidates.length; index++) {
      const current = candidates[index]!;
      const currentDirectIndex = getDirectCandidateIndex(directCommitCandidates, current);
      if ((current.flags & FLAG_COMMON_REF) === 0) {
        insertAt = index;
        break;
      }
      if (currentDirectIndex !== -1 && nodeDirectIndex < currentDirectIndex) {
        insertAt = index;
        break;
      }
    }
    candidates.splice(insertAt, 0, node);
    return;
  }

  let low = 0;
  let high = candidates.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const current = candidates[mid]!;
    if (compareNodes(node, current) < 0) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }

  candidates.splice(low, 0, node);
}

/**
 * 创建默认 fetch 协商 have 选择器
 *
 * 若提供本地对象源，则尝试按 commit 图和提交时间进行选择；
 * 否则回退为按输入顺序线性发送。
 *
 * @param candidates - 本地 have 候选集合（通常为本地 refs tip）
 * @param source - 本地对象源（可选）
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
): FetchHaveSelector {
  const normalized = candidates.map((oid) => sha1(oid));
  if (!source) {
    return createLinearSelector(normalized);
  }

  const state: CommitNegotiationState = {
    source,
    nodes: new Map(),
    queue: [],
    nextOrder: 0,
    nonCommonRevs: 0,
  };

  const directCommitCandidates: CommitNegotiationNode[] = [];
  const directCandidates: SHA1[] = [];
  const directSeen = new Set<SHA1>();

  for (const rawOid of normalized) {
    const oid = normalizeNegotiationCommitOid(state.source, rawOid);
    if (!oid) {
      continue;
    }

    const node = revListPush(state, oid);
    if (node && !directSeen.has(oid)) {
      directSeen.add(oid);
      directCommitCandidates.push(node);
      continue;
    }

    if (!node && !directSeen.has(oid)) {
      directSeen.add(oid);
      directCandidates.push(oid);
    }
  }

  const filteredDirectCommitCandidates = [...directCommitCandidates];
  filteredDirectCommitCandidates.sort(compareNodes);

  let directCommitOffset = 0;
  let directOffset = 0;
  let hasKnownCommonDirect = false;
  // 单 tip 会像 Git CLI 一样立即沿祖先链继续协商。
  // 多 tip 默认也允许继续下探；只有命中 known-common direct tip 时，
  // 才临时收住祖先遍历，让该公共 ref 先作为 cut-point 发给服务端。
  let ancestorsReleased = directCommitCandidates.length + directCandidates.length <= 1;

  return {
    next(): SHA1 | undefined {
      while (directCommitOffset < filteredDirectCommitCandidates.length) {
        const current = filteredDirectCommitCandidates[directCommitOffset]!;
        directCommitOffset++;
        if ((current.flags & FLAG_SENT) !== 0) {
          continue;
        }
        current.flags |= FLAG_SENT;
        return current.oid;
      }

      if (directOffset < directCandidates.length) {
        const oid = directCandidates[directOffset];
        directOffset++;
        return oid;
      }

      if (!ancestorsReleased && hasKnownCommonDirect) {
        return undefined;
      }

      while (state.queue.length > 0 && state.nonCommonRevs > 0) {
        const current = state.queue.shift()!;
        current.flags |= FLAG_POPPED;
        if ((current.flags & FLAG_COMMON) === 0) {
          state.nonCommonRevs--;
        }

        for (const parent of current.parents) {
          const parentNode = getCommitNode(state, parent);
          if (!parentNode) {
            continue;
          }
          if ((parentNode.flags & FLAG_SEEN) === 0) {
            revListPush(state, parent);
          }
          if ((current.flags & (FLAG_COMMON | FLAG_COMMON_REF)) !== 0) {
            markCommon(state, parent, true);
          }
        }

        if ((current.flags & FLAG_COMMON) === 0 && (current.flags & FLAG_SENT) === 0) {
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
      const commitOid = normalizeNegotiationCommitOid(state.source, oid);
      if (!commitOid) {
        return;
      }

      const node = revListPush(state, commitOid);
      if (!node) {
        return;
      }

      node.flags |= FLAG_COMMON_REF;
      markCommon(state, commitOid, true);
      // 与官方 Git 更接近：若某个本地 tip 同时也是远端已知公共 ref，
      // 则它可以覆盖更老的 direct tip；否则不要预先用本地 tip 互相裁剪。
      if (hasDirectCandidate(directCommitCandidates, node)) {
        hasKnownCommonDirect = true;
        const existingIndex = getDirectCandidateIndex(filteredDirectCommitCandidates, node);
        if (existingIndex !== -1) {
          filteredDirectCommitCandidates.splice(existingIndex, 1);
          if (existingIndex < directCommitOffset) {
            directCommitOffset--;
          }
        }
        insertDirectCandidate(filteredDirectCommitCandidates, node, directCommitCandidates);
        for (let index = filteredDirectCommitCandidates.length - 1; index >= 0; index--) {
          const candidate = filteredDirectCommitCandidates[index]!;
          if (
            candidate !== node &&
            (candidate.flags & FLAG_COMMON_REF) === 0 &&
            isAncestor(state.source, candidate.oid, node.oid)
          ) {
            filteredDirectCommitCandidates.splice(index, 1);
            if (index < directCommitOffset) {
              directCommitOffset--;
            }
          }
        }
      }
    },

    releaseAncestors(): void {
      ancestorsReleased = true;
    },
  };
}
