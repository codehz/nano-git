/**
 * Packfile 构建器共享类型
 */

/**
 * Packfile 构建结果
 */
export interface PackBuildResult {
  /** packfile 文件路径 */
  packPath: string;
  /** 索引文件路径 */
  idxPath: string;
  /** packfile 的 SHA-1 校验和 */
  checksum: string;
  /** 打包的对象数量 */
  objectCount: number;
}
