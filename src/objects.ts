/**
 * Git 对象序列化/反序列化入口
 *
 * @example
 * ```ts
 * import { serialize, deserialize } from "nano-git/objects";
 * ```
 */

export {
  serialize,
  deserialize,
  serializeContent,
  deserializeContent,
  serializeBlob,
  deserializeBlob,
  serializeTree,
  deserializeTree,
  serializeCommit,
  deserializeCommit,
  serializeTag,
  deserializeTag,
  formatAuthor,
  parseAuthor,
} from "./objects/index.ts";
