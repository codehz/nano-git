/**
 * v2 fetch 随机场景下的 git CLI 对照校验
 *
 * 该文件既可被 bun:test 复用，也可直接通过
 * `bun run tests/e2e/transport/v2-cli-compare-random.ts` 执行。
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { cleanupDir, createTempDir, git, gitInit, createFile, gitWithTimeout } from "../helpers.ts";
import { getNormalizedFetchCommandBatches } from "./helpers.ts";
import { startGitHttpBackendServer } from "./http-server.ts";
import { initRepository } from "@/repository/file.ts";

interface RandomCliComparisonResult {
  readonly seed: number;
  readonly matched: boolean;
  readonly nanoBatches: string[][];
  readonly cliBatches: string[][];
  readonly branches: readonly string[];
  readonly nanoError?: string;
  readonly cliError?: string;
  readonly nanoBeforeHeadEntries: readonly string[];
  readonly cliBeforeHeadEntries: readonly string[];
  readonly nanoBeforeHeadTimes: readonly string[];
  readonly nanoBeforeAllEntries: readonly string[];
  readonly cliBeforeAllEntries: readonly string[];
  readonly nanoHeadEntries: readonly string[];
  readonly cliHeadEntries: readonly string[];
  readonly nanoTags: readonly string[];
  readonly cliTags: readonly string[];
  readonly nanoTagEntries: readonly string[];
  readonly cliTagEntries: readonly string[];
}

interface RandomCliComparisonOptions {
  readonly includeTags?: boolean;
  readonly includeLightweightTags?: boolean;
  readonly includeTagAliases?: boolean;
  readonly includeOrphans?: boolean;
  readonly includeRefAliases?: boolean;
  readonly negotiationStress?: boolean;
  readonly noTags?: boolean;
  readonly defaultFetch?: boolean;
  readonly explicitHeadPatterns?: boolean;
  readonly explicitHeadRefSpecs?: boolean;
  readonly explicitTagOnlyPatterns?: boolean;
  readonly explicitTagOnlyRefSpecs?: boolean;
  readonly explicitTagPatterns?: boolean;
  readonly explicitTagRefSpecs?: boolean;
  readonly relaxedHaveComparison?: boolean;
}

interface RandomCliBranchState {
  readonly name: string;
  readonly family: string;
}

const EXPLICIT_HEAD_PATTERNS = ["refs/heads/*"] as const;
const EXPLICIT_HEAD_REFSPECS = ["refs/heads/*:refs/heads/*"] as const;
const EXPLICIT_TAG_ONLY_PATTERNS = ["refs/tags/*"] as const;
const EXPLICIT_TAG_ONLY_REFSPECS = ["refs/tags/*:refs/tags/*"] as const;
const EXPLICIT_HEAD_TAG_PATTERNS = ["refs/heads/*", "refs/tags/*"] as const;
const EXPLICIT_HEAD_TAG_REFSPECS = [
  "refs/heads/*:refs/heads/*",
  "refs/tags/*:refs/tags/*",
] as const;

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function pickRandom<T>(rand: () => number, values: readonly T[]): T {
  return values[Math.floor(rand() * values.length)]!;
}

function countLines(lines: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

function compareBatchesWithRelaxedHaveComparison(
  nanoBatches: readonly string[][],
  cliBatches: readonly string[][],
): boolean {
  if (nanoBatches.length !== cliBatches.length) {
    return false;
  }

  for (let index = 0; index < nanoBatches.length; index++) {
    const nanoBatch = nanoBatches[index]!;
    const cliBatch = cliBatches[index]!;
    const nanoNonHave = nanoBatch.filter((line) => !line.startsWith("have "));
    const cliNonHave = cliBatch.filter((line) => !line.startsWith("have "));

    if (JSON.stringify(nanoNonHave) !== JSON.stringify(cliNonHave)) {
      return false;
    }

    const nanoHaveCounts = countLines(nanoBatch.filter((line) => line.startsWith("have ")));
    const cliHaveCounts = countLines(cliBatch.filter((line) => line.startsWith("have ")));
    for (const [line, count] of cliHaveCounts) {
      if ((nanoHaveCounts.get(line) ?? 0) < count) {
        return false;
      }
    }
  }

  return true;
}

function compareFetchCommandBatches(
  nanoBatches: readonly string[][],
  cliBatches: readonly string[][],
  options: RandomCliComparisonOptions,
): boolean {
  if (options.relaxedHaveComparison === true) {
    return compareBatchesWithRelaxedHaveComparison(nanoBatches, cliBatches);
  }

  return JSON.stringify(nanoBatches) === JSON.stringify(cliBatches);
}

async function cloneNanoHeads(url: string, localDir: string) {
  const repo = initRepository(localDir);
  const session = await repo.openImportSession({ url });
  const plan = session
    .plan()
    .materialize(session.select("refs/heads/*"))
    .toNamespace("refs/heads/*", { policy: { mode: "fast-forward" } })
    .materialize(session.defaultBranch())
    .setHead();
  await (await plan.build().prepare()).apply();
  return repo;
}

async function cloneNanoWithNoTags(url: string, localDir: string) {
  const repo = initRepository(localDir);
  await repo.fetch(url, { noTags: true });
  return repo;
}

async function cloneNanoWithDefaultFetch(url: string, localDir: string) {
  const repo = initRepository(localDir);
  await repo.fetch(url);
  return repo;
}

async function cloneNanoWithExplicitPatterns(
  url: string,
  localDir: string,
  refPatterns: readonly string[],
  noTags = false,
) {
  const repo = initRepository(localDir);
  await repo.fetch(url, { refPatterns: [...refPatterns], noTags: noTags || undefined });
  return repo;
}

async function cloneNanoWithExplicitRefSpecs(
  url: string,
  localDir: string,
  refSpecs: readonly string[],
  noTags = false,
) {
  const repo = initRepository(localDir);
  await repo.fetch(url, { refSpecs: [...refSpecs], noTags: noTags || undefined });
  return repo;
}

async function cloneNanoWithExplicitHeadPatterns(url: string, localDir: string) {
  return cloneNanoWithExplicitPatterns(url, localDir, EXPLICIT_HEAD_PATTERNS);
}

async function cloneNanoWithExplicitHeadRefSpecs(url: string, localDir: string) {
  return cloneNanoWithExplicitRefSpecs(url, localDir, EXPLICIT_HEAD_REFSPECS);
}

async function cloneNanoWithExplicitTagOnlyPatterns(url: string, localDir: string, noTags = false) {
  return cloneNanoWithExplicitPatterns(url, localDir, EXPLICIT_TAG_ONLY_PATTERNS, noTags);
}

async function cloneNanoWithExplicitTagOnlyRefSpecs(url: string, localDir: string, noTags = false) {
  return cloneNanoWithExplicitRefSpecs(url, localDir, EXPLICIT_TAG_ONLY_REFSPECS, noTags);
}

async function cloneNanoWithExplicitTagPatterns(url: string, localDir: string) {
  return cloneNanoWithExplicitPatterns(url, localDir, EXPLICIT_HEAD_TAG_PATTERNS);
}

async function cloneNanoWithExplicitTagPatternsAndNoTags(url: string, localDir: string) {
  return cloneNanoWithExplicitPatterns(url, localDir, EXPLICIT_HEAD_TAG_PATTERNS, true);
}

async function cloneNanoWithExplicitTagRefSpecs(url: string, localDir: string, noTags = false) {
  return cloneNanoWithExplicitRefSpecs(url, localDir, EXPLICIT_HEAD_TAG_REFSPECS, noTags);
}

async function cloneNanoHeadsAndTags(url: string, localDir: string) {
  const repo = initRepository(localDir);
  const session = await repo.openImportSession({ url });
  const plan = session
    .plan()
    .materialize(session.select("refs/heads/*"))
    .toNamespace("refs/heads/*", { policy: { mode: "fast-forward" } })
    .materialize(session.select("refs/tags/*"))
    .toNamespace("refs/tags/*", { policy: { mode: "create-only" } })
    .materialize(session.defaultBranch())
    .setHead();
  await (await plan.build().prepare()).apply();
  return repo;
}

async function fetchNanoHeads(repo: ReturnType<typeof initRepository>, url: string) {
  const session = await repo.openImportSession({ url });
  const plan = session
    .plan()
    .materialize(session.select("refs/heads/*"))
    .toNamespace("refs/heads/*", { policy: { mode: "fast-forward" } });
  return (await plan.build().prepare()).preview;
}

async function fetchNanoHeadsAndTags(repo: ReturnType<typeof initRepository>, url: string) {
  const session = await repo.openImportSession({ url });
  const plan = session
    .plan()
    .materialize(session.select("refs/heads/*"))
    .toNamespace("refs/heads/*", { policy: { mode: "fast-forward" } })
    .materialize(session.select("refs/tags/*"))
    .toNamespace("refs/tags/*", { policy: { mode: "create-only" } });
  return (await plan.build().prepare()).preview;
}

async function fetchNanoWithNoTags(repo: ReturnType<typeof initRepository>, url: string) {
  return repo.fetch(url, { noTags: true });
}

async function fetchNanoWithDefaultFetch(repo: ReturnType<typeof initRepository>, url: string) {
  return repo.fetch(url);
}

async function fetchNanoWithExplicitPatterns(
  repo: ReturnType<typeof initRepository>,
  url: string,
  refPatterns: readonly string[],
  noTags = false,
) {
  return repo.fetch(url, { refPatterns: [...refPatterns], noTags: noTags || undefined });
}

async function fetchNanoWithExplicitRefSpecs(
  repo: ReturnType<typeof initRepository>,
  url: string,
  refSpecs: readonly string[],
  noTags = false,
) {
  return repo.fetch(url, { refSpecs: [...refSpecs], noTags: noTags || undefined });
}

async function fetchNanoWithExplicitHeadPatterns(
  repo: ReturnType<typeof initRepository>,
  url: string,
) {
  return fetchNanoWithExplicitPatterns(repo, url, EXPLICIT_HEAD_PATTERNS);
}

async function fetchNanoWithExplicitHeadRefSpecs(
  repo: ReturnType<typeof initRepository>,
  url: string,
) {
  return fetchNanoWithExplicitRefSpecs(repo, url, EXPLICIT_HEAD_REFSPECS);
}

async function fetchNanoWithExplicitTagOnlyPatterns(
  repo: ReturnType<typeof initRepository>,
  url: string,
  noTags = false,
) {
  return fetchNanoWithExplicitPatterns(repo, url, EXPLICIT_TAG_ONLY_PATTERNS, noTags);
}

async function fetchNanoWithExplicitTagOnlyRefSpecs(
  repo: ReturnType<typeof initRepository>,
  url: string,
  noTags = false,
) {
  return fetchNanoWithExplicitRefSpecs(repo, url, EXPLICIT_TAG_ONLY_REFSPECS, noTags);
}

async function fetchNanoWithExplicitTagPatterns(
  repo: ReturnType<typeof initRepository>,
  url: string,
) {
  return fetchNanoWithExplicitPatterns(repo, url, EXPLICIT_HEAD_TAG_PATTERNS);
}

async function fetchNanoWithExplicitTagPatternsAndNoTags(
  repo: ReturnType<typeof initRepository>,
  url: string,
) {
  return fetchNanoWithExplicitPatterns(repo, url, EXPLICIT_HEAD_TAG_PATTERNS, true);
}

async function fetchNanoWithExplicitTagRefSpecs(
  repo: ReturnType<typeof initRepository>,
  url: string,
) {
  return fetchNanoWithExplicitRefSpecs(repo, url, EXPLICIT_HEAD_TAG_REFSPECS);
}

function getCliExplicitFetchRefSpecs(
  options: RandomCliComparisonOptions,
): readonly string[] | undefined {
  if (options.explicitHeadPatterns || options.explicitHeadRefSpecs) {
    return EXPLICIT_HEAD_REFSPECS;
  }

  if (options.explicitTagOnlyPatterns || options.explicitTagOnlyRefSpecs) {
    return EXPLICIT_TAG_ONLY_REFSPECS;
  }

  if (options.explicitTagPatterns || options.explicitTagRefSpecs) {
    return EXPLICIT_HEAD_TAG_REFSPECS;
  }

  return undefined;
}

function usesBareCliRepo(options: RandomCliComparisonOptions): boolean {
  return getCliExplicitFetchRefSpecs(options) !== undefined;
}

async function cloneNanoForOptions(
  url: string,
  localDir: string,
  options: RandomCliComparisonOptions,
) {
  if (options.explicitHeadPatterns) {
    return cloneNanoWithExplicitHeadPatterns(url, localDir);
  }

  if (options.explicitHeadRefSpecs) {
    return cloneNanoWithExplicitHeadRefSpecs(url, localDir);
  }

  if (options.explicitTagOnlyPatterns) {
    return cloneNanoWithExplicitTagOnlyPatterns(url, localDir, options.noTags);
  }

  if (options.explicitTagOnlyRefSpecs) {
    return cloneNanoWithExplicitTagOnlyRefSpecs(url, localDir, options.noTags);
  }

  if (options.explicitTagPatterns) {
    return options.noTags
      ? cloneNanoWithExplicitTagPatternsAndNoTags(url, localDir)
      : cloneNanoWithExplicitTagPatterns(url, localDir);
  }

  if (options.explicitTagRefSpecs) {
    return cloneNanoWithExplicitTagRefSpecs(url, localDir, options.noTags);
  }

  if (options.noTags) {
    return cloneNanoWithNoTags(url, localDir);
  }

  if (options.defaultFetch) {
    return cloneNanoWithDefaultFetch(url, localDir);
  }

  if (options.includeTags) {
    return cloneNanoHeadsAndTags(url, localDir);
  }

  return cloneNanoHeads(url, localDir);
}

async function fetchNanoForOptions(
  repo: ReturnType<typeof initRepository>,
  url: string,
  options: RandomCliComparisonOptions,
) {
  if (options.explicitHeadPatterns) {
    return fetchNanoWithExplicitHeadPatterns(repo, url);
  }

  if (options.explicitHeadRefSpecs) {
    return fetchNanoWithExplicitHeadRefSpecs(repo, url);
  }

  if (options.explicitTagOnlyPatterns) {
    return fetchNanoWithExplicitTagOnlyPatterns(repo, url, options.noTags);
  }

  if (options.explicitTagOnlyRefSpecs) {
    return fetchNanoWithExplicitTagOnlyRefSpecs(repo, url, options.noTags);
  }

  if (options.explicitTagPatterns) {
    return options.noTags
      ? fetchNanoWithExplicitTagPatternsAndNoTags(repo, url)
      : fetchNanoWithExplicitTagPatterns(repo, url);
  }

  if (options.explicitTagRefSpecs) {
    return options.noTags
      ? fetchNanoWithExplicitRefSpecs(repo, url, EXPLICIT_HEAD_TAG_REFSPECS, true)
      : fetchNanoWithExplicitTagRefSpecs(repo, url);
  }

  if (options.noTags) {
    return fetchNanoWithNoTags(repo, url);
  }

  if (options.defaultFetch) {
    return fetchNanoWithDefaultFetch(repo, url);
  }

  if (options.includeTags) {
    return fetchNanoHeadsAndTags(repo, url);
  }

  return fetchNanoHeads(repo, url);
}

async function cloneGitCli(
  url: string,
  localDir: string,
  tempDir: string,
  options: RandomCliComparisonOptions = {},
) {
  const explicitRefSpecs = getCliExplicitFetchRefSpecs(options);
  if (explicitRefSpecs) {
    await gitWithTimeout(["init", "--bare", localDir], tempDir, 15000);
    await gitWithTimeout(["--git-dir", localDir, "remote", "add", "origin", url], tempDir, 15000);
    const fetchArgs = ["--git-dir", localDir, "-c", "protocol.version=2", "fetch"];
    if (options.noTags) {
      fetchArgs.push("--no-tags");
    }
    fetchArgs.push("origin", ...explicitRefSpecs);
    await gitWithTimeout(fetchArgs, tempDir, 15000);
    return;
  }

  const cloneArgs = ["-c", "protocol.version=2", "clone"];
  if (options.noTags) {
    cloneArgs.push("--no-tags");
  }
  cloneArgs.push(url, localDir);
  await gitWithTimeout(cloneArgs, tempDir, 15000);
  await gitWithTimeout(
    ["-c", "protocol.version=2", "fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"],
    localDir,
    15000,
  );
}

async function fetchGitCli(localDir: string, options: RandomCliComparisonOptions = {}) {
  const explicitRefSpecs = getCliExplicitFetchRefSpecs(options);
  if (explicitRefSpecs) {
    const fetchArgs = [
      "-c",
      "protocol.version=2",
      "-c",
      "fetch.negotiationAlgorithm=consecutive",
      "fetch",
    ];
    if (options.noTags) {
      fetchArgs.push("--no-tags");
    }
    fetchArgs.push("origin", ...explicitRefSpecs);
    await gitWithTimeout(
      usesBareCliRepo(options) ? ["--git-dir", localDir, ...fetchArgs] : fetchArgs,
      localDir,
      15000,
    );
    return;
  }

  const args = [
    "-c",
    "protocol.version=2",
    "-c",
    "fetch.negotiationAlgorithm=consecutive",
    "fetch",
  ];
  if (options.noTags) {
    args.push("--no-tags");
  }
  if (
    options.includeTags &&
    !options.noTags &&
    options.defaultFetch !== true &&
    options.explicitTagOnlyPatterns !== true &&
    options.explicitTagOnlyRefSpecs !== true &&
    options.explicitTagPatterns !== true
  ) {
    args.push("--tags");
  }
  args.push("origin");
  await gitWithTimeout(args, localDir, 15000);
}

function commitFile(workDir: string, branch: string, serial: number) {
  git(["checkout", branch], workDir);
  const filename = `${branch.replaceAll("/", "-")}-${serial}.txt`;
  createFile(workDir, filename, `${branch}-${serial}\n`);
  git(["add", filename], workDir);
  git(["commit", "-m", `${branch}-${serial}`], workDir);
}

function mergeBranch(workDir: string, target: string, source: string, serial: number) {
  git(["checkout", target], workDir);
  git(["merge", "--no-ff", source, "-m", `merge-${source}-into-${target}-${serial}`], workDir);
}

function createAnnotatedTag(workDir: string, tagName: string) {
  git(["tag", "-a", tagName, "-m", tagName], workDir);
  git(["push", "origin", `refs/tags/${tagName}`], workDir);
}

function createLightweightTag(workDir: string, tagName: string) {
  git(["tag", tagName], workDir);
  git(["push", "origin", `refs/tags/${tagName}`], workDir);
}

function createRandomTag(
  workDir: string,
  tagName: string,
  rand: () => number,
  options: RandomCliComparisonOptions,
) {
  if (options.includeLightweightTags && rand() < 0.5) {
    createLightweightTag(workDir, tagName);
    return;
  }

  createAnnotatedTag(workDir, tagName);
}

function createTagBurst(
  workDir: string,
  tagNamePrefix: string,
  rand: () => number,
  options: RandomCliComparisonOptions,
): number {
  const tagCount = options.includeTagAliases ? 2 + Math.floor(rand() * 2) : 1;
  for (let index = 0; index < tagCount; index++) {
    createRandomTag(workDir, `${tagNamePrefix}-${index}`, rand, options);
  }
  return tagCount;
}

function createOrphanBranch(workDir: string, branch: string, serial: number) {
  git(["checkout", "--orphan", branch], workDir);
  git(["rm", "-rf", "."], workDir);
  createFile(workDir, `${branch.replaceAll("/", "-")}-${serial}.txt`, `${branch}-${serial}\n`);
  git(["add", "."], workDir);
  git(["commit", "-m", `${branch}-${serial}`], workDir);
  git(["push", "-u", "origin", branch], workDir);
}

function createBranchAlias(workDir: string, source: string, alias: string) {
  git(["checkout", source], workDir);
  git(["branch", alias, source], workDir);
  git(["push", "-u", "origin", alias], workDir);
}

function advanceBranch(
  workDir: string,
  remote: string,
  branch: string,
  count: number,
  serial: number,
) {
  for (let index = 0; index < count; index++) {
    commitFile(workDir, branch, serial + index);
  }
  git(["push", remote, branch], workDir);
}

function createHistoricalBranch(
  workDir: string,
  remote: string,
  baseRevision: string,
  branch: string,
  serial: number,
) {
  git(["checkout", baseRevision], workDir);
  git(["checkout", "-b", branch], workDir);
  commitFile(workDir, branch, serial);
  git(["push", "-u", remote, branch], workDir);
}

function parseSeedArguments(args: readonly string[]): {
  readonly seeds: number[];
  readonly options: RandomCliComparisonOptions;
} {
  const seedArgs: string[] = [];
  const options: {
    includeTags?: boolean;
    includeLightweightTags?: boolean;
    includeTagAliases?: boolean;
    includeOrphans?: boolean;
    includeRefAliases?: boolean;
    negotiationStress?: boolean;
    noTags?: boolean;
    defaultFetch?: boolean;
    explicitHeadPatterns?: boolean;
    explicitHeadRefSpecs?: boolean;
    explicitTagOnlyPatterns?: boolean;
    explicitTagOnlyRefSpecs?: boolean;
    explicitTagPatterns?: boolean;
    explicitTagRefSpecs?: boolean;
    relaxedHaveComparison?: boolean;
  } = {};

  for (const arg of args) {
    if (arg === "--tags") {
      options.includeTags = true;
      continue;
    }
    if (arg === "--lightweight-tags") {
      options.includeTags = true;
      options.includeLightweightTags = true;
      continue;
    }
    if (arg === "--tag-aliases") {
      options.includeTags = true;
      options.includeTagAliases = true;
      continue;
    }
    if (arg === "--orphans") {
      options.includeOrphans = true;
      continue;
    }
    if (arg === "--ref-aliases") {
      options.includeRefAliases = true;
      continue;
    }
    if (arg === "--negotiation-stress") {
      options.negotiationStress = true;
      continue;
    }
    if (arg === "--no-tags") {
      options.noTags = true;
      continue;
    }
    if (arg === "--default-fetch") {
      options.defaultFetch = true;
      continue;
    }
    if (arg === "--explicit-head-patterns") {
      options.explicitHeadPatterns = true;
      continue;
    }
    if (arg === "--explicit-head-refspecs") {
      options.explicitHeadRefSpecs = true;
      continue;
    }
    if (arg === "--explicit-tag-only-patterns") {
      options.explicitTagOnlyPatterns = true;
      continue;
    }
    if (arg === "--explicit-tag-only-refspecs") {
      options.explicitTagOnlyRefSpecs = true;
      continue;
    }
    if (arg === "--explicit-tag-patterns") {
      options.explicitTagPatterns = true;
      continue;
    }
    if (arg === "--explicit-tag-refspecs") {
      options.explicitTagRefSpecs = true;
      continue;
    }
    if (arg === "--relaxed-have-comparison") {
      options.relaxedHaveComparison = true;
      continue;
    }
    seedArgs.push(arg);
  }

  if (seedArgs.length === 0) {
    return {
      seeds: Array.from({ length: 10 }, (_, index) => index + 1),
      options,
    };
  }

  const result: number[] = [];
  for (const arg of seedArgs) {
    const rangeMatch = /^(\d+)-(\d+)$/.exec(arg);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      for (let seed = start; seed <= end; seed++) {
        result.push(seed);
      }
      continue;
    }

    const seed = Number(arg);
    if (!Number.isInteger(seed) || seed <= 0) {
      throw new Error(`Invalid seed argument: ${arg}`);
    }
    result.push(seed);
  }

  return { seeds: result, options };
}

/**
 * 执行单个随机 seed 的真实 git CLI 对照
 *
 * @param seed - 随机场景种子
 * @returns 当前 seed 的对照结果
 *
 * @example
 * ```ts
 * const result = await runRandomV2CliComparisonSeed(45);
 * console.log(result.matched);
 * ```
 */
