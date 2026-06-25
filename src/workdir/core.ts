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
  /** Git 文件模式（如 "100644"、"100755"、"40000"、"120000"） */
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

/**
 * diff 中的对象描述
 */
export interface VirtualDiffObject {
  /** 条目种类 */
  readonly kind: "blob" | "symlink";
  /** Git 文件模式 */
  readonly mode: "100644" | "100755" | "120000";
  /** 对象哈希 */
  readonly hash: SHA1;
}

/**
 * rename/copy 来源描述
 */
export interface VirtualDiffSource {
  /** 来源类型 */
  readonly kind: "rename" | "copy";
  /** 来源路径 */
  readonly path: string;
}

/**
 * 同路径更新的变化维度
 */
export interface VirtualDiffChanges {
  /** 条目种类是否变化 */
  readonly kindChanged: boolean;
  /** mode 是否变化 */
  readonly modeChanged: boolean;
  /** 内容哈希是否变化 */
  readonly contentChanged: boolean;
}

/**
 * 单条 diff 条目
 *
 * 仅描述最终状态，不表达完整会话内操作历史。
 */
export type VirtualDiffEntry =
  | {
      /** 新建路径 */
      readonly kind: "create";
      /** 当前路径 */
      readonly path: string;
      /** 当前对象 */
      readonly current: VirtualDiffObject;
      /** rename/copy 的来源 */
      readonly source?: VirtualDiffSource;
    }
  | {
      /** 删除路径 */
      readonly kind: "remove";
      /** 当前路径 */
      readonly path: string;
      /** 删除前对象 */
      readonly previous: VirtualDiffObject;
    }
  | {
      /** 同路径更新 */
      readonly kind: "update";
      /** 当前路径 */
      readonly path: string;
      /** 更新前对象 */
      readonly previous: VirtualDiffObject;
      /** 更新后对象 */
      readonly current: VirtualDiffObject;
      /** 变化维度 */
      readonly changes: VirtualDiffChanges;
      /** rename/copy 的来源 */
      readonly source?: VirtualDiffSource;
    };

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

  /** 创建目录（含必要父目录） */
  mkdir(path: string): void;

  /** 删除路径（文件、目录或符号链接） */
  delete(path: string): void;

  // ==================== 结构操作 ====================

  /**
   * 重命名路径
   *
   * 只做路径重绑定，不退化为 delete + write。
   * 目录重命名后，子项保持懒加载。
   */
  rename(from: string, to: string): void;

  /**
   * 复制路径
   *
   * 新建 workdir node，共享 origin，不共享 node 身份。
   * 目录复制为浅复制，子项保持懒加载。
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
   * 输出按路径稳定排序，仅包含文件与符号链接条目。
   */
  diff(): VirtualDiffEntry[];

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
