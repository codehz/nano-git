/**
 * Refs 类型定义
 *
 * 公共接口已移至 core/types/refs.ts，
 * 此文件保留仅用于内部使用和向后兼容。
 */

export { HEAD_REF, HEADS_PREFIX, TAGS_PREFIX } from "../core/types/refs.ts";

export type {
  RefStore,
  RefTransaction,
  ReadonlyRefTransaction,
  RefTransactionHook,
} from "../core/types/refs.ts";
