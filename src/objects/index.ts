/**
 * Git 对象序列化/反序列化
 *
 * 仅负责聚合各对象子模块与对象编解码入口。
 */

// 重新导出各子模块
export { serializeBlob, deserializeBlob } from "./blob.ts";
export { serializeTree, deserializeTree } from "./tree.ts";
export { serializeCommit, deserializeCommit } from "./commit.ts";
export { serializeTag, deserializeTag } from "./tag.ts";
export { formatAuthor, parseAuthor } from "./author.ts";
export { serialize, deserialize, serializeContent, deserializeContent } from "./codec.ts";

// 语义层 raw 转换 helper
export { encodeObject, decodeObject, writeObject, readObject, tryReadObject } from "./raw.ts";
