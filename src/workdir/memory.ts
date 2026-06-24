/**
 * 内存 VirtualWorkdir Session 便捷创建函数
 *
 * 对应 `nano-git/workdir/memory` 子路径。
 * 基于内存仓库的 objects（ObjectDatabase）创建可变 tree 视图。
 *
 * @example
 * ```ts
 * import { createMemoryRepository } from "nano-git/repository/memory";
 * import { createVirtualWorkdirSession } from "nano-git/workdir/memory";
 *
 * const repo = createMemoryRepository();
 * const tree = repo.createTree([]);
 * const session = createVirtualWorkdirSession(repo.objects, { baseTree: tree });
 * session.writeFile("a.txt", Buffer.from("hello"));
 * const newTree = session.writeTree();
 * ```
 */

export { createVirtualWorkdirSession } from "./session.ts";
