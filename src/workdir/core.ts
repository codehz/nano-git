/**
 * Virtual Workdir 公开类型、接口与错误
 *
 * 本文件是 `nano-git/workdir/core` 子路径的唯一入口，
 * 包含 VirtualWorkdir 的公开 API 边界定义。
 *
 * 约定：
 * - 本文件只放公开边界定义（接口、类型、re-export 的错误类）
 * - 实现逻辑放在同目录下其他模块中
 * - 所有实现模块通过工厂函数模式组装
 */

import type { DiffEntry } from "../core/diff.ts";
import type { SHA1 } from "../core/types.ts";

export {
  VirtualPathNotFoundError,
  VirtualPathAlreadyExistsError,
  VirtualNotDirectoryError,
  VirtualNotFileError,
  VirtualNotSymlinkError,
  VirtualOriginUnavailableError,
  VirtualRevertNotSupportedError,
} from "../core/errors.ts";

// ==================== 节点类型辅助 ====================

/**
 * 虚拟工作目录条目种类
 *
 * - `"blob"`: 普通文件或可执行文件（mode 100644 / 100755）
 * - `"tree"`: 目录（mode 40000）
 * - `"symlink"`: 符号链接（mode 120000）
 */
export type VirtualEntryKind = "blob" | "tree" | "symlink";

// ==================== 查询结果类型 ====================

/**
 * 虚拟路径状态信息
 *
 * 由 `stat()` 返回，描述路径对应的节点属性。
 */
export interface VirtualEntryStat {
  /** 条目种类 */
  readonly kind: VirtualEntryKind;
  /** Git 文件模式（如 "100644"、"100755"、"040000"、"120000"） */
  readonly mode: string;
  /** 文件大小（对 blob 和 symlink 有效；目录返回 0） */
  readonly size: number;
  /** 内容哈希（对 repo-backed 节点返回 origin 哈希；CoW 节点可能为 null） */
  readonly hash: SHA1 | null;
}

/**
 * 目录条目
 *
 * 由 `readdir()` 返回，描述目录下的子条目。
 */
export interface VirtualDirEntry {
  /** 条目名称（不含路径前缀） */
  readonly name: string;
  /** 条目种类 */
  readonly kind: VirtualEntryKind;
  /** Git 文件模式 */
  readonly mode: string;
}

// ==================== Diff 类型 ====================

// ==================== Workdir 工厂选项 ====================

/**
 * 创建 VirtualWorkdir 的选项
 */
export interface CreateVirtualWorkdirOptions {
  /** 基线 tree 的 SHA-1 哈希 */
  readonly baseTree: SHA1;
}

/**
 * VirtualWorkdir（虚拟工作目录实例）
 *
 * 提供独立生命周期的可变 tree 视图，基于 `baseTree + CoW overlay` 模型。
 * 不绑定 commit，不涉及 Git index / 真实工作目录。
 *
 * 关键模型边界：
 * - 路径：定位当前 workdir 中的可见条目
 * - 节点身份：workdir 内部可变实体，由 `NodeId` 表示
 * - origin hash：Git ODB 中的不可变对象身份
 *
 * 同一个 origin hash 可以被多个路径引用；
 * 这些路径在 workdir 中仍需拥有独立节点身份，避免单路径写入、恢复、复制时发生串改。
 *
 * 当前实例对 origin 仓库对象采用弱保证：
 * 如果 base tree / origin blob 在后续被移除、损坏或不可读取，
 * 相关读取、`revert()`、`writeTree()` 等操作会抛出 `VirtualOriginUnavailableError`。
 *
 * @example
 * ```ts
 * import { createMemoryRepository } from "nano-git/repository/memory";
 * import { createVirtualWorkdir } from "nano-git/workdir/memory";
 *
 * const repo = createMemoryRepository();
 * const tree = repo.writeTree(); // 初始空 tree
 * const workdir = createVirtualWorkdir(repo.objects, { baseTree: tree });
 *
 * workdir.writeFile("hello.txt", Buffer.from("world"));
 * const newTree = workdir.writeTree();
 * ```
 */
export interface VirtualWorkdir {
  /** 当前基线 tree 的 SHA-1 哈希 */
  readonly baseTree: SHA1;

  // ==================== 只读查询 ====================

  /** 路径是否存在 */
  exists(path: string): boolean;

  /** 获取路径状态信息，不存在时返回 null */
  stat(path: string): VirtualEntryStat | null;

  /** 读取目录内容，根目录为 "" */
  readdir(path?: string): VirtualDirEntry[];

  /** 读取文件内容 */
  readFile(path: string): Buffer;

  /** 读取符号链接目标 */
  readLink(path: string): string;

  // ==================== 写入操作 ====================

  /** 写入文件（新建或覆盖） */
  writeFile(path: string, content: Buffer, options?: { readonly mode?: "100644" | "100755" }): void;

  /** 写入符号链接（新建或覆盖） */
  writeLink(path: string, target: string): void;

  /**
   * 创建目录
   *
   * 默认要求各级父目录已存在；`recursive: true` 时自动创建缺失的父目录，
   * 且目标路径已是目录时不报错。路径上任意段为文件（非目录）时抛出 `VirtualNotDirectoryError`。
   */
  mkdir(path: string, options?: { readonly recursive?: boolean }): void;

  /**
   * 删除路径（文件、目录或符号链接）
   *
   * 默认要求路径已存在；`force: true` 时路径不存在则静默忽略（与 Node `fs.rm` 的 `force` 语义一致）。
   */
  delete(path: string, options?: { readonly force?: boolean }): void;

  // ==================== 结构操作 ====================

  /**
   * 移动路径（可跨目录树）
   *
   * 当前语义等价于 copy + delete。
   * 目标父目录不存在时会自动创建中间目录。
   */
  move(from: string, to: string): void;

  /**
   * 复制路径
   *
   * 新建 workdir node，共享 origin，不共享 node 身份。
   * 目录复制采用 CoW（写时复制）：子树节点共享同一份 origin 引用，
   * 任一副本下的子项被修改时才会真正分裂出独立副本。
   */
  copy(from: string, to: string): void;

  // ==================== 状态恢复 ====================

  /**
   * 恢复路径到其 origin
   *
   * 仅对当前 CoW 节点恢复其 origin（repo-backed 版本）。
   * 对纯新建节点抛出 VirtualRevertNotSupportedError。
   */
  revert(path: string): void;

  /**
   * 读取最终 diff
   *
   * 输出按路径稳定排序，包含文件、目录与符号链接条目。
   */
  diff(): DiffEntry[];

  /**
   * 导出当前 overlay 为新 tree
   *
   * 只重新合成受影响目录，复用未修改节点的哈希。
   * 不自动推进 baseTree。
   */
  writeTree(): SHA1;

  /**
   * 重置当前实例到指定基线 tree
   *
   * 丢弃全部 overlay 与变更历史。
   */
  reset(baseTree: SHA1): void;
}
