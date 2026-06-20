/**
 * CRC32 计算工具
 */

/** CRC32 查找表缓存 */
let crc32Table: Uint32Array | null = null;

/**
 * 计算数据的 CRC32 校验和
 *
 * 使用标准 CRC32 算法（与 Git 兼容）。
 *
 * @example
 * ```ts
 * const crc = crc32Value(Buffer.from("hello"));
 * ```
 */
export function crc32Value(data: Buffer): number {
  const table = getCRC32Table();

  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ data[i]!) & 0xff]!;
  }

  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 获取或生成 CRC32 查找表
 */
function getCRC32Table(): Uint32Array {
  if (crc32Table) {
    return crc32Table;
  }

  crc32Table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      if (crc & 1) {
        crc = (crc >>> 1) ^ 0xedb88320;
      } else {
        crc = crc >>> 1;
      }
    }
    crc32Table[i] = crc;
  }

  return crc32Table;
}
