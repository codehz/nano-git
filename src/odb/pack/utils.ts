/**
 * Packfile 工具函数模块
 *
 * 拆分通用 varint、对象头部与 ofs_delta 偏移量编码工具。
 */

export { decodeObjectHeader, encodeObjectHeader } from "./object-header.ts";
export { decodeOfsDeltaOffset, encodeOfsDeltaOffset } from "./ofs-delta-offset.ts";
export { decodeVarint, encodeVarint } from "./varint.ts";
