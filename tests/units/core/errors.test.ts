/**
 * errors.ts 单元测试
 *
 * 验证所有错误类的实例化、继承链、固定字段与 cause/details。
 */

import { describe, test, expect } from "bun:test";

import {
  GitError,
  ObjectNotFoundError,
  InvalidObjectError,
  ObjectHashMismatchError,
  InvalidSHA1Error,
  RepositoryError,
  ImportError,
  TreeError,
  CircularReferenceError,
  RefNotFoundError,
  PackError,
  InvalidPackError,
  PackIndexError,
  DeltaError,
  TransactionError,
  PreconditionCheckError,
  VirtualPathNotFoundError,
  VirtualWorktreeError,
} from "@/errors.ts";

describe("GitError 基类", () => {
  test("应继承 Error", () => {
    const err = new GitError("test");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(GitError);
    expect(err.name).toBe("GitError");
    expect(err.message).toBe("test");
  });

  test("应支持 cause 与 details", () => {
    const cause = new Error("root");
    const err = new GitError("wrap", { cause, details: { step: "fetch" } });
    expect(err.cause).toBe(cause);
    expect(err.details).toEqual({ step: "fetch" });
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

  test("应支持自定义消息与 operation/source", () => {
    const err = new ObjectNotFoundError("abc123", {
      message: "Custom message",
      operation: "read",
      source: "loose",
    });
    expect(err.message).toBe("Custom message");
    expect(err.hash).toBe("abc123");
    expect(err.operation).toBe("read");
    expect(err.source).toBe("loose");
  });
});

describe("InvalidObjectError", () => {
  test("应包含前缀消息", () => {
    const err = new InvalidObjectError("bad format");
    expect(err).toBeInstanceOf(GitError);
    expect(err.name).toBe("InvalidObjectError");
    expect(err.message).toBe("Invalid Git object: bad format");
  });

  test("应支持 type/hash 固定字段", () => {
    const err = new InvalidObjectError("size mismatch", { type: "blob", hash: "aa".repeat(20) });
    expect(err.type).toBe("blob");
    expect(err.hash).toBe("aa".repeat(20));
  });
});

describe("ObjectHashMismatchError", () => {
  test("应包含 expected/actual", () => {
    const err = new ObjectHashMismatchError("aa".repeat(20), "bb".repeat(20));
    expect(err).toBeInstanceOf(GitError);
    expect(err.name).toBe("ObjectHashMismatchError");
    expect(err.expected).toBe("aa".repeat(20));
    expect(err.actual).toBe("bb".repeat(20));
    expect(err.message).toContain("hash mismatch");
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

describe("RepositoryError / ImportError / TreeError", () => {
  test("基本仓库错误", () => {
    const err = new RepositoryError("repo error");
    expect(err).toBeInstanceOf(GitError);
    expect(err.name).toBe("RepositoryError");
    expect(err.message).toBe("repo error");
  });

  test("ImportError 继承 RepositoryError 并带 phase", () => {
    const err = new ImportError("bad plan", { phase: "apply" });
    expect(err).toBeInstanceOf(RepositoryError);
    expect(err).toBeInstanceOf(ImportError);
    expect(err.name).toBe("ImportError");
    expect(err.phase).toBe("apply");
  });

  test("TreeError 带 path/hash", () => {
    const err = new TreeError("bad path", { path: "a/b", hash: "cc".repeat(20) });
    expect(err).toBeInstanceOf(RepositoryError);
    expect(err.path).toBe("a/b");
    expect(err.hash).toBe("cc".repeat(20));
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

  test("应支持 chain", () => {
    const err = new CircularReferenceError("refs/heads/a", {
      chain: ["refs/heads/a", "refs/heads/b", "refs/heads/a"],
    });
    expect(err.chain).toEqual(["refs/heads/a", "refs/heads/b", "refs/heads/a"]);
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

  test("InvalidPackError 继承 PackError 并带 offset", () => {
    const err = new InvalidPackError("bad header", { offset: 12 });
    expect(err).toBeInstanceOf(PackError);
    expect(err).toBeInstanceOf(GitError);
    expect(err.name).toBe("InvalidPackError");
    expect(err.message).toContain("Invalid packfile");
    expect(err.offset).toBe(12);
  });

  test("PackIndexError 继承 PackError 并带 path", () => {
    const err = new PackIndexError("bad index", { path: "/tmp/x.idx" });
    expect(err).toBeInstanceOf(PackError);
    expect(err).toBeInstanceOf(GitError);
    expect(err.name).toBe("PackIndexError");
    expect(err.message).toContain("Pack index error");
    expect(err.path).toBe("/tmp/x.idx");
  });

  test("DeltaError 继承 PackError 并带数值字段", () => {
    const err = new DeltaError("Copy out of bounds", {
      baseLength: 10,
      copyOffset: 8,
      copySize: 5,
      destSize: 20,
      destOffset: 0,
    });
    expect(err).toBeInstanceOf(GitError);
    expect(err).toBeInstanceOf(PackError);
    expect(err.name).toBe("DeltaError");
    expect(err.baseLength).toBe(10);
    expect(err.copyOffset).toBe(8);
    expect(err.copySize).toBe(5);
    expect(err.destSize).toBe(20);
    expect(err.destOffset).toBe(0);
  });
});

describe("TransactionError", () => {
  test("包含 message 与 operation", () => {
    const err = new TransactionError("transaction failed", { operation: "commit" });
    expect(err).toBeInstanceOf(GitError);
    expect(err.name).toBe("TransactionError");
    expect(err.operation).toBe("commit");
  });
});

describe("PreconditionCheckError", () => {
  test("包含 message 与 expected/actual", () => {
    const err = new PreconditionCheckError("ref mismatch", {
      refName: "refs/heads/main",
      expected: "aa".repeat(20),
      actual: "bb".repeat(20),
    });
    expect(err).toBeInstanceOf(GitError);
    expect(err.name).toBe("PreconditionCheckError");
    expect(err.refName).toBe("refs/heads/main");
    expect(err.expected).toBe("aa".repeat(20));
    expect(err.actual).toBe("bb".repeat(20));
  });
});

describe("Virtual 错误", () => {
  test("VirtualPathNotFoundError options.message", () => {
    const err = new VirtualPathNotFoundError("/x", { message: "自定义" });
    expect(err.path).toBe("/x");
    expect(err.message).toBe("自定义");
  });

  test("VirtualWorktreeError 带 worktreeKey", () => {
    const err = new VirtualWorktreeError("missing", { worktreeKey: "wt1", path: "/manifest" });
    expect(err).toBeInstanceOf(GitError);
    expect(err.worktreeKey).toBe("wt1");
    expect(err.path).toBe("/manifest");
  });
});
