/**
 * @deprecated 已由 contract/read-write.test.ts 覆盖
 *
 * 保留本文件仅用于验证单后端特化行为。
 */
import { describe, test, expect } from "bun:test";

import { VirtualPathNotFoundError } from "@/core/errors.ts";
import { createMemoryRepository } from "@/repository/memory.ts";
import { createVirtualWorkdir } from "@/workdir/workdir.ts";

describe("createVirtualWorkdir() 只读", () => {
  test("路径不存在时 readFile 抛 VirtualPathNotFoundError", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });
    expect(() => session.readFile("nope")).toThrow(VirtualPathNotFoundError);
  });
});
