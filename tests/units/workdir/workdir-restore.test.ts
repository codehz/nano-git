/**
 * workdir/workdir.ts restore 操作单元测试
 */
import { describe, expect, test } from "bun:test";

import { VirtualPathNotFoundError } from "@/core/errors.ts";
import { createMemoryRepository } from "@/repository/memory.ts";
import { createVirtualWorkdir } from "@/workdir/workdir.ts";

describe("restore", () => {
  test("未启用 force 时，恢复基线不存在的路径报错且不删除当前文件", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, { baseTree: repo.createTree([]) });

    session.writeFile("temp.txt", Buffer.from("temp"));

    expect(() => session.restore("temp.txt")).toThrow(VirtualPathNotFoundError);
    expect(session.readFile("temp.txt").toString()).toBe("temp");
  });
});
