/**
 * Blob 端到端兼容性测试
 *
 * nano-git 与标准 Git 的 Blob 对象双向兼容性验证。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";

import { bytes, bytesToUtf8, toUint8Array, utf8ToBytes } from "../helpers/bytes.ts";
import {
  gitInitBare,
  gitHashObjectWrite,
  gitHashObject,
  gitCatFileType,
  gitCatFileSize,
  gitCatFileRaw,
  createTempDir,
  cleanupDir,
} from "./helpers.ts";
import { openRepository } from "@/repository/file.ts";
import { sha1 } from "@/types/index.ts";

describe("Blob 兼容性", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir("e2e-blob");
    gitInitBare(tempDir);
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  // --- nano-git → git ---

  describe("nano-git → git", () => {
    test("nano-git 写入的 blob 能被 git cat-file 读取", () => {
      const repo = openRepository(tempDir);
      const content = "hello world from nano-git";
      const hash = repo.writeBlob(bytes(content));

      expect(gitCatFileType(tempDir, hash)).toBe("blob");
      expect(gitCatFileSize(tempDir, hash)).toBe(utf8ToBytes(content).length);

      const rawContent = gitCatFileRaw(tempDir, hash);
      expect(bytesToUtf8(rawContent)).toBe(content);
    });

    test("nano-git 和 git 对相同内容产生相同的哈希", () => {
      const repo = openRepository(tempDir);
      const content = "identical content test";

      const nanoGitHash = repo.hashObject(bytes(content));
      const gitHash = gitHashObject(tempDir, content);

      expect(nanoGitHash).toBe(gitHash);
    });

    test("nano-git 写入的二进制 blob 能被 git 正确读取", () => {
      const repo = openRepository(tempDir);
      const binaryContent = Uint8Array.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x7f, 0x42, 0x13]);
      const hash = repo.writeBlob(binaryContent);

      const rawContent = gitCatFileRaw(tempDir, hash);
      expect(rawContent).toEqual(binaryContent);
    });

    test("nano-git 写入的空 blob 能被 git 正确读取", () => {
      const repo = openRepository(tempDir);
      const hash = repo.writeBlob(bytes(""));

      expect(gitCatFileType(tempDir, hash)).toBe("blob");
      expect(gitCatFileSize(tempDir, hash)).toBe(0);
    });

    test("nano-git 写入的中文内容能被 git 正确读取", () => {
      const repo = openRepository(tempDir);
      const content = "你好世界 🌍 こんにちは";
      const hash = repo.writeBlob(bytes(content));

      const rawContent = gitCatFileRaw(tempDir, hash);
      expect(bytesToUtf8(rawContent)).toBe(content);
    });
  });

  // --- git → nano-git ---

  describe("git → nano-git", () => {
    test("git 写入的 blob 能被 nano-git 读取", () => {
      const repo = openRepository(tempDir);
      const content = "hello from git CLI";
      const hash = gitHashObjectWrite(tempDir, content);

      const obj = repo.catFile(sha1(hash));
      expect(obj.type).toBe("blob");
      if (obj.type === "blob") {
        expect(bytesToUtf8(obj.content)).toBe(content);
      }
    });

    test("git 写入的二进制 blob 能被 nano-git 正确读取", () => {
      const repo = openRepository(tempDir);
      const binaryContent = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x42]);
      const hash = gitHashObjectWrite(tempDir, binaryContent);

      const obj = repo.catFile(sha1(hash));
      expect(obj.type).toBe("blob");
      if (obj.type === "blob") {
        expect(obj.content).toEqual(binaryContent);
      }
    });
  });
});
