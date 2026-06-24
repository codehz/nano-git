/**
 * Virtual Workdir 会话内存状态（与 ODB 后端无关的纯状态容器）
 */

import { createVirtualChangeLog, type VirtualChangeLog } from "./change-log.ts";
import { VIRTUAL_ROOT_NODE_ID } from "./ids.ts";
import { createRootDirectoryNode, type SessionNode } from "./nodes.ts";

import type { SHA1 } from "../core/types.ts";
import type { NodeId } from "./ids.ts";

/**
 * 单个 session 的可变内存状态
 */
export interface VirtualWorkdirMemoryState {
  /** 当前基线 tree */
  baseTree: SHA1;
  /** nodeId -> 节点记录 */
  readonly nodes: Map<NodeId, SessionNode>;
  /** 变更日志 */
  readonly changeLog: VirtualChangeLog;
}

/**
 * 创建初始 session 状态（仅根目录节点，绑定 baseTree origin）
 */
export function createVirtualWorkdirMemoryState(baseTree: SHA1): VirtualWorkdirMemoryState {
  const nodes = new Map<NodeId, SessionNode>();
  nodes.set(VIRTUAL_ROOT_NODE_ID, createRootDirectoryNode(baseTree));
  return {
    baseTree,
    nodes,
    changeLog: createVirtualChangeLog(),
  };
}
