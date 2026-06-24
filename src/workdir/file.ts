/**
 * 文件系统 Virtual Workdir 入口
 *
 * 对应 `nano-git/workdir/file` 子路径。
 *
 * 当前 backend 以 `manifest.json` 作为 session 主视图，
 * 适用于单进程、单写者场景，不承诺跨进程并发写安全。
 */

export {
  createFileVirtualWorkdirBackend,
  type CreateFileVirtualWorkdirBackendOptions,
} from "./file-backend.ts";