export async function runRandomV2CliComparisonSeed(
  seed: number,
  options: RandomCliComparisonOptions = {},
): Promise<RandomCliComparisonResult> {
  const rand = createSeededRandom(seed);
  const tempDir = createTempDir(`cli-compare-${seed}`);
  const serverRepoDir = join(tempDir, "server.git");
  const workDir = join(tempDir, "work");
  const branches: RandomCliBranchState[] = [{ name: "main", family: "main" }];
  let serial = 0;
  let tagSerial = 0;
  let server: ReturnType<typeof startGitHttpBackendServer> | undefined;

  try {
    mkdirSync(serverRepoDir);
    git(["init", "--bare"], serverRepoDir);
    gitInit(workDir);

    createFile(workDir, "bootstrap.txt", "bootstrap\n");
    git(["add", "bootstrap.txt"], workDir);
    git(["commit", "-m", "bootstrap"], workDir);
    git(["push", serverRepoDir, "main"], workDir);
    git(["remote", "add", "origin", serverRepoDir], workDir);

    if (options.negotiationStress) {
      const mainlineBoost = 12 + Math.floor(rand() * 8);
      advanceBranch(workDir, serverRepoDir, "main", mainlineBoost, serial);
      serial += mainlineBoost;

      const oldOffset = Math.max(8, Math.floor(mainlineBoost * 0.7));
      const recentOffset = Math.max(3, Math.floor(mainlineBoost * 0.3));

      createHistoricalBranch(workDir, serverRepoDir, `main~${oldOffset}`, "stress-old", serial++);
      branches.push({ name: "stress-old", family: "main" });

      createHistoricalBranch(
        workDir,
        serverRepoDir,
        `main~${recentOffset}`,
        "stress-recent",
        serial++,
      );
      branches.push({ name: "stress-recent", family: "main" });

      if (options.includeRefAliases) {
        createBranchAlias(workDir, "stress-recent", "stress-alias");
        branches.push({ name: "stress-alias", family: "main" });
      }
    }

    const mergeableBranches = () => branches;
    const allBranchNames = () => branches.map((branch) => branch.name);
    const mergeableBranchNames = () => mergeableBranches().map((branch) => branch.name);
    const findBranch = (branchName: string) =>
      branches.find((branch) => branch.name === branchName)!;

    const preOps = options.negotiationStress
      ? 18 + Math.floor(rand() * 10)
      : 12 + Math.floor(rand() * 10);
    for (let index = 0; index < preOps; index++) {
      const opRoll = rand();
      if (
        options.includeOrphans &&
        branches.filter((branch) => branch.family.startsWith("orphan:")).length < 2 &&
        opRoll < 0.12
      ) {
        const branch = `orphan-${index}`;
        createOrphanBranch(workDir, branch, serial++);
        branches.push({ name: branch, family: `orphan:${branch}` });
        continue;
      }

      if (branches.length < (options.negotiationStress ? 7 : 5) && opRoll < 0.28) {
        const baseCandidates = options.negotiationStress
          ? branches.filter((branch) => branch.family === "main").map((branch) => branch.name)
          : allBranchNames();
        const base = pickRandom(
          rand,
          baseCandidates.length > 0 ? baseCandidates : allBranchNames(),
        );
        const branch = `topic-${index}`;
        git(["checkout", base], workDir);
        git(["checkout", "-b", branch], workDir);
        branches.push({ name: branch, family: findBranch(base).family });
        commitFile(workDir, branch, serial++);
        git(["push", "-u", serverRepoDir, branch], workDir);
        continue;
      }

      if (
        options.includeRefAliases &&
        branches.length < (options.negotiationStress ? 8 : 6) &&
        opRoll < 0.34
      ) {
        const base = pickRandom(rand, allBranchNames());
        const branch = `alias-${index}`;
        createBranchAlias(workDir, base, branch);
        branches.push({ name: branch, family: findBranch(base).family });
        continue;
      }

      if (options.includeTags && opRoll < 0.36) {
        const branch = pickRandom(rand, allBranchNames());
        git(["checkout", branch], workDir);
        tagSerial += createTagBurst(workDir, `v${seed}-${tagSerial}`, rand, options);
        continue;
      }

      if (mergeableBranches().length > 1 && opRoll < (options.negotiationStress ? 0.58 : 0.5)) {
        const target =
          rand() < (options.negotiationStress ? 0.72 : 0.6)
            ? "main"
            : pickRandom(rand, mergeableBranchNames());
        const targetFamily = findBranch(target).family;
        const sourceCandidates = mergeableBranches()
          .filter((branch) => branch.name !== target && branch.family === targetFamily)
          .map((branch) => branch.name);
        if (sourceCandidates.length === 0) {
          const branch = pickRandom(rand, allBranchNames());
          commitFile(workDir, branch, serial++);
          git(["push", serverRepoDir, branch], workDir);
          continue;
        }
        const source = pickRandom(rand, sourceCandidates);
        mergeBranch(workDir, target, source, serial++);
        git(["push", serverRepoDir, target], workDir);
        continue;
      }

      const branch = pickRandom(rand, allBranchNames());
      commitFile(workDir, branch, serial++);
      git(["push", serverRepoDir, branch], workDir);
    }

    server = startGitHttpBackendServer(tempDir, "/server.git");
    const url = server.url;
    const nanoRepo = await cloneNanoForOptions(url, join(tempDir, "nano"), options);
    const cliDir = join(tempDir, "cli");
    await cloneGitCli(url, cliDir, tempDir, options);
    const nanoGitDir = join(tempDir, "nano");
    const cliGitDir = usesBareCliRepo(options) ? cliDir : join(cliDir, ".git");
    const nanoBeforeHeadEntries = git(
      ["--git-dir", nanoGitDir, "for-each-ref", "--format=%(objectname) %(refname)", "refs/heads"],
      tempDir,
    )
      .split("\n")
      .filter((line) => line.length > 0);
    const nanoBeforeAllEntries = git(
      ["--git-dir", nanoGitDir, "for-each-ref", "--format=%(objectname) %(refname)"],
      tempDir,
    )
      .split("\n")
      .filter((line) => line.length > 0);
    const cliBeforeHeadEntries = git(
      ["--git-dir", cliGitDir, "for-each-ref", "--format=%(objectname) %(refname)", "refs/heads"],
      tempDir,
    )
      .split("\n")
      .filter((line) => line.length > 0);
    const cliBeforeAllEntries = git(
      ["--git-dir", cliGitDir, "for-each-ref", "--format=%(objectname) %(refname)"],
      tempDir,
    )
      .split("\n")
      .filter((line) => line.length > 0);
    const nanoBeforeHeadTimes = nanoBeforeHeadEntries.map((line) => {
      const hash = line.split(" ")[0]!;
      const timestamp = git(["--git-dir", nanoGitDir, "show", "-s", "--format=%ct", hash], tempDir);
      return `${timestamp} ${line}`;
    });

    const postOps = options.negotiationStress
      ? 6 + Math.floor(rand() * 6)
      : 4 + Math.floor(rand() * 5);
    for (let index = 0; index < postOps; index++) {
      const opRoll = rand();
      if (
        options.includeOrphans &&
        branches.filter((branch) => branch.family.startsWith("orphan:")).length < 3 &&
        opRoll < 0.1
      ) {
        const branch = `late-orphan-${index}`;
        createOrphanBranch(workDir, branch, serial++);
        branches.push({ name: branch, family: `orphan:${branch}` });
        continue;
      }

      if (options.includeTags && opRoll < 0.24) {
        const branch = pickRandom(rand, allBranchNames());
        git(["checkout", branch], workDir);
        tagSerial += createTagBurst(workDir, `post-v${seed}-${tagSerial}`, rand, options);
        continue;
      }

      if (mergeableBranches().length > 1 && opRoll < (options.negotiationStress ? 0.5 : 0.4)) {
        const target =
          rand() < (options.negotiationStress ? 0.68 : 0.55)
            ? "main"
            : pickRandom(rand, mergeableBranchNames());
        const targetFamily = findBranch(target).family;
        const sourceCandidates = mergeableBranches()
          .filter((branch) => branch.name !== target && branch.family === targetFamily)
          .map((branch) => branch.name);
        if (sourceCandidates.length === 0) {
          const branch = pickRandom(rand, allBranchNames());
          commitFile(workDir, branch, serial++);
          git(["push", serverRepoDir, branch], workDir);
          continue;
        }
        const source = pickRandom(rand, sourceCandidates);
        mergeBranch(workDir, target, source, serial++);
        git(["push", serverRepoDir, target], workDir);
        continue;
      }

      if (branches.length < (options.negotiationStress ? 8 : 6) && opRoll < 0.52) {
        const baseCandidates = options.negotiationStress
          ? branches.filter((branch) => branch.family === "main").map((branch) => branch.name)
          : allBranchNames();
        const base = pickRandom(
          rand,
          baseCandidates.length > 0 ? baseCandidates : allBranchNames(),
        );
        const branch = `late-${index}`;
        git(["checkout", base], workDir);
        git(["checkout", "-b", branch], workDir);
        branches.push({ name: branch, family: findBranch(base).family });
        commitFile(workDir, branch, serial++);
        git(["push", "-u", serverRepoDir, branch], workDir);
        continue;
      }

      if (options.includeRefAliases && branches.length < 7 && opRoll < 0.58) {
        const base = pickRandom(rand, allBranchNames());
        const branch = `late-alias-${index}`;
        createBranchAlias(workDir, base, branch);
        branches.push({ name: branch, family: findBranch(base).family });
        continue;
      }

      const branch = pickRandom(rand, allBranchNames());
      commitFile(workDir, branch, serial++);
      git(["push", serverRepoDir, branch], workDir);
    }

    if (options.negotiationStress) {
      const tailMainBoost = 5 + Math.floor(rand() * 4);
      advanceBranch(workDir, serverRepoDir, "main", tailMainBoost, serial);
      serial += tailMainBoost;

      if (allBranchNames().includes("stress-old")) {
        const oldBoost = 2 + Math.floor(rand() * 3);
        advanceBranch(workDir, serverRepoDir, "stress-old", oldBoost, serial);
        serial += oldBoost;
      }

      if (allBranchNames().includes("stress-recent")) {
        const recentBoost = 2 + Math.floor(rand() * 2);
        advanceBranch(workDir, serverRepoDir, "stress-recent", recentBoost, serial);
        serial += recentBoost;
        git(["checkout", "stress-recent"], workDir);
        git(["merge", "--no-ff", "main", "-m", `merge-main-into-stress-recent-${serial}`], workDir);
        git(["push", serverRepoDir, "stress-recent"], workDir);
        serial++;
      }

      if (!allBranchNames().includes("stress-late")) {
        createHistoricalBranch(workDir, serverRepoDir, "main~6", "stress-late", serial++);
        branches.push({ name: "stress-late", family: "main" });
      }

      if (
        options.includeOrphans &&
        branches.filter((branch) => branch.family.startsWith("orphan:")).length < 2
      ) {
        createOrphanBranch(workDir, "stress-orphan", serial++);
        branches.push({ name: "stress-orphan", family: "orphan:stress-orphan" });
      }
    }

    server.clearRequests();
    let nanoError: string | undefined;
    try {
      const nanoResult = await fetchNanoForOptions(nanoRepo, url, options);
      if ("canApply" in nanoResult && !nanoResult.canApply) {
        throw new Error(`Random CLI comparison seed ${seed} produced non-applicable preview`);
      }
    } catch (err: unknown) {
      nanoError = err instanceof Error ? err.message : String(err);
    }
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    let cliError: string | undefined;
    try {
      await fetchGitCli(cliDir, options);
    } catch (err: unknown) {
      cliError = err instanceof Error ? err.message : String(err);
    }
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);
    const nanoHeadEntries = git(
      ["--git-dir", nanoGitDir, "for-each-ref", "--format=%(objectname) %(refname)", "refs/heads"],
      tempDir,
    )
      .split("\n")
      .filter((line) => line.length > 0);
    const cliHeadEntries = git(
      ["--git-dir", cliGitDir, "for-each-ref", "--format=%(objectname) %(refname)", "refs/heads"],
      tempDir,
    )
      .split("\n")
      .filter((line) => line.length > 0);
    const nanoTagEntries = git(
      ["--git-dir", nanoGitDir, "for-each-ref", "--format=%(objecttype) %(refname)", "refs/tags"],
      tempDir,
    )
      .split("\n")
      .filter((line) => line.length > 0);
    const cliTagEntries = git(
      ["--git-dir", cliGitDir, "for-each-ref", "--format=%(objecttype) %(refname)", "refs/tags"],
      tempDir,
    )
      .split("\n")
      .filter((line) => line.length > 0);
    const nanoTags = nanoTagEntries.map((line) => line.replace(/^[^ ]+ /, ""));
    const cliTags = cliTagEntries.map((line) => line.replace(/^[^ ]+ /, ""));
    const matched =
      compareFetchCommandBatches(nanoBatches, cliBatches, options) &&
      (nanoError === undefined) === (cliError === undefined) &&
      (options.noTags === true ||
      options.defaultFetch === true ||
      options.explicitHeadPatterns === true ||
      options.explicitHeadRefSpecs === true ||
      options.explicitTagOnlyPatterns === true ||
      options.explicitTagOnlyRefSpecs === true ||
      options.explicitTagPatterns === true ||
      options.explicitTagRefSpecs === true
        ? JSON.stringify(nanoTagEntries) === JSON.stringify(cliTagEntries)
        : true);
    const matchedWithHeads = usesBareCliRepo(options)
      ? matched && JSON.stringify(nanoHeadEntries) === JSON.stringify(cliHeadEntries)
      : matched;

    return {
      seed,
      matched: matchedWithHeads,
      nanoBatches,
      cliBatches,
      branches: allBranchNames(),
      nanoError,
      cliError,
      nanoBeforeHeadEntries,
      cliBeforeHeadEntries,
      nanoBeforeHeadTimes,
      nanoBeforeAllEntries,
      cliBeforeAllEntries,
      nanoHeadEntries,
      cliHeadEntries,
      nanoTags,
      cliTags,
      nanoTagEntries,
      cliTagEntries,
    };
  } finally {
    await server?.stop();
    cleanupDir(tempDir);
  }
}

