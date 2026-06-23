/**
 * repository/ops/push-operations.ts 单元测试
 */

import { describe, test, expect } from "bun:test";

import { createMemoryRepositoryBackend } from "@/backend/memory-backend.ts";
import { createPushRepositoryOperations, PushError } from "@/repository/ops/push-operations.ts";

describe("createPushRepositoryOperations()", () => {
  test("Push 操作应暴露 push 方法", () => {
    const backend = createMemoryRepositoryBackend();
    const ops = createPushRepositoryOperations(backend);
    expect(typeof ops.push).toBe("function");
  });

  test("PushError 应正确导出", () => {
    const err = new PushError("push rejected");
    expect(err.message).toBe("Push error: push rejected");
    expect(err.name).toBe("PushError");
  });

  test("push() 使用无效 URL 应抛出错误", async () => {
    const backend = createMemoryRepositoryBackend();
    const ops = createPushRepositoryOperations(backend);
    const promise = ops.push("https://invalid.url/nonexistent.git", { refSpecs: ["main:main"] });
    expect(promise).rejects.toThrow();
  });
});
