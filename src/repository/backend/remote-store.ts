/**
 * Remote 配置存储
 *
 * 将 repository 层的 RemoteConfig 与后端持久化媒介解耦。
 * 内存后端使用 Map，文件后端使用 .git/config。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type RemoteConfig } from "../remote-types.ts";
import { type GitConfigSection, parseGitConfig, renderGitConfig } from "./git-config.ts";

/**
 * Remote 配置存储接口
 */
export interface RemoteStore {
  /** 保存或覆盖 remote 配置 */
  set(config: RemoteConfig): void;
  /** 读取单个 remote 配置 */
  get(name: string): RemoteConfig | null;
  /** 列出全部 remote 配置 */
  list(): RemoteConfig[];
}

/**
 * 创建内存版 RemoteStore
 *
 * @param initialRemotes - 初始 remote 配置
 * @returns 内存版 RemoteStore
 *
 * @example
 * ```ts
 * const store = createMemoryRemoteStore();
 * store.set({ name: "origin", url: "https://example.com/repo.git" });
 * ```
 */
export function createMemoryRemoteStore(initialRemotes: RemoteConfig[] = []): RemoteStore {
  const remotes = new Map<string, RemoteConfig>();
  for (const remote of initialRemotes) {
    remotes.set(remote.name, cloneRemoteConfig(remote));
  }

  return {
    set(config: RemoteConfig): void {
      remotes.set(config.name, cloneRemoteConfig(config));
    },

    get(name: string): RemoteConfig | null {
      const remote = remotes.get(name);
      return remote ? cloneRemoteConfig(remote) : null;
    },

    list(): RemoteConfig[] {
      return Array.from(remotes.values(), cloneRemoteConfig).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    },
  };
}

/**
 * 创建基于 .git/config 的 RemoteStore
 *
 * @param gitDir - .git 目录路径
 * @returns 文件版 RemoteStore
 *
 * @example
 * ```ts
 * const store = createFileRemoteStore("/path/to/repo/.git");
 * console.log(store.list());
 * ```
 */
export function createFileRemoteStore(gitDir: string): RemoteStore {
  const configPath = join(gitDir, "config");

  function readSections(): GitConfigSection[] {
    if (!existsSync(configPath)) {
      return [];
    }

    return parseGitConfig(readFileSync(configPath, "utf-8"));
  }

  function writeSections(sections: GitConfigSection[]): void {
    writeFileSync(configPath, renderGitConfig(sections));
  }

  return {
    set(config: RemoteConfig): void {
      const sections = readSections().filter(
        (section) => !(section.name === "remote" && section.subsection === config.name),
      );

      sections.push({
        name: "remote",
        subsection: config.name,
        entries: [{ key: "url", value: config.url }],
      });

      writeSections(sections);
    },

    get(name: string): RemoteConfig | null {
      return readRemoteConfig(readSections(), name);
    },

    list(): RemoteConfig[] {
      return readSections()
        .filter((section) => section.name === "remote" && section.subsection)
        .map(sectionToRemoteConfig)
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}

function readRemoteConfig(sections: GitConfigSection[], name: string): RemoteConfig | null {
  const section = sections.find((item) => item.name === "remote" && item.subsection === name);
  return section ? sectionToRemoteConfig(section) : null;
}

function sectionToRemoteConfig(section: GitConfigSection): RemoteConfig {
  const name = section.subsection;
  if (!name) {
    throw new Error("Remote config section is missing subsection name");
  }

  const url = section.entries.find((entry) => entry.key === "url")?.value;
  if (!url) {
    throw new Error(`Remote "${name}" is missing url in config`);
  }

  return {
    name,
    url,
  };
}

function cloneRemoteConfig(config: RemoteConfig): RemoteConfig {
  return {
    ...config,
  };
}
