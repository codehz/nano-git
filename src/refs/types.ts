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
}
