/**
 * Virtual Workdir 公开类型、接口与错误
 *
 * 本文件是 `nano-git/workdir/core` 子路径的唯一入口，
 * 包含 VirtualWorkdirSession 的公开 API 边界定义。
 *
 * 约定：
 * - 本文件只放公开边界定义（接口、类型、re-export 的错误类）
 * - 实现逻辑放在同目录下其他模块中
 * - 所有实现模块通过工厂函数模式组装
 */

import type { SHA1 } from "../core/types.ts";
import type { ObjectDatabase } from "../core/types/odb.ts";

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

// ==================== 变更记录类型 ====================

/**
 * 变更操作类型
 *
 * 用于 `listChanges()` 返回的变更记录。
 */
export type VirtualChangeType = "add" | "modify" | "delete" | "rename" | "copy";

/**
 * 单条变更记录
 *
 * 由 `listChanges()` 返回，描述 session 内的单次操作。
 * 变更记录是会话内调试/测试辅助，不保证是最小 diff。
 */
export interface VirtualChange {
  /** 操作路径 */
  readonly path: string;
  /** 变更操作类型 */
  readonly type: VirtualChangeType;
  /** rename/copy 操作的源路径（其他操作为 undefined） */
  readonly oldPath?: string;
}

// ==================== Session 工厂选项 ====================

/**
 * 创建 VirtualWorkdirSession 的选项
 */
export interface CreateVirtualWorkdirSessionOptions {
  /** 基线 tree 的 SHA-1 哈希 */
  readonly baseTree: SHA1;
}

/**
 * Virtual Workdir session 标识
 */
export type VirtualWorkdirSessionId = string & { readonly __brand: "VirtualWorkdirSessionId" };

// ==================== Session 公共接口 ====================

/**
 * VirtualWorkdirSession（虚拟工作目录会话）
 *
 * 提供独立生命周期的可变 tree 视图，基于 `baseTree + CoW overlay` 模型。
 * 不绑定 commit，不涉及 Git index / 真实工作目录。
 *
 * 当前 session 对 origin 仓库对象采用弱保证：
 * 如果 base tree / origin blob 在后续被移除、损坏或不可读取，
 * 相关读取、`revert()`、`writeTree()` 等操作会抛出 `VirtualOriginUnavailableError`。
 *
 * @example
 * ```ts
 * import { createMemoryRepository } from "nano-git/repository/memory";
 * import { createVirtualWorkdirSession } from "nano-git/workdir/memory";
 *
 * const repo = createMemoryRepository();
 * const tree = repo.writeTree(); // 初始空 tree
 * const session = createVirtualWorkdirSession(repo, { baseTree: tree });
 *
 * session.writeFile("hello.txt", Buffer.from("world"));
 * const newTree = session.writeTree();
 * ```
 */
export interface VirtualWorkdirSession {
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
   * 新建 session node，共享 origin，不共享 node 身份。
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
   * 导出当前 overlay 为新 tree
   *
   * 只重新合成受影响目录，复用未修改节点的哈希。
   * 不自动推进 baseTree。
   */
  writeTree(): SHA1;

  /**
   * 重置 session 到指定基线 tree
   *
   * 丢弃全部 overlay 与变更历史。
   */
  reset(baseTree: SHA1): void;

  // ==================== 变更观察 ====================

  /**
   * 列出会话内的变更记录
   *
   * 是会话内调试/测试辅助，不保证是最小 diff 引擎。
   * 输出稳定、测试可断言即可。
   */
  listChanges(): VirtualChange[];
}

// ==================== 后端抽象接口 ====================

/**
 * VirtualWorkdirBackend
 *
 * session 内部状态存储的抽象接口。
 * memory / file / sqlite 后端通过实现此接口来提供不同的持久化策略。
 *
 * `file` / `sqlite` 持久化 backend 当前都按单进程、单写者场景收口；
 * 不承诺跨进程并发写安全，也不提供多写者协调协议。
 *
 * 本接口在后续 Phase 中会逐步补充完整方法签名。
 * 当前仅为命名冻结与角色声明。
 */
export interface VirtualWorkdirBackend {
  /** 后端类型标识 */
  readonly kind: "memory" | "file" | "sqlite";

  /** 创建新 session 并返回其标识 */
  createSession(options: CreateVirtualWorkdirSessionOptions): VirtualWorkdirSessionId;

  /** 打开已存在的 session */
  openSession(source: ObjectDatabase, sessionId: VirtualWorkdirSessionId): VirtualWorkdirSession;

  /** 删除 session */
  deleteSession(sessionId: VirtualWorkdirSessionId): void;

  /** 列出当前后端中可完整恢复的 session */
  listSessions(): VirtualWorkdirSessionId[];
}
