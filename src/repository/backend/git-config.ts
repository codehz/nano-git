/**
 * Git config 文件的最小读写支持
 *
 * 仅覆盖当前仓库层需要的 section/key/value 语义，
 * 用于 remote 等配置的持久化。
 */

export interface GitConfigEntry {
  readonly key: string;
  readonly value: string;
}

export interface GitConfigSection {
  readonly name: string;
  readonly subsection?: string;
  readonly entries: GitConfigEntry[];
}

/**
 * 解析 Git config 文本
 *
 * @param text - 原始 config 文本
 * @returns section 列表
 *
 * @example
 * ```ts
 * const sections = parseGitConfig(`
 * [remote "origin"]
 * \turl = https://example.com/repo.git
 * `);
 * ```
 */
export function parseGitConfig(text: string): GitConfigSection[] {
  const sections: GitConfigSection[] = [];
  let current: { name: string; subsection?: string; entries: GitConfigEntry[] } | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }

    const sectionMatch = line.match(/^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]$/);
    if (sectionMatch) {
      current = {
        name: sectionMatch[1]!,
        subsection: unescapeGitConfigString(sectionMatch[2]),
        entries: [],
      };
      sections.push(current);
      continue;
    }

    if (!current) {
      continue;
    }

    const keyMatch = line.match(/^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/);
    if (!keyMatch) {
      continue;
    }

    current.entries.push({
      key: keyMatch[1]!.toLowerCase(),
      value: keyMatch[2] ?? "true",
    });
  }

  return sections;
}

/**
 * 渲染 Git config 文本
 *
 * @param sections - section 列表
 * @returns config 文本
 *
 * @example
 * ```ts
 * const text = renderGitConfig([
 *   {
 *     name: "remote",
 *     subsection: "origin",
 *     entries: [{ key: "url", value: "https://example.com/repo.git" }],
 *   },
 * ]);
 * ```
 */
export function renderGitConfig(sections: GitConfigSection[]): string {
  if (sections.length === 0) {
    return "";
  }

  return `${sections
    .map((section) => {
      const header = section.subsection
        ? `[${section.name} "${escapeGitConfigString(section.subsection)}"]`
        : `[${section.name}]`;
      const body = section.entries.map((entry) => `\t${entry.key} = ${entry.value}`).join("\n");
      return body ? `${header}\n${body}` : header;
    })
    .join("\n\n")}\n`;
}

function unescapeGitConfigString(value?: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return value.replace(/\\(["\\])/g, "$1");
}

function escapeGitConfigString(value: string): string {
  return value.replace(/(["\\])/g, "\\$1");
}
