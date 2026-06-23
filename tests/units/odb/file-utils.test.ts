/**
 * odb/file-utils.ts 单元测试
 *
 * 测试 loose object 文件系统辅助函数
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { sha1, type GitBlob } from "@/core/types.ts";
import { serialize } from "@/objects/index.ts";
import {
  getLooseObjectPath,
  hasLooseObject,
  writeLooseObject,
  readLooseObject,
  deleteLooseObject,
  listLooseObjects,
} from "@/odb/file-utils.ts";

describe("getLooseObjectPath()", () => {
  test("应返回正确的对象路径", () => {
    const hash = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
    const path = getLooseObjectPath("/repo/objects", hash);
    expect(path).toBe("/repo/objects/95/d09f2b10159347eece71399a7e2e907ea3df4f");
  });
});

describe("loose object 文件操作", () => {
  let objectsDir: string;

  beforeEach(() => {
    objectsDir = join(tmpdir(), `nano-git-obj-${Date.now()}-${Math.random()}`);
    mkdirSync(objectsDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(objectsDir)) {
      rmSync(objectsDir, { recursive: true, force: true });
    }
  });

  const blob: GitBlob = {
    type: "blob",
    content: Buffer.from("hello world"),
  };
  const blobHash = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");

  test("writeLooseObject() 写入文件", () => {
    writeLooseObject(objectsDir, blobHash, blob);

    const expectedPath = join(objectsDir, "95", "d09f2b10159347eece71399a7e2e907ea3df4f");
    expect(existsSync(expectedPath)).toBe(true);

    // 验证内容是压缩的序列化数据
    const raw = readFileSync(expectedPath);
    const expectedRaw = deflateSync(serialize(blob));
    expect(raw.equals(expectedRaw)).toBe(true);
  });

  test("hasLooseObject() 检查存在性", () => {
    expect(hasLooseObject(objectsDir, blobHash)).toBe(false);
    writeLooseObject(objectsDir, blobHash, blob);
    expect(hasLooseObject(objectsDir, blobHash)).toBe(true);
  });

  test("readLooseObject() 读取对象", () => {
    writeLooseObject(objectsDir, blobHash, blob);
    const obj = readLooseObject(objectsDir, blobHash);
    expect(obj.type).toBe("blob");
    if (obj.type === "blob") {
      expect(obj.content.toString()).toBe("hello world");
    }
  });

  test("readLooseObject() 不存在的对象抛出异常", () => {
    const missingHash = sha1("0000000000000000000000000000000000000000");
    expect(() => readLooseObject(objectsDir, missingHash)).toThrow("Object not found");
  });

  test("deleteLooseObject() 删除已有对象", () => {
    writeLooseObject(objectsDir, blobHash, blob);
    deleteLooseObject(objectsDir, blobHash);
    expect(hasLooseObject(objectsDir, blobHash)).toBe(false);
  });

  test("deleteLooseObject() 删除不存在的对象静默成功", () => {
    const missingHash = sha1("1111111111111111111111111111111111111111");
    expect(() => deleteLooseObject(objectsDir, missingHash)).not.toThrow();
  });

  test("write-read 往返一致性", () => {
    writeLooseObject(objectsDir, blobHash, blob);
    const readBack = readLooseObject(objectsDir, blobHash);
    expect(readBack).toEqual(blob);
  });

  test("listLooseObjects() 空目录返回空数组", () => {
    expect(listLooseObjects(objectsDir)).toEqual([]);
  });

  test("listLooseObjects() 列出所有对象", () => {
    writeLooseObject(objectsDir, blobHash, blob);

    const hash2 = sha1("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    const emptyBlob: GitBlob = { type: "blob", content: Buffer.from("") };
    writeLooseObject(objectsDir, hash2, emptyBlob);

    const hashes = listLooseObjects(objectsDir);
    expect(hashes.sort()).toEqual([blobHash, hash2].sort());
  });

  test("listLooseObjects() 跳过 pack 和 info 目录", () => {
    writeLooseObject(objectsDir, blobHash, blob);
    mkdirSync(join(objectsDir, "pack"), { recursive: true });
    mkdirSync(join(objectsDir, "info"), { recursive: true });

    const hashes = listLooseObjects(objectsDir);
    expect(hashes).toHaveLength(1);
    expect(hashes[0]).toBe(blobHash);
  });

  test("listLooseObjects() 不存在的目录返回空数组", () => {
    const badDir = join(objectsDir, "nonexistent");
    expect(listLooseObjects(badDir)).toEqual([]);
  });
});
