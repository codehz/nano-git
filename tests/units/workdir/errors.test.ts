/**
 * Virtual Workdir 错误类型测试
 *
 * 验证错误类型可正确导入和实例化。
 * 所有导入来自 workdir/core，不直接依赖 errors 入口。
 * 覆盖计划中定义的全部 7 个专用错误。
 */
import { describe, test, expect } from "bun:test";

import { GitError } from "@/errors.ts";
import {
  VirtualPathNotFoundError,
  VirtualPathAlreadyExistsError,
  VirtualNotDirectoryError,
  VirtualNotFileError,
  VirtualNotSymlinkError,
  VirtualOriginUnavailableError,
  VirtualRevertNotSupportedError,
} from "@/workdir/core.ts";
describe("VirtualPathNotFoundError", () => {
  test("继承 GitError", () => {
    const err = new VirtualPathNotFoundError("/foo");
    expect(err).toBeInstanceOf(GitError);
    expect(err).toBeInstanceOf(Error);
  });

  test("携带 path 属性", () => {
    const err = new VirtualPathNotFoundError("/foo/bar");
    expect(err.path).toBe("/foo/bar");
  });

  test("默认消息包含路径", () => {
    const err = new VirtualPathNotFoundError("/missing");
    expect(err.message).toContain("/missing");
  });

  test("支持自定义消息", () => {
    const err = new VirtualPathNotFoundError("/x", "自定义");
    expect(err.message).toBe("自定义");
  });

  test("name 为类名", () => {
    const err = new VirtualPathNotFoundError("/x");
    expect(err.name).toBe("VirtualPathNotFoundError");
  });
});

describe("VirtualPathAlreadyExistsError", () => {
  test("继承 GitError", () => {
    const err = new VirtualPathAlreadyExistsError("/foo");
    expect(err).toBeInstanceOf(GitError);
  });

  test("携带 path 属性", () => {
    const err = new VirtualPathAlreadyExistsError("/foo");
    expect(err.path).toBe("/foo");
  });

  test("默认消息包含路径", () => {
    const err = new VirtualPathAlreadyExistsError("/exists");
    expect(err.message).toContain("/exists");
  });

  test("name 为类名", () => {
    const err = new VirtualPathAlreadyExistsError("/x");
    expect(err.name).toBe("VirtualPathAlreadyExistsError");
  });
});

describe("VirtualNotDirectoryError", () => {
  test("继承 GitError", () => {
    const err = new VirtualNotDirectoryError("/file");
    expect(err).toBeInstanceOf(GitError);
  });

  test("携带 path 属性", () => {
    const err = new VirtualNotDirectoryError("/file");
    expect(err.path).toBe("/file");
  });

  test("name 为类名", () => {
    const err = new VirtualNotDirectoryError("/x");
    expect(err.name).toBe("VirtualNotDirectoryError");
  });
});

describe("VirtualNotFileError", () => {
  test("继承 GitError", () => {
    const err = new VirtualNotFileError("/dir");
    expect(err).toBeInstanceOf(GitError);
  });

  test("携带 path 属性", () => {
    const err = new VirtualNotFileError("/dir");
    expect(err.path).toBe("/dir");
  });

  test("name 为类名", () => {
    const err = new VirtualNotFileError("/x");
    expect(err.name).toBe("VirtualNotFileError");
  });
});

describe("VirtualNotSymlinkError", () => {
  test("继承 GitError", () => {
    const err = new VirtualNotSymlinkError("/file");
    expect(err).toBeInstanceOf(GitError);
  });

  test("携带 path 属性", () => {
    const err = new VirtualNotSymlinkError("/file");
    expect(err.path).toBe("/file");
  });

  test("name 为类名", () => {
    const err = new VirtualNotSymlinkError("/x");
    expect(err.name).toBe("VirtualNotSymlinkError");
  });
});

describe("VirtualOriginUnavailableError", () => {
  test("继承 GitError", () => {
    const err = new VirtualOriginUnavailableError("/foo");
    expect(err).toBeInstanceOf(GitError);
  });

  test("携带 path 属性", () => {
    const err = new VirtualOriginUnavailableError("/foo");
    expect(err.path).toBe("/foo");
  });

  test("name 为类名", () => {
    const err = new VirtualOriginUnavailableError("/x");
    expect(err.name).toBe("VirtualOriginUnavailableError");
  });
});

describe("VirtualRevertNotSupportedError", () => {
  test("继承 GitError", () => {
    const err = new VirtualRevertNotSupportedError("/foo");
    expect(err).toBeInstanceOf(GitError);
  });

  test("携带 path 属性", () => {
    const err = new VirtualRevertNotSupportedError("/foo");
    expect(err.path).toBe("/foo");
  });

  test("name 为类名", () => {
    const err = new VirtualRevertNotSupportedError("/x");
    expect(err.name).toBe("VirtualRevertNotSupportedError");
  });
});
