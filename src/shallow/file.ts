/**
 * 基于文件系统的 Shallow 存储
 *
 * 读写 .git/shallow 文件。
 * 格式：每行一个 40 字符 SHA1 哈希。
 *
 * @example
 * ```ts
 * const store = createFileShallowStore("/path/to/repo/.git");
 * ```
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sha1 } from "../core/types.ts";

import type { SHA1 } from "../core/types.ts";
import type { ShallowStore, ShallowUpdate } from "./types.ts";

/**
 * 创建基于文件系统的 Shallow 存储
 *
 * @param gitDir - .git 目录的路径
 *
 * @example
 * ```ts
 * const store = createFileShallowStore("/repo/.git");
 * console.log(store.read());
 * ```
 */
export function createFileShallowStore(gitDir: string): ShallowStore {
  const shallowFilePath = join(gitDir, "shallow");

  function readFromFile(): SHA1[] {
    if (!existsSync(shallowFilePath)) {
      return [];
    }

    const content = readFileSync(shallowFilePath, "utf8").trim();
    if (content.length === 0) {
      return [];
    }

    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((hash) => sha1(hash));
  }

  function writeToFile(boundaries: SHA1[]): void {
    if (boundaries.length === 0) {
      if (existsSync(shallowFilePath)) {
        unlinkSync(shallowFilePath);
      }
      return;
    }

    // 排序后写入，保证文件内容确定性
    const sorted = [...boundaries].sort();
    writeFileSync(shallowFilePath, sorted.join("\n") + "\n");
  }

  return {
    read(): SHA1[] {
      return readFromFile();
    },

    write(boundaries: SHA1[]): void {
      writeToFile(boundaries);
    },

    applyUpdate(update: ShallowUpdate): void {
      const current = new Set(readFromFile());

      for (const hash of update.unshallow) {
        current.delete(hash);
      }

      for (const hash of update.shallow) {
        current.add(hash);
      }

      writeToFile(Array.from(current));
    },

    isShallow(hash: SHA1): boolean {
      const boundaries = readFromFile();
      return boundaries.includes(hash);
    },
  };
}
