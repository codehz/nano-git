/**
 * Virtual Workdir 节点 ID 分配
 */

/**
 * workdir 内节点的稳定身份。
 *
 * `NodeId` 表示当前 workdir 视图中的“可变节点身份”，
 * 不是 Git 对象身份；多个路径即使复用同一个 origin hash，
 * 也必须拥有不同的 `NodeId`。
 */
export type NodeId = string & { readonly __brand: "NodeId" };

/** 根目录节点的固定 ID（每个 workdir 一致） */
export const VIRTUAL_ROOT_NODE_ID = "root" as NodeId;

let nextNodeCounter = 1;

/**
 * 分配新的 workdir 节点 ID
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

/**
 * 为 origin 路径派生稳定的 workdir 节点 ID。
 *
 * 注意：节点身份必须按路径隔离，不能按对象 hash 复用；
 * 同一个 blob/tree hash 可能被多个路径引用，但这些路径在 workdir 中
 * 需要拥有独立的可变节点身份。
 */
export function originPathNodeId(path: string): NodeId {
  return `origin-path:${path || "/"}` as NodeId;
}
