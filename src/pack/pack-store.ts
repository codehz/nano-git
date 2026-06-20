/**
 * 基于 Packfile 的对象存储
 *
 * 从 .git/objects/pack/ 目录中读取 packfile 和索引文件，
 * 提供只读的对象读取接口。
 *
 * Git 的 pack 目录结构：
 * - pack-<checksum>.pack  — 打包的对象数据
 * - pack-<checksum>.idx   — 对应的索引文件
 *
 * 写入操作不支持（packfile 是只读的），
 * 新对象应写入 loose objects 或创建新的 packfile。
 *
 * @example
 * ```ts
 * const store = createPackObjectStore("/path/to/.git");
 * const obj = store.read(hash);
 * ```
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { GitObject, SHA1 } from "../types.ts";
import { ObjectNotFoundError } from "../errors.ts";
import type { ObjectSource } from "../store/types.ts";
import { PackReader } from "./pack-reader.ts";
import { PackIndexReader } from "./pack-index.ts";

// ============================================================================
// Pack 文件对（.pack + .idx）
// ============================================================================

/** 一个 packfile 及其索引的组合 */
interface PackPair {
  /** packfile 的 SHA-1 校验和（文件名中的哈希部分） */
  checksum: string;
  /** 索引读取器 */
  index: PackIndexReader;
  /** packfile 读取器（延迟加载） */
  reader: PackReader | null;
  /** packfile 数据（延迟加载） */
  packData: Buffer | null;
}

// ============================================================================
// Pack 对象存储
// ============================================================================

/**
 * 创建基于 Packfile 的对象存储
 *
 * 扫描 .git/objects/pack/ 目录，加载所有 .idx 文件。
 * packfile 数据按需加载（首次读取时才加载）。
 *
 * @param gitDir - .git 目录的路径
 * @returns 基于 Packfile 的对象存储
 *
 * @example
 * ```ts
 * const store = createPackObjectStore("/path/to/.git");
 *
 * // 读取对象
 * const obj = store.read(hash);
 *
 * // 检查对象是否存在
 * if (store.exists(hash)) {
 *   console.log("对象在 packfile 中");
 * }
 * ```
 */
export function createPackObjectStore(gitDir: string): PackObjectStore {
  return new PackObjectStore(gitDir);
}

/**
 * 基于 Packfile 的对象存储类
 */
export class PackObjectStore implements ObjectSource {
  private readonly packDir: string;
  private readonly pairs: PackPair[] = [];
  private loaded = false;

  constructor(gitDir: string) {
    this.packDir = join(gitDir, "objects", "pack");
  }

  /**
   * 扫描 pack 目录并加载索引
   */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;

    if (!existsSync(this.packDir)) return;

    const files = readdirSync(this.packDir);
    const idxFiles = files.filter((f) => f.endsWith(".idx"));

    for (const idxFile of idxFiles) {
      // 从文件名提取校验和
      const match = idxFile.match(/^pack-([0-9a-f]{40})\.idx$/);
      if (!match) continue;

      const checksum = match[1]!;
      const packFile = `pack-${checksum}.pack`;

      // 确保对应的 .pack 文件存在
      if (!existsSync(join(this.packDir, packFile))) continue;

      // 加载索引
      const idxData = readFileSync(join(this.packDir, idxFile));
      const index = new PackIndexReader(idxData);

      this.pairs.push({
        checksum,
        index,
        reader: null,
        packData: null,
      });
    }
  }

  /**
   * 延迟加载 packfile 数据
   */
  private getPackReader(pair: PackPair): PackReader {
    if (!pair.reader) {
      pair.packData = readFileSync(join(this.packDir, `pack-${pair.checksum}.pack`));
      pair.reader = new PackReader(pair.packData);
    }
    return pair.reader;
  }

  /**
   * 读取对象
   *
   * @throws ObjectNotFoundError 如果对象不存在
   */
  read(hash: SHA1): GitObject {
    this.ensureLoaded();

    for (const pair of this.pairs) {
      const entry = pair.index.lookup(hash);
      if (entry) {
        const reader = this.getPackReader(pair);
        const obj = reader.readObject(hash);
        if (obj) return obj;
      }
    }

    throw new ObjectNotFoundError(hash);
  }

  /**
   * 检查对象是否存在
   */
  exists(hash: SHA1): boolean {
    this.ensureLoaded();

    for (const pair of this.pairs) {
      if (pair.index.has(hash)) return true;
    }

    return false;
  }

  /**
   * 获取所有 packfile 中的对象哈希列表
   */
  list(): SHA1[] {
    this.ensureLoaded();

    const hashes: SHA1[] = [];
    for (const pair of this.pairs) {
      hashes.push(...pair.index.listHashes());
    }
    return hashes;
  }

  /**
   * 获取所有 packfile 中的对象哈希列表
   *
   * 保留此方法作为更明确的命名别名。
   */
  listHashes(): SHA1[] {
    return this.list();
  }

  /**
   * 获取 packfile 数量
   */
  get packCount(): number {
    this.ensureLoaded();
    return this.pairs.length;
  }

  /**
   * 获取所有对象数量
   */
  get objectCount(): number {
    this.ensureLoaded();
    let count = 0;
    for (const pair of this.pairs) {
      count += pair.index.objectCount;
    }
    return count;
  }
}
