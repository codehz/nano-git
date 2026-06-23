/**
 * repository/ops/fetch-operations.ts 单元测试
 */

import { describe, test, expect } from "bun:test";

import { createMemoryRepositoryBackend } from "@/backend/memory-backend.ts";
import { createFetchRepositoryOperations } from "@/repository/ops/fetch-operations.ts";

describe("createFetchRepositoryOperations()", () => {
  test("Fetch 操作应暴露 fetch 方法", () => {
    const backend = createMemoryRepositoryBackend();
    const ops = createFetchRepositoryOperations(backend);
    expect(typeof ops.fetch).toBe("function");
  });

  test("fetch() 使用无效 URL 应抛出错误", async () => {
    const backend = createMemoryRepositoryBackend();
    const ops = createFetchRepositoryOperations(backend);
    const promise = ops.fetch("https://invalid.url/nonexistent.git");
    expect(promise).rejects.toThrow();
  });
});
