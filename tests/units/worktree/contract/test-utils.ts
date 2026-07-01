/**
 * VirtualWorktree 组合测试共享辅助函数
 */
import { createMemoryRepository } from "@/repository/memory.ts";

import type { GitTree, SHA1 } from "@/types/index.ts";

export function readTree(repo: ReturnType<typeof createMemoryRepository>, hash: string): GitTree {
  const obj = repo.catFile(hash as SHA1);
  if (obj.type !== "tree") throw new Error(`Expected tree, got ${obj.type}`);
  return obj;
}

export function readBlob(repo: ReturnType<typeof createMemoryRepository>, hash: string): Buffer {
  const obj = repo.catFile(hash as SHA1);
  if (obj.type !== "blob") throw new Error(`Expected blob, got ${obj.type}`);
  return obj.content;
}
