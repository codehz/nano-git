/**
 * 文件 manifest 中的节点线格式
 */

import type { PersistedChangeRecord } from "./change-codec.ts";
import type { PersistedNodeOriginRecord } from "./origin-codec.ts";

/** 文件 manifest 节点记录 */
export interface PersistedFileNodeRecord {
  readonly id: string;
  readonly origin: PersistedNodeOriginRecord;
  readonly state:
    | {
        readonly kind: "directory";
        readonly overlay: {
          readonly addedEntries: Array<[string, string]>;
          readonly deletedNames: string[];
        };
      }
    | {
        readonly kind: "file";
        readonly mode: "100644" | "100755";
        readonly contentRef: string | null;
      }
    | {
        readonly kind: "symlink";
        readonly mode: "120000";
        readonly targetRef: string | null;
      };
}

/** 文件 manifest 根结构 */
export interface FileWorktreeManifest {
  readonly formatVersion: number;
  readonly baseTree: string;
  readonly nodes: Readonly<Record<string, PersistedFileNodeRecord>>;
  readonly changeRecords: readonly PersistedChangeRecord[];
}
