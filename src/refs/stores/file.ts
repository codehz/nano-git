/**
 * 基于文件系统的 Refs 存储
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { RefNotFoundError } from "../../core/errors.ts";
import type { RefStore } from "../types.ts";
import { validateRefName, validateRefPrefix } from "../names.ts";
import { listLooseRefsRecursive } from "../fs-utils.ts";

function readPackedRefs(gitDir: string): Map<string, string> {
  const packedRefsPath = join(gitDir, "packed-refs");
  if (!existsSync(packedRefsPath)) {
    return new Map<string, string>();
  }

  const packedRefs = new Map<string, string>();
  const lines = readFileSync(packedRefsPath, "utf-8").split("\n");

  for (const line of lines) {
    if (!line || line.startsWith("#") || line.startsWith("^")) {
      continue;
    }

    const spaceIndex = line.indexOf(" ");
    if (spaceIndex === -1) {
      continue;
    }

    const hash = line.slice(0, spaceIndex);
    const ref = line.slice(spaceIndex + 1);
    packedRefs.set(ref, hash);
  }

  return packedRefs;
}

/**
 * 创建基于文件系统的 Refs 存储
 *
 * @example
 * ```ts
 * const store = createFileRefStore("/path/to/repo/.git");
 * ```
 */
export function createFileRefStore(gitDir: string): RefStore {
  return {
    readRaw(ref: string): string | null {
      validateRefName(ref);
      const refPath = join(gitDir, ref);
      if (existsSync(refPath)) {
        return readFileSync(refPath, "utf-8").trimEnd();
      }

      return readPackedRefs(gitDir).get(ref) ?? null;
    },

    writeRaw(ref: string, content: string): void {
      validateRefName(ref);
      const refPath = join(gitDir, ref);
      mkdirSync(dirname(refPath), { recursive: true });
      writeFileSync(refPath, `${content.trimEnd()}\n`);
    },

    deleteRaw(ref: string): void {
      validateRefName(ref);
      const refPath = join(gitDir, ref);
      if (!existsSync(refPath)) {
        throw new RefNotFoundError(ref);
      }

      unlinkSync(refPath);
    },

    listRaw(prefix: string): string[] {
      validateRefPrefix(prefix);
      const baseDir = join(gitDir, prefix);
      const refs = new Set<string>();

      if (existsSync(baseDir)) {
        for (const ref of listLooseRefsRecursive(baseDir, prefix)) {
          refs.add(ref);
        }
      }

      for (const ref of readPackedRefs(gitDir).keys()) {
        if (ref.startsWith(prefix)) {
          refs.add(ref);
        }
      }

      return Array.from(refs).sort();
    },
  };
}