/**
 * 批量执行多个随机 seed 的真实 git CLI 对照
 *
 * 若任意 seed 失配，则抛出包含请求序列细节的错误，方便后续缩小场景。
 *
 * @param seeds - 要运行的随机种子列表
 * @returns 每个 seed 的对照结果
 *
 * @example
 * ```ts
 * const results = await runRandomV2CliComparisonSeeds([7, 45, 83]);
 * console.log(results.length);
 * ```
 */
export async function runRandomV2CliComparisonSeeds(
  seeds: readonly number[],
  options: RandomCliComparisonOptions = {},
): Promise<readonly RandomCliComparisonResult[]> {
  const results: RandomCliComparisonResult[] = [];

  for (const seed of seeds) {
    const result = await runRandomV2CliComparisonSeed(seed, options);
    results.push(result);

    if (!result.matched) {
      throw new Error(
        `Random CLI comparison mismatch at seed ${seed}:\n` +
          JSON.stringify(
            {
              seed,
              branches: result.branches,
              nanoBatches: result.nanoBatches,
              cliBatches: result.cliBatches,
              nanoError: result.nanoError,
              cliError: result.cliError,
              nanoBeforeHeadEntries: result.nanoBeforeHeadEntries,
              cliBeforeHeadEntries: result.cliBeforeHeadEntries,
              nanoBeforeHeadTimes: result.nanoBeforeHeadTimes,
              nanoBeforeAllEntries: result.nanoBeforeAllEntries,
              cliBeforeAllEntries: result.cliBeforeAllEntries,
              nanoHeadEntries: result.nanoHeadEntries,
              cliHeadEntries: result.cliHeadEntries,
              nanoTags: result.nanoTags,
              cliTags: result.cliTags,
              nanoTagEntries: result.nanoTagEntries,
              cliTagEntries: result.cliTagEntries,
            },
            null,
            2,
          ),
      );
    }
  }

  return results;
}

if (import.meta.main) {
  const { seeds, options } = parseSeedArguments(process.argv.slice(2));
  const results = await runRandomV2CliComparisonSeeds(seeds, options);
  for (const result of results) {
    console.log(`seed ${result.seed}: ok`);
  }
}
