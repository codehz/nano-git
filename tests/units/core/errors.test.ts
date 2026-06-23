/**
 * core/errors.ts 单元测试
 *
 * 验证所有错误类的实例化、继承链和自定义属性
 */

import { describe, test, expect } from "bun:test";

import {
  GitError,
  ObjectNotFoundError,
  InvalidObjectError,
  InvalidSHA1Error,
  RepositoryError,
  CircularReferenceError,
  RefNotFoundError,
  PackError,
  InvalidPackError,
  PackIndexError,
  DeltaError,
  TransactionError,
  PreconditionCheckError,
} from "@/core/errors.ts";

describe("GitError 基类", () => {
  test("应继承 Error", () => {
    const err = new GitError("test");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(GitError);
    expect(err.name).toBe("GitError");
    expect(err.message).toBe("test");
  });
});

describe("ObjectNotFoundError", () => {
  test("应包含 hash 属性", () => {
    const hash = "95d09f2b10159347eece71399a7e2e907ea3df4f";
    const err = new ObjectNotFoundError(hash);
    expect(err).toBeInstanceOf(GitError);
    expect(err.name).toBe("ObjectNotFoundError");
    expect(err.hash).toBe(hash);
    expect(err.message).toBe(`Object not found: ${hash}`);
  });

  test("应支持自定义消息", () => {
    const err = new ObjectNotFoundError("abc123", "Custom message");
    expect(err.message).toBe("Custom message");
    expect(err.hash).toBe("abc123");
  });
});

describe("InvalidObjectError", () => {
  test("应包含前缀消息", () => {
    const err = new InvalidObjectError("bad format");
    expect(err).toBeInstanceOf(GitError);
    expect(err.name).toBe("InvalidObjectError");
    expect(err.message).toBe("Invalid Git object: bad format");
  });
});

describe("InvalidSHA1Error", () => {
  test("应包含 value 属性", () => {
    const err = new InvalidSHA1Error("abc");
    expect(err).toBeInstanceOf(GitError);
    expect(err.name).toBe("InvalidSHA1Error");
    expect(err.value).toBe("abc");
    expect(err.message).toBe("Invalid SHA-1 hash: abc");
  });
});

describe("RepositoryError", () => {
  test("基本仓库错误", () => {
    const err = new RepositoryError("repo error");
    expect(err).toBeInstanceOf(GitError);
    expect(err.name).toBe("RepositoryError");
    expect(err.message).toBe("repo error");
  });
});

describe("CircularReferenceError", () => {
  test("应包含 ref 属性", () => {
    const err = new CircularReferenceError("refs/heads/a");
    expect(err).toBeInstanceOf(GitError);
    expect(err.name).toBe("CircularReferenceError");
    expect(err.ref).toBe("refs/heads/a");
    expect(err.message).toBe("Circular reference detected: refs/heads/a");
  });
});

describe("RefNotFoundError", () => {
  test("应包含 ref 属性", () => {
    const err = new RefNotFoundError("refs/heads/main");
    expect(err).toBeInstanceOf(GitError);
    expect(err.name).toBe("RefNotFoundError");
    expect(err.ref).toBe("refs/heads/main");
    expect(err.message).toBe("Reference not found: refs/heads/main");
  });
});

describe("PackError 体系", () => {
  test("PackError 基类", () => {
    const err = new PackError("corrupt pack");
    expect(err).toBeInstanceOf(GitError);
    expect(err).toBeInstanceOf(PackError);
    expect(err.name).toBe("PackError");
    expect(err.message).toBe("Packfile error: corrupt pack");
  });

  test("InvalidPackError 继承 PackError", () => {
    const err = new InvalidPackError("bad header");
    expect(err).toBeInstanceOf(PackError);
    expect(err).toBeInstanceOf(GitError);
    expect(err.name).toBe("InvalidPackError");
    expect(err.message).toContain("Invalid packfile");
  });

  test("PackIndexError 继承 PackError", () => {
    const err = new PackIndexError("bad index");
    expect(err).toBeInstanceOf(PackError);
    expect(err).toBeInstanceOf(GitError);
    expect(err.name).toBe("PackIndexError");
    expect(err.message).toContain("Pack index error");
  });

  test("DeltaError 继承 GitError", () => {
    const err = new DeltaError("bad delta");
    expect(err).toBeInstanceOf(GitError);
    expect(err.name).toBe("DeltaError");
  });
});

describe("TransactionError", () => {
  test("包含 message", () => {
    const err = new TransactionError("transaction failed");
    expect(err).toBeInstanceOf(GitError);
    expect(err.name).toBe("TransactionError");
  });
});

describe("PreconditionCheckError", () => {
  test("包含 message", () => {
    const err = new PreconditionCheckError("ref mismatch");
    expect(err).toBeInstanceOf(GitError);
    expect(err.name).toBe("PreconditionCheckError");
  });
});
