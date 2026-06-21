/**
 * 基于文件系统的仓库后端
 *
 * 将 .git 目录下的 loose objects、packfile 和引用存储
 * 组合为统一的 RepositoryBackend。
 */

import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { hashToPath } from "../../core/hash.ts";
import { createFileObjectStore } from "../../odb/index.ts";
import { createCompositeObjectStore } from "../../odb/pack/composite-store.ts";
import { createPackBuilder } from "../../odb/pack/pack-builder.ts";
import { createPackObjectStore } from "../../odb/pack/pack-store.ts";
import { createFileRefStore } from "../../refs/index.ts";

import type { SHA1 } from "../../core/types.ts";
import type { ObjectSource } from "../../odb/index.ts";
import type {
  RepositoryBackend,
  RepositoryGCOptions,
  RepositoryPackSupport,
  RepositoryRepackOptions,
} from "./types.ts";

/** 创建文件系统仓库后端的可选参数 */
export interface CreateFileRepositoryBackendOptions {
  /**
   * 是否将 .git/objects/pack 下的 packfile 纳入读取路径
   *
   * 默认启用，使 openRepository() 能读取真实 Git 仓库中的 packed objects。
   */
  readonly includePack?: boolean;
}

/**
 * 创建基于文件系统的仓库后端
 *
 * @param gitDir - .git 目录的路径
 *
 * @example
 * ```ts
 * const backend = createFileRepositoryBackend("/path/to/repo/.git");
 * const repo = createRepository(backend);
 * ```
 */
export function createFileRepositoryBackend(
  gitDir: string,
  options: CreateFileRepositoryBackendOptions = {},
): RepositoryBackend {
  const looseObjects = createFileObjectStore(gitDir);
  const packSource = createPackObjectStore(gitDir);
  const objects =
    options.includePack === false
      ? looseObjects
      : createCompositeObjectStore(looseObjects, packSource);

  function refreshPackView(): void {
    packSource.refresh();
  }

  function writeFromSource(source: ObjectSource, hashes: Iterable<SHA1>) {
    const builder = createPackBuilder(gitDir);
    for (const hash of hashes) {
      builder.addObject(source.read(hash));
    }
    const result = builder.build();
    refreshPackView();
    return result;
  }

  function deletePackFiles(checksums: Iterable<string>, keepChecksum?: string): void {
    for (const checksum of checksums) {
      if (checksum === keepChecksum) {
        continue;
      }

      const packPath = join(gitDir, "objects", "pack", `pack-${checksum}.pack`);
      const idxPath = join(gitDir, "objects", "pack", `pack-${checksum}.idx`);
      if (existsSync(packPath)) {
        unlinkSync(packPath);
      }
      if (existsSync(idxPath)) {
        unlinkSync(idxPath);
      }
    }
  }

  function pruneLooseObjects(hashes: Iterable<SHA1>): void {
    for (const hash of hashes) {
      const objectPath = join(gitDir, "objects", hashToPath(hash));
      if (existsSync(objectPath)) {
        unlinkSync(objectPath);
      }
    }
  }

  const packs: RepositoryPackSupport = {
    source: packSource,
    createBuilder() {
      return createPackBuilder(gitDir);
    },
    writeObjects(objects) {
      const builder = createPackBuilder(gitDir);
      for (const obj of objects) {
        builder.addObject(obj);
      }
      const result = builder.build();
      refreshPackView();
      return result;
    },
    writeFromSource(source, hashes) {
      return writeFromSource(source, hashes);
    },
    repack(source, options: RepositoryRepackOptions = {}) {
      const hashes = Array.from(options.hashes ?? source.list());
      const existingChecksums = packSource.listPacks().map((pack) => pack.checksum);
      const result = writeFromSource(source, hashes);

      if (options.replaceExistingPacks !== false) {
        deletePackFiles(existingChecksums, result.checksum);
      }

      if (options.pruneLoose) {
        pruneLooseObjects(hashes);
      }

      refreshPackView();
      return result;
    },
    gc(reachable, options: RepositoryGCOptions = {}) {
      const reachableHashes = Array.from(reachable);
      const reachableSet = new Set(reachableHashes);
      const unreachableLooseHashes = looseObjects.list().filter((hash) => !reachableSet.has(hash));
      const result = this.repack(objects, {
        hashes: reachableHashes,
        replaceExistingPacks: options.replaceExistingPacks,
        pruneLoose: options.pruneLoose ?? true,
      });
      pruneLooseObjects(unreachableLooseHashes);
      refreshPackView();
      return result;
    },
  };

  return {
    gitDir,
    objects,
    refs: createFileRefStore(gitDir),
    packs,
  };
}
