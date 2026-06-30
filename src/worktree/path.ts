/**
 * Virtual Worktree 路径规范化与分段工具
 *
 * 与 Git tree 路径约定一致：相对路径、不以 `/` 开头或结尾、无 `..` / `.` 段。
 * 根目录在 worktree API 中用 `""` 表示（`readdir()` 无参或传 `""`）。
 */

// ==================== 常量 ====================

/** 根目录路径（readdir 等 API 使用） */
export const VIRTUAL_ROOT_PATH = "";

// ==================== 规范化 ====================

/**
 * 规范化 readdir 等 API 的目录路径参数
 *
 * `undefined` 与 `""` 均视为根目录。
 */
export function normalizeDirectoryPath(path: string | undefined): string {
  if (path === undefined || path === "") {
    return VIRTUAL_ROOT_PATH;
  }
  assertValidVirtualPath(path);
  return path;
}

/**
 * 校验非根虚拟路径格式（用于文件/子路径操作）
 *
 * @throws 路径为空或格式非法时抛出 Error
 */
export function assertValidVirtualPath(path: string): void {
  if (path === "") {
    throw new Error("Path must not be empty");
  }
  validateVirtualPathSegments(path);
}

/**
 * 校验路径段规则（根路径 `""` 由调用方单独处理）
 */
export function validateVirtualPathSegments(path: string): void {
  if (path.startsWith("/")) {
    throw new Error(`Path must not start with '/': ${path}`);
  }
  if (path.endsWith("/")) {
    throw new Error(`Path must not end with '/': ${path}`);
  }
  if (path.includes("//")) {
    throw new Error(`Path must not contain consecutive slashes: ${path}`);
  }
  for (const segment of path.split("/")) {
    if (segment === "." || segment === "..") {
      throw new Error(`Path must not contain '.' or '..': ${path}`);
    }
    if (segment === "") {
      throw new Error(`Path must not contain empty segments: ${path}`);
    }
  }
}

// ==================== 分段与组合 ====================

/**
 * 将路径拆分为段（不含空段）
 *
 * 调用前须保证路径已通过 `assertValidVirtualPath`。
 */
export function splitPathSegments(path: string): readonly string[] {
  return path.split("/");
}

/**
 * 返回父路径；单段路径返回 `null`（表示无父目录，父为根）
 */
export function parentPath(path: string): string | null {
  assertValidVirtualPath(path);
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash === -1) {
    return null;
  }
  return path.slice(0, lastSlash);
}

/**
 * 返回路径最后一段（条目名）
 */
export function baseName(path: string): string {
  assertValidVirtualPath(path);
  const lastSlash = path.lastIndexOf("/");
  return lastSlash === -1 ? path : path.slice(lastSlash + 1);
}

/**
 * 组合父路径与条目名
 *
 * @param parent - `null` 表示根下直接子项
 */
export function joinPath(parent: string | null, name: string): string {
  if (name === "" || name.includes("/")) {
    throw new Error(`Invalid entry name: ${name}`);
  }
  if (parent === null) {
    return name;
  }
  if (parent === VIRTUAL_ROOT_PATH) {
    return name;
  }
  assertValidVirtualPath(parent);
  return `${parent}/${name}`;
}
