/**
 * Refs 存储接口定义
 *
 * 提供 Git 引用（refs）的持久化存储能力。
 * 所有存储实现（文件系统、内存等）都遵循此接口。
 *
 * 此接口只做原始读写，不包含符号引用解析逻辑（解析逻辑在 utils.ts 中）。
 *
 * 扩展点：添加新存储后端时，只需实现此接口即可无缝集成。
 */

/** HEAD 引用名称 */
export const HEAD_REF = "HEAD";

/** 分支引用前缀 */
export const HEADS_PREFIX = "refs/heads/";

/** 标签引用前缀 */
export const TAGS_PREFIX = "refs/tags/";

/**
 * Refs 存储接口
 *
 * 提供 Git 引用的原始读写能力。
 */
export interface RefStore {
  /**
   * 读取引用原始内容
   *
   * 返回去掉末尾换行后的引用内容，
   * 可能包含 "ref: refs/heads/main" 这样的符号引用，
   * 也可能直接是 SHA-1 哈希值。
   *
   * @param ref - 完整引用路径，如 "refs/heads/main"
   * @returns 引用内容，不存在时返回 null
   */
  read(ref: string): string | null;

  /**
   * 写入引用
   *
   * @param ref - 完整引用路径
   * @param content - 引用内容（末尾换行会被自动规范化）
   */
  write(ref: string, content: string): void;

  /**
   * 删除引用
   *
   * @param ref - 完整引用路径
   * @throws 如果引用不存在
   */
  delete(ref: string): void;

  /**
   * 列出指定前缀下的所有引用
   *
   * @param prefix - 引用前缀，如 "refs/heads/"
   * @returns 完整的引用路径列表（已排序）
   */
  list(prefix: string): string[];

  /**
   * 列出所有引用（不限命名空间）
   *
   * 返回 refs/ 下的所有引用完整路径。
   * 此方法不做前缀校验，适用于需要扫描全部 refs 的场景。
   *
   * @returns 所有引用的完整路径列表（已排序）
   */
  listAll(): string[];

  /**
   * 开启一个新的事务
   *
   * 事务中所有变更独立于事务外操作。
   * 未提交的事务在调用 rollback() 或 GC 时丢弃。
   *
   * @param hooks - 可选的事务生命周期钩子
   */
  beginTransaction(hooks?: RefTransactionHook[]): RefTransaction;
}

/**
 * Reference Transaction
 *
 * 提供批量 ref 更新的原子性语义。
 * 所有变更暂存于内部缓冲区，commit() 时一次性应用。
 */
export interface RefTransaction {
  /** 当前事务中暂存的变更数（write + delete） */
  readonly pendingCount: number;

  /**
   * 暂存写入操作
   *
   * 不会立即写入存储，只记录 pending 变更。
   * 事务内对同一 ref 多次 write 以最后一次为准。
   */
  write(ref: string, content: string): void;

  /**
   * 暂存删除操作
   *
   * 不会立即删除，只记录 pending 变更。
   * write + delete 同一 ref 以最后一次操作为准。
   */
  delete(ref: string): void;

  /**
   * 提交事务，原子性应用所有变更
   *
   * 提交顺序：先 apply 所有 write，再 apply 所有 delete。
   * 失败时整体回滚，不留下部分变更。
   *
   * @throws 如果任意写入失败，事务自动回滚并抛出异常
   */
  commit(): void;

  /**
   * 回滚事务，丢弃所有 pending 变更
   *
   * 恢复至 beginTransaction() 时的状态。
   * 多次调用或 commit 后调用无副作用。
   */
  rollback(): void;
}

/**
 * 事务的只读快照，用于 Hook 回调
 */
export interface ReadonlyRefTransaction {
  readonly pendingCount: number;
  readonly writes: ReadonlyArray<{ readonly ref: string; readonly content: string }>;
  readonly deletes: ReadonlyArray<{ readonly ref: string }>;
}

/**
 * Reference Transaction Hook
 *
 * 类似 Git reference-transaction hook，
 * 在事务生命周期三个阶段触发回调。
 */
export interface RefTransactionHook {
  /**
   * 提交前准备阶段
   *
   * commit() 进行实际写入前调用。
   * 抛异常可中止本次提交，事务自动回滚。
   */
  onPrepare?(tx: ReadonlyRefTransaction): void;

  /**
   * 提交成功
   *
   * 所有变更已持久化后调用。
   */
  onCommitted?(tx: ReadonlyRefTransaction): void;

  /**
   * 提交中止
   *
   * 事务被回滚后调用（含显式 rollback() 和 commit() 内失败自动回滚）。
   */
  onAborted?(tx: ReadonlyRefTransaction): void;
}
