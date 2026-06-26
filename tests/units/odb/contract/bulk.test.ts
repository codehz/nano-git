/**
 * ODB 合同测试：批量对象完整性
 */
import { describe, expect, test } from "bun:test";

import { objectDatabaseBackends } from "./contract.ts";
import { encodeObject } from "@/objects/raw.ts";

describe("ObjectDatabase contract: bulk", () => {
  describe.each(objectDatabaseBackends)("$name", ({ createStore }) => {
    test("批量写入后可完整列出并读取所有对象", () => {
      using session = createStore();
      const { store } = session;

      const raws = Array.from({ length: 256 }, (_, index) =>
        encodeObject({ type: "blob", content: Buffer.from(`large-data-${index}`) }),
      );

      store.ingestMany(raws);

      const list = store.list();
      expect(list).toHaveLength(raws.length);

      for (const raw of raws) {
        expect(list).toContain(raw.hash);
        expect(store.exists(raw.hash)).toBe(true);
        expect(store.read(raw.hash)).toEqual(raw);
      }
    });
  });
});
