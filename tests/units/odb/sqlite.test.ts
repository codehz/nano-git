/**
 * SQLite 对象存储特有行为测试
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";

import { acquireConnection } from "@/backend/sqlite-pool.ts";
import { ObjectNotFoundError } from "@/core/errors.ts";
import { sha1 } from "@/core/types.ts";
import { encodeObject, writeObject } from "@/objects/raw.ts";
import { createSqliteObjectStore } from "@/odb/sqlite.ts";

import type { RawGitObject } from "@/core/types.ts";

describe("createSqliteObjectStore()", () => {
  let conn: ReturnType<typeof acquireConnection>;
  let store: ReturnType<typeof createSqliteObjectStore>;

  beforeEach(() => {
    conn = acquireConnection(":memory:");
    conn.db.run(
      "CREATE TABLE IF NOT EXISTS objects (hash TEXT PRIMARY KEY, type TEXT NOT NULL, content BLOB NOT NULL)",
    );
    store = createSqliteObjectStore(conn);
  });

  afterEach(() => {
    conn.release();
  });

  test("读取不存在的对象应抛出 ObjectNotFoundError", () => {
    const fakeHash = sha1("0000000000000000000000000000000000000000");
    expect(() => store.read(fakeHash)).toThrow(ObjectNotFoundError);
    expect(() => store.read(fakeHash)).toThrow("Object not found");
  });

  test("ingestMany 原子性：中途出错时全部回滚", () => {
    const validRaw: RawGitObject = {
      hash: sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"),
      type: "blob",
      content: Buffer.from("hello world"),
    };
    // hash 与内容不匹配的对象，应触发校验失败
    const invalidRaw: RawGitObject = {
      hash: sha1("0000000000000000000000000000000000000000"),
      type: "blob",
      content: Buffer.from("mismatched content"),
    };

    expect(() => store.ingestMany([validRaw, invalidRaw])).toThrow("hash mismatch");
    // 原子性：第一个对象也不应该被写入
    expect(store.list()).toHaveLength(0);
  });

  test("大数据量：ingest 1000 个对象 + list 完整性", () => {
    const raws: RawGitObject[] = [];
    for (let i = 0; i < 1000; i++) {
      raws.push(encodeObject({ type: "blob", content: Buffer.from(`large-data-${i}`) }));
    }

    store.ingestMany(raws);

    const list = store.list();
    expect(list).toHaveLength(1000);

    // 验证所有对象可按 hash 读取
    for (const raw of raws) {
      expect(store.exists(raw.hash)).toBe(true);
      const read = store.read(raw.hash);
      expect(read.type).toBe("blob");
      // 验证内容是期望的
      expect(read.content).toEqual(raw.content);
    }
  });

  test("SQLite 可与 writeObject 互操作", () => {
    const hash = writeObject(store, {
      type: "blob",
      content: Buffer.from("sqlite-write-object"),
    });

    expect(store.exists(hash)).toBe(true);
  });
});
