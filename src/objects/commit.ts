/**
 * Commit 对象序列化/反序列化
 *
 * Commit 的文本格式：
 * ```
 * tree <hash>
 * parent <hash>
 * parent <hash>
 * author <name> <email> <timestamp> <timezone>
 * committer <name> <email> <timestamp> <timezone>
 *
 * <message>
 * ```
 */

import { InvalidObjectError } from "../errors.ts";
import { sha1 } from "../types/index.ts";
import { formatAuthor, parseAuthor } from "./author.ts";

import type { GitCommit, GitCommitExtraHeader, SHA1 } from "../types/index.ts";

interface ParsedCommitHeader {
  readonly name: string;
  value: string;
}

interface PendingCommitHeaders {
  tree?: SHA1;
  readonly parents: SHA1[];
  author?: ReturnType<typeof parseAuthor>;
  committer?: ReturnType<typeof parseAuthor>;
  encoding?: string;
  gpgsig?: string;
  readonly mergetag: string[];
  readonly extraHeaders: GitCommitExtraHeader[];
}

// ============================================================================
// Header 编解码辅助
// ============================================================================

const BUILTIN_COMMIT_HEADERS = new Set<string>([
  "tree",
  "parent",
  "author",
  "committer",
  "encoding",
  "gpgsig",
  "mergetag",
]);

function validateExtraHeaderName(name: string): void {
  if (name.length === 0 || /\s/.test(name) || name.includes("\0")) {
    throw new InvalidObjectError(`invalid commit extra header name: ${name}`);
  }
  if (BUILTIN_COMMIT_HEADERS.has(name)) {
    throw new InvalidObjectError(
      `commit extra header "${name}" 与内建字段冲突，请改用对应的专用字段。`,
    );
  }
}

function parseCommitHeaders(headerText: string): ParsedCommitHeader[] {
  if (headerText.length === 0) {
    return [];
  }

  const rawLines = headerText.split("\n");
  const headers: ParsedCommitHeader[] = [];
  let current: ParsedCommitHeader | undefined;

  for (const line of rawLines) {
    if (line.startsWith(" ")) {
      if (!current) {
        throw new InvalidObjectError("invalid commit header continuation without base header");
      }
      current.value += `\n${line.slice(1)}`;
      continue;
    }

    const spaceIndex = line.indexOf(" ");
    if (spaceIndex === -1) {
      throw new InvalidObjectError(`invalid commit header: ${line}`);
    }

    current = {
      name: line.slice(0, spaceIndex),
      value: line.slice(spaceIndex + 1),
    };
    headers.push(current);
  }

  return headers;
}

function applyParsedHeader(state: PendingCommitHeaders, header: ParsedCommitHeader): void {
  switch (header.name) {
    case "tree":
      if (state.tree !== undefined) {
        throw new InvalidObjectError("commit has multiple tree headers");
      }
      state.tree = sha1(header.value);
      return;
    case "parent":
      state.parents.push(sha1(header.value));
      return;
    case "author":
      if (state.author !== undefined) {
        throw new InvalidObjectError("commit has multiple author headers");
      }
      state.author = parseAuthor(header.value);
      return;
    case "committer":
      if (state.committer !== undefined) {
        throw new InvalidObjectError("commit has multiple committer headers");
      }
      state.committer = parseAuthor(header.value);
      return;
    case "encoding":
      if (state.encoding !== undefined) {
        throw new InvalidObjectError("commit has multiple encoding headers");
      }
      state.encoding = header.value;
      return;
    case "gpgsig":
      if (state.gpgsig !== undefined) {
        throw new InvalidObjectError("commit has multiple gpgsig headers");
      }
      state.gpgsig = header.value;
      return;
    case "mergetag":
      state.mergetag.push(header.value);
      return;
    default:
      state.extraHeaders.push({
        name: header.name,
        value: header.value,
      });
  }
}

function encodeCommitHeader(name: string, value: string): string[] {
  const parts = value.split("\n");
  const encoded = [`${name} ${parts[0] ?? ""}`];

  for (let i = 1; i < parts.length; i++) {
    encoded.push(` ${parts[i] ?? ""}`);
  }

  return encoded;
}

function buildCommitHeaderLines(commit: GitCommit): string[] {
  const lines: string[] = [];

  lines.push(`tree ${commit.tree}`);

  for (const parent of commit.parents) {
    lines.push(`parent ${parent}`);
  }

  lines.push(`author ${formatAuthor(commit.author)}`);
  lines.push(`committer ${formatAuthor(commit.committer)}`);

  if (commit.encoding !== undefined) {
    lines.push(...encodeCommitHeader("encoding", commit.encoding));
  }

  if (commit.gpgsig !== undefined) {
    lines.push(...encodeCommitHeader("gpgsig", commit.gpgsig));
  }

  for (const tag of commit.mergetag ?? []) {
    lines.push(...encodeCommitHeader("mergetag", tag));
  }

  for (const header of commit.extraHeaders ?? []) {
    validateExtraHeaderName(header.name);
    lines.push(...encodeCommitHeader(header.name, header.value));
  }

  return lines;
}

// ============================================================================
// Commit 编解码
// ============================================================================

/**
 * 序列化 Commit 对象
 *
 * @example
 * ```ts
 * const commit: GitCommit = {
 *   type: "commit",
 *   tree: sha1("abc..."),
 *   parents: [],
 *   author: { name: "John", email: "j@e.com", timestamp: 123, timezone: "+0800" },
 *   committer: { name: "John", email: "j@e.com", timestamp: 123, timezone: "+0800" },
 *   message: "Initial commit",
 * };
 * const buf = serializeCommit(commit);
 * ```
 */
export function serializeCommit(commit: GitCommit): Buffer {
  const headerLines = buildCommitHeaderLines(commit);
  return Buffer.from(
    `${headerLines.join("\n")}\n\n${commit.message.replace(/\n+$/, "")}\n`,
    "utf-8",
  );
}

/**
 * 反序列化 Commit 对象
 */
export function deserializeCommit(content: Buffer): GitCommit {
  const text = content.toString("utf-8");
  const separatorIndex = text.indexOf("\n\n");
  const headerText = separatorIndex === -1 ? text : text.slice(0, separatorIndex);
  const rawMessage = separatorIndex === -1 ? "" : text.slice(separatorIndex + 2);

  const parsedHeaders = parseCommitHeaders(headerText);
  const state: PendingCommitHeaders = {
    parents: [],
    mergetag: [],
    extraHeaders: [],
  };

  for (const header of parsedHeaders) {
    applyParsedHeader(state, header);
  }

  if (!state.tree) throw new InvalidObjectError("commit missing tree");
  if (!state.author) throw new InvalidObjectError("commit missing author");
  if (!state.committer) throw new InvalidObjectError("commit missing committer");

  return {
    type: "commit",
    tree: state.tree,
    parents: state.parents,
    author: state.author,
    committer: state.committer,
    encoding: state.encoding,
    gpgsig: state.gpgsig,
    mergetag: state.mergetag.length > 0 ? state.mergetag : undefined,
    extraHeaders: state.extraHeaders.length > 0 ? state.extraHeaders : undefined,
    message: rawMessage.replace(/\n$/, ""),
  };
}
