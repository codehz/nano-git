/**
 * workdir/change-log.ts 单元测试
 */
import { describe, test, expect } from "bun:test";

import { createVirtualChangeLog } from "@/workdir/change-log.ts";

describe("createVirtualChangeLog()", () => {
  test("追加并映射为 VirtualChange", () => {
    const log = createVirtualChangeLog();
    log.append({ op: "add", path: "a.txt" });
    log.append({ op: "rename", from: "a.txt", to: "b.txt" });
    log.append({ op: "revert", path: "b.txt" });

    expect(log.toVirtualChanges()).toEqual([
      { path: "a.txt", type: "add" },
      { path: "b.txt", type: "rename", oldPath: "a.txt" },
    ]);
  });

  test("clear 清空记录", () => {
    const log = createVirtualChangeLog();
    log.append({ op: "delete", path: "x" });
    log.clear();
    expect(log.snapshot()).toEqual([]);
    expect(log.toVirtualChanges()).toEqual([]);
  });
});
