/**
 * Virtual Workdir 节点 ID 分配
 */

/** 会话内节点的稳定身份 */
export type NodeId = string & { readonly __brand: "NodeId" };

/** 根目录节点的固定 ID（每个 session 一致） */
export const VIRTUAL_ROOT_NODE_ID = "root" as NodeId;

let nextNodeCounter = 1;

/**
 * 分配新的 session 节点 ID
 */
export function createNodeId(): NodeId {
  const id = `node:${nextNodeCounter}` as NodeId;
  nextNodeCounter += 1;
  return id;
}

/**
 * 重置节点 ID 计数器（仅用于测试确定性）
 */
export function resetNodeIdCounterForTests(start = 1): void {
  nextNodeCounter = start;
}
