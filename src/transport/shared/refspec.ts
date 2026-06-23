/**
 * RefSpec 解析与转换（共享模块）
 *
 * 从源位置重新导出。
 */
export {
  parseRefSpec,
  mappingRuleToParsedSpec,
  parsedSpecToMappingRule,
  RefSpecError,
} from "../refspec.ts";
export type { ParsedRefSpec } from "../refspec.ts";
