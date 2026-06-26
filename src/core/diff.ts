/**
 * 通用 diff 结果类型
 *
 * 作为 repo tree diff 与 workdir diff 的共享语言层。
 * 当前描述的是“路径最终状态差异”，而非完整操作历史。
 */

import type { SHA1 } from "./types.ts";

/**
 * diff 对象种类
 */
export type DiffObjectKind = "blob" | "tree" | "symlink";

/**
 * diff 对象 mode
 */
export type DiffObjectMode = "100644" | "100755" | "040000" | "120000";

/**
 * diff 中的对象描述
 */
export interface DiffObject {
  /** 条目种类 */
  readonly kind: DiffObjectKind;
  /** Git 文件模式 */
  readonly mode: DiffObjectMode;
  /** 对象哈希 */
  readonly hash: SHA1;
}

/**
 * move/copy 来源描述
 */
export interface DiffSource {
  /** 来源类型 */
  readonly kind: "move" | "copy";
  /** 来源路径 */
  readonly path: string;
}

/**
 * 同路径更新的变化维度
 */
export interface DiffChanges {
  /** 条目种类是否变化 */
  readonly kindChanged: boolean;
  /** mode 是否变化 */
  readonly modeChanged: boolean;
  /** 内容哈希是否变化 */
  readonly contentChanged: boolean;
}

/**
 * 单条 diff 条目
 */
export type DiffEntry =
  | {
      /** 新建路径 */
      readonly kind: "create";
      /** 当前路径 */
      readonly path: string;
      /** 当前对象 */
      readonly current: DiffObject;
      /** move/copy 的来源 */
      readonly source?: DiffSource;
    }
  | {
      /** 删除路径 */
      readonly kind: "remove";
      /** 当前路径 */
      readonly path: string;
      /** 删除前对象 */
      readonly previous: DiffObject;
    }
  | {
      /** 同路径更新 */
      readonly kind: "update";
      /** 当前路径 */
      readonly path: string;
      /** 更新前对象 */
      readonly previous: DiffObject;
      /** 更新后对象 */
      readonly current: DiffObject;
      /** 变化维度 */
      readonly changes: DiffChanges;
      /** move/copy 的来源 */
      readonly source?: DiffSource;
    };
