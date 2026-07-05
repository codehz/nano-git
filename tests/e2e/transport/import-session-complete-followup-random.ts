/**
 * 完整仓库 follow-up shallow 请求下 repo.fetch() 与 git CLI 的随机对照
 *
 * 目标是扩大以下高风险组合的真实对照覆盖：
 * - 初始 clone 为完整仓库
 * - 线性 / merge 历史
 * - 后续执行 depth / deepen / shallow-since / shallow-exclude / unshallow
 *
 * 该文件既可被 bun:test 复用，也可直接通过
 * `bun run tests/e2e/transport/import-session-complete-followup-random.ts` 执行。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  cleanupDir,
  createFile,
  createTempDir,
  git,
  gitRevParse,
  gitWithTimeout,
} from "../helpers.ts";
import { getNormalizedFetchCommandBatches } from "./helpers.ts";
import { startGitHttpBackendServer } from "./http-server.ts";
import { initRepository } from "@/repository/file.ts";

type RandomFollowupOperation =
  | "depth1"
  | "deepenNoop"
  | "shallowSinceReject"
  | "shallowExcludeMainReject"
  | "shallowExcludeOidReject"
  | "unshallowReject";
type RandomHistoryShape = "linear" | "merge";

interface RandomCompleteFollowupCliComparisonOptions {
  readonly followupOperation?: RandomFollowupOperation;
  readonly historyShape?: RandomHistoryShape;
  readonly strictInitialState?: boolean;
}

interface RepositorySnapshot {
  readonly shallow: readonly string[];
  readonly tags: readonly string[];
  readonly main: string | null;
}

interface RandomCompleteFollowupCliComparisonResult {
  readonly seed: number;
  readonly matched: boolean;
  readonly mismatchPhase?: "initial" | "followup";
  readonly followupOperation: RandomFollowupOperation;
  readonly historyShape: RandomHistoryShape;
  readonly historyLength: number;
  readonly tipCommit: string;
  readonly nanoBatches: string[][];
  readonly cliBatches: string[][];
  readonly nanoStatus: "fulfilled" | "rejected";
  readonly cliStatus: "fulfilled" | "rejected";
  readonly initialNano: RepositorySnapshot;
  readonly initialCli: RepositorySnapshot;
  readonly finalNano: RepositorySnapshot;
  readonly finalCli: RepositorySnapshot;
}

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

function parseSeedArguments(args: readonly string[]): {
  readonly seeds: number[];
  readonly options: RandomCompleteFollowupCliComparisonOptions;
} {
  const seedArgs: string[] = [];
  const options: {
    followupOperation?: RandomFollowupOperation;
    historyShape?: RandomHistoryShape;
    strictInitialState?: boolean;
  } = {};

  for (const arg of args) {
    if (arg === "--depth1") {
      options.followupOperation = "depth1";
      continue;
    }
    if (arg === "--deepen") {
      options.followupOperation = "deepenNoop";
      continue;
    }
    if (arg === "--shallow-since") {
      options.followupOperation = "shallowSinceReject";
      continue;
    }
    if (arg === "--shallow-exclude-main") {
      options.followupOperation = "shallowExcludeMainReject";
      continue;
    }
    if (arg === "--shallow-exclude-oid") {
      options.followupOperation = "shallowExcludeOidReject";
      continue;
    }
    if (arg === "--unshallow") {
      options.followupOperation = "unshallowReject";
      continue;
    }
    if (arg === "--linear-history") {
      options.historyShape = "linear";
      continue;
    }
    if (arg === "--merge-history") {
      options.historyShape = "merge";
      continue;
    }
    if (arg === "--strict-initial-state") {
      options.strictInitialState = true;
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

  const seeds: number[] = [];
  for (const arg of seedArgs) {
    const rangeMatch = /^(\d+)-(\d+)$/.exec(arg);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      for (let seed = start; seed <= end; seed++) {
        seeds.push(seed);
      }
      continue;
    }

    const seed = Number(arg);
    if (!Number.isInteger(seed) || seed <= 0) {
      throw new Error(`Invalid seed argument: ${arg}`);
    }
    seeds.push(seed);
  }

  return { seeds, options };
}

function readCliShallowSync(workDir: string): string[] {
  const shallowPath = join(workDir, ".git", "shallow");
  if (!existsSync(shallowPath)) {
    return [];
  }
  const content = readFileSync(shallowPath, "utf-8").trim();
  return content.length === 0 ? [] : content.split(/\n+/);
}

function readBareTagNames(gitDir: string, cwd: string): string[] {
  const output = git(
    ["--git-dir", gitDir, "for-each-ref", "--format=%(refname)", "refs/tags"],
    cwd,
  );
  return output.length === 0 ? [] : output.split(/\n+/);
}

function readWorktreeTagNames(workDir: string): string[] {
  const output = git(["tag", "-l", "--format=%(refname)"], workDir);
  return output.length === 0 ? [] : output.split(/\n+/);
}

function sortStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function createTag(workDir: string, tagName: string, target: string, annotated: boolean): void {
  if (annotated) {
    git(["tag", "-a", tagName, target, "-m", tagName], workDir);
    return;
  }

  git(["tag", tagName, target], workDir);
}

function snapshotNanoRepository(
  repo: ReturnType<typeof initRepository>,
  gitDir: string,
  cwd: string,
): RepositorySnapshot {
  return {
    shallow: sortStrings(repo.shallow.read()),
    tags: sortStrings(readBareTagNames(gitDir, cwd)),
    main: repo.readBranch("main"),
  };
}

function snapshotCliRepository(workDir: string): RepositorySnapshot {
  return {
    shallow: sortStrings(readCliShallowSync(workDir)),
    tags: sortStrings(readWorktreeTagNames(workDir)),
    main: gitRevParse(workDir, "HEAD"),
  };
}

function sameComparableSnapshot(left: RepositorySnapshot, right: RepositorySnapshot): boolean {
  return (
    JSON.stringify(left.shallow) === JSON.stringify(right.shallow) &&
    left.main === right.main &&
    JSON.stringify(left.tags) === JSON.stringify(right.tags)
  );
}

async function createRandomLinearRepository(
  tempDir: string,
  seed: number,
  rand: () => number,
): Promise<{
  readonly bareDir: string;
  readonly historyLength: number;
  readonly tipCommit: string;
}> {
  const bareDir = join(tempDir, `complete-upstream-${seed}.git`);
  const workDir = join(tempDir, `complete-upstream-work-${seed}`);
  const historyLength = 4 + Math.floor(rand() * 4);
  const pushedTagRefs: string[] = [];

  git(["init", "--bare", "-b", "main", bareDir], tempDir);
  git(["init", "-b", "main", workDir], tempDir);
  git(["remote", "add", "origin", bareDir], workDir);

  const commitHashes: string[] = [];
  for (let index = 0; index < historyLength; index++) {
    createFile(workDir, `c${index + 1}.txt`, `c${index + 1}\n`);
    git(["add", `c${index + 1}.txt`], workDir);
    git(["commit", "-m", `c${index + 1}`], workDir);
    commitHashes.push(git(["rev-parse", "HEAD"], workDir));
  }

  if (commitHashes.length >= 2) {
    const baseTagTarget = commitHashes[Math.max(0, commitHashes.length - 2)]!;
    createTag(workDir, `v-base-${seed}`, baseTagTarget, rand() < 0.5);
    pushedTagRefs.push(`refs/tags/v-base-${seed}`);
  }

  const tipCommit = commitHashes[commitHashes.length - 1]!;
  if (rand() < 0.5) {
    createTag(workDir, `v-tip-${seed}`, tipCommit, rand() < 0.5);
    pushedTagRefs.push(`refs/tags/v-tip-${seed}`);
  }

  git(["push", "-u", "origin", "main", ...pushedTagRefs], workDir);

  return {
    bareDir,
    historyLength,
    tipCommit,
  };
}

async function createRandomMergeRepository(
  tempDir: string,
  seed: number,
  rand: () => number,
): Promise<{
  readonly bareDir: string;
  readonly historyLength: number;
  readonly tipCommit: string;
}> {
  const bareDir = join(tempDir, `complete-upstream-${seed}.git`);
  const workDir = join(tempDir, `complete-upstream-work-${seed}`);
  const baseCommitCount = 3 + Math.floor(rand() * 2);
  const topicCommitCount = 2 + Math.floor(rand() * 2);
  const mainAdvanceCount = 1 + Math.floor(rand() * 2);
  const pushedTagRefs: string[] = [];

  git(["init", "--bare", "-b", "main", bareDir], tempDir);
  git(["init", "-b", "main", workDir], tempDir);
  git(["remote", "add", "origin", bareDir], workDir);

  for (let index = 0; index < baseCommitCount; index++) {
    createFile(workDir, `base-${index + 1}.txt`, `base-${index + 1}\n`);
    git(["add", `base-${index + 1}.txt`], workDir);
    git(["commit", "-m", `base-${index + 1}`], workDir);
  }

  const splitOffset = Math.min(baseCommitCount - 1, 1 + Math.floor(rand() * 2));
  git(["checkout", "-b", "topic", `main~${splitOffset}`], workDir);
  for (let index = 0; index < topicCommitCount; index++) {
    createFile(workDir, `topic-${index + 1}.txt`, `topic-${index + 1}\n`);
    git(["add", `topic-${index + 1}.txt`], workDir);
    git(["commit", "-m", `topic-${index + 1}`], workDir);
  }
  const topicTip = git(["rev-parse", "HEAD"], workDir);
  createTag(workDir, `v-topic-${seed}`, topicTip, rand() < 0.5);
  pushedTagRefs.push(`refs/tags/v-topic-${seed}`);

  git(["checkout", "main"], workDir);
  for (let index = 0; index < mainAdvanceCount; index++) {
    createFile(workDir, `main-advance-${index + 1}.txt`, `main-advance-${index + 1}\n`);
    git(["add", `main-advance-${index + 1}.txt`], workDir);
    git(["commit", "-m", `main-advance-${index + 1}`], workDir);
  }

  git(["merge", "--no-ff", "topic", "-m", `merge-topic-${seed}`], workDir);
  createFile(workDir, "tail-after-merge.txt", "tail-after-merge\n");
  git(["add", "tail-after-merge.txt"], workDir);
  git(["commit", "-m", "tail-after-merge"], workDir);

  const tipCommit = git(["rev-parse", "HEAD"], workDir);
  if (rand() < 0.5) {
    createTag(workDir, `v-merge-${seed}`, tipCommit, rand() < 0.5);
    pushedTagRefs.push(`refs/tags/v-merge-${seed}`);
  }

  git(["push", "-u", "origin", "main", "topic", ...pushedTagRefs], workDir);

  return {
    bareDir,
    historyLength: baseCommitCount + topicCommitCount + mainAdvanceCount + 2,
    tipCommit,
  };
}

async function createRandomCompleteRepository(
  tempDir: string,
  seed: number,
  rand: () => number,
  historyShape: RandomHistoryShape,
): Promise<{
  readonly bareDir: string;
  readonly historyLength: number;
  readonly tipCommit: string;
}> {
  if (historyShape === "merge") {
    return createRandomMergeRepository(tempDir, seed, rand);
  }

  return createRandomLinearRepository(tempDir, seed, rand);
}

function createFollowupOperation(
  rand: () => number,
  options: RandomCompleteFollowupCliComparisonOptions,
): RandomFollowupOperation {
  if (options.followupOperation) {
    return options.followupOperation;
  }

  return pickRandom(rand, [
    "depth1",
    "deepenNoop",
    "shallowSinceReject",
    "shallowExcludeMainReject",
    "shallowExcludeOidReject",
    "unshallowReject",
  ]);
}

async function runNanoFollowup(
  repo: ReturnType<typeof initRepository>,
  url: string,
  operation: RandomFollowupOperation,
  tipCommit: string,
): Promise<void> {
  switch (operation) {
    case "depth1":
      await repo.fetch(url, { depth: 1 });
      return;
    case "deepenNoop":
      await repo.fetch(url, { deepen: 1 });
      return;
    case "shallowSinceReject":
      await repo.fetch(url, { shallowSince: 1700000001 });
      return;
    case "shallowExcludeMainReject":
      await repo.fetch(url, { shallowExclude: ["main"] });
      return;
    case "shallowExcludeOidReject":
      await repo.fetch(url, { shallowExclude: [tipCommit] });
      return;
    case "unshallowReject":
      await repo.fetch(url, { unshallow: true });
      return;
  }
}

async function runCliFollowup(
  cliDir: string,
  operation: RandomFollowupOperation,
  tipCommit: string,
): Promise<void> {
  switch (operation) {
    case "depth1":
      await gitWithTimeout(
        ["-c", "protocol.version=2", "fetch", "--depth=1", "origin"],
        cliDir,
        15000,
      );
      return;
    case "deepenNoop":
      await gitWithTimeout(
        ["-c", "protocol.version=2", "fetch", "--deepen=1", "origin"],
        cliDir,
        15000,
      );
      return;
    case "shallowSinceReject":
      await gitWithTimeout(
        ["-c", "protocol.version=2", "fetch", "--shallow-since=@1700000001", "origin"],
        cliDir,
        15000,
      );
      return;
    case "shallowExcludeMainReject":
      await gitWithTimeout(
        ["-c", "protocol.version=2", "fetch", "--shallow-exclude=main", "origin"],
        cliDir,
        15000,
      );
      return;
    case "shallowExcludeOidReject":
      await gitWithTimeout(
        ["-c", "protocol.version=2", "fetch", `--shallow-exclude=${tipCommit}`, "origin"],
        cliDir,
        15000,
      );
      return;
    case "unshallowReject":
      await gitWithTimeout(
        ["-c", "protocol.version=2", "fetch", "--unshallow", "origin"],
        cliDir,
        15000,
      );
      return;
  }
}

export async function runRandomImportSessionCompleteFollowupSeed(
  seed: number,
  options: RandomCompleteFollowupCliComparisonOptions = {},
): Promise<RandomCompleteFollowupCliComparisonResult> {
  const rand = createSeededRandom(seed);
  const tempDir = createTempDir(`import-complete-followup-random-${seed}`);
  const cliDir = join(tempDir, "cli");
  const nanoDir = join(tempDir, "nano.git");
  const historyShape = options.historyShape ?? pickRandom(rand, ["linear", "merge"]);
  const history = await createRandomCompleteRepository(tempDir, seed, rand, historyShape);
  const followupOperation = createFollowupOperation(rand, options);
  const server = startGitHttpBackendServer(tempDir, `/${history.bareDir.split("/").pop()!}`);
  const repo = initRepository(nanoDir);

  try {
    await gitWithTimeout(["-c", "protocol.version=2", "clone", server.url, cliDir], tempDir, 15000);
    await repo.fetch(server.url);

    const initialNano = snapshotNanoRepository(repo, nanoDir, tempDir);
    const initialCli = snapshotCliRepository(cliDir);
    if (options.strictInitialState === true && !sameComparableSnapshot(initialNano, initialCli)) {
      return {
        seed,
        matched: false,
        mismatchPhase: "initial",
        followupOperation,
        historyShape,
        historyLength: history.historyLength,
        tipCommit: history.tipCommit,
        nanoBatches: [],
        cliBatches: [],
        nanoStatus: "fulfilled",
        cliStatus: "fulfilled",
        initialNano,
        initialCli,
        finalNano: initialNano,
        finalCli: initialCli,
      };
    }

    server.clearRequests();
    const nanoSettled = await Promise.allSettled([
      runNanoFollowup(repo, server.url, followupOperation, history.tipCommit),
    ]);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliSettled = await Promise.allSettled([
      runCliFollowup(cliDir, followupOperation, history.tipCommit),
    ]);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    const finalNano = snapshotNanoRepository(repo, nanoDir, tempDir);
    const finalCli = snapshotCliRepository(cliDir);
    const nanoStatus = nanoSettled[0]!.status;
    const cliStatus = cliSettled[0]!.status;
    const matched =
      nanoStatus === cliStatus &&
      JSON.stringify(nanoBatches) === JSON.stringify(cliBatches) &&
      sameComparableSnapshot(finalNano, finalCli);

    return {
      seed,
      matched,
      mismatchPhase: matched ? undefined : "followup",
      followupOperation,
      historyShape,
      historyLength: history.historyLength,
      tipCommit: history.tipCommit,
      nanoBatches,
      cliBatches,
      nanoStatus,
      cliStatus,
      initialNano,
      initialCli,
      finalNano,
      finalCli,
    };
  } finally {
    await server.stop();
    cleanupDir(tempDir);
  }
}

export async function runRandomImportSessionCompleteFollowupSeeds(
  seeds: readonly number[],
  options: RandomCompleteFollowupCliComparisonOptions = {},
): Promise<readonly RandomCompleteFollowupCliComparisonResult[]> {
  const results: RandomCompleteFollowupCliComparisonResult[] = [];

  for (const seed of seeds) {
    const result = await runRandomImportSessionCompleteFollowupSeed(seed, options);
    results.push(result);

    if (!result.matched) {
      throw new Error(
        `Random complete-followup CLI comparison mismatch at seed ${seed}:\n` +
          JSON.stringify(result, null, 2),
      );
    }
  }

  return results;
}

if (import.meta.main) {
  const { seeds, options } = parseSeedArguments(process.argv.slice(2));
  const results = await runRandomImportSessionCompleteFollowupSeeds(seeds, options);
  for (const result of results) {
    console.log(`seed ${result.seed}: ok`);
  }
}
