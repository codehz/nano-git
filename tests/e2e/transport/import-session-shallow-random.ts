/**
 * source-shallow 场景下 repo.fetch() 与 git CLI 的随机对照
 *
 * 目标是扩大以下高风险组合的真实对照覆盖：
 * - 源仓库自身是 shallow
 * - 初始 clone 为完整 / depth=1
 * - 边界带 lightweight / annotated tag
 * - 后续执行 deepen / shallow-exclude / shallow-since
 *
 * 该文件既可被 bun:test 复用，也可直接通过
 * `bun run tests/e2e/transport/import-session-shallow-random.ts` 执行。
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

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

type RandomInitialMode = "full" | "depth1";
type RandomFollowupOperation = "deepen" | "shallowExcludeTag" | "shallowSinceReject";
type RandomBoundaryTagMode = "none" | "lightweight" | "annotated";

interface RandomSourceShallowCliComparisonOptions {
  readonly initialMode?: RandomInitialMode;
  readonly followupOperation?: RandomFollowupOperation;
  readonly boundaryTagMode?: RandomBoundaryTagMode;
  readonly strictInitialState?: boolean;
}

interface RepositorySnapshot {
  readonly shallow: readonly string[];
  readonly tags: readonly string[];
  readonly main: string | null;
}

interface RandomSourceShallowCliComparisonResult {
  readonly seed: number;
  readonly matched: boolean;
  readonly mismatchPhase?: "initial" | "followup";
  readonly initialMode: RandomInitialMode;
  readonly followupOperation: RandomFollowupOperation;
  readonly boundaryTagMode: RandomBoundaryTagMode;
  readonly sourceDepth: number;
  readonly historyLength: number;
  readonly boundaryTagName?: string;
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
  readonly options: RandomSourceShallowCliComparisonOptions;
} {
  const seedArgs: string[] = [];
  const options: {
    initialMode?: RandomInitialMode;
    followupOperation?: RandomFollowupOperation;
    boundaryTagMode?: RandomBoundaryTagMode;
  } = {};

  for (const arg of args) {
    if (arg === "--full") {
      options.initialMode = "full";
      continue;
    }
    if (arg === "--depth1") {
      options.initialMode = "depth1";
      continue;
    }
    if (arg === "--deepen") {
      options.followupOperation = "deepen";
      continue;
    }
    if (arg === "--shallow-exclude-tag") {
      options.followupOperation = "shallowExcludeTag";
      continue;
    }
    if (arg === "--shallow-since") {
      options.followupOperation = "shallowSinceReject";
      continue;
    }
    if (arg === "--no-boundary-tag") {
      options.boundaryTagMode = "none";
      continue;
    }
    if (arg === "--lightweight-boundary-tag") {
      options.boundaryTagMode = "lightweight";
      continue;
    }
    if (arg === "--annotated-boundary-tag") {
      options.boundaryTagMode = "annotated";
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

function sortStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function readWorktreeTagNames(workDir: string): string[] {
  const output = git(["tag", "-l", "--format=%(refname)"], workDir);
  return output.length === 0 ? [] : output.split(/\n+/);
}

function readBareTagNames(gitDir: string, cwd: string): string[] {
  const output = git(
    ["--git-dir", gitDir, "for-each-ref", "--format=%(refname)", "refs/tags"],
    cwd,
  );
  return output.length === 0 ? [] : output.split(/\n+/);
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

function sameComparableSnapshot(
  left: RepositorySnapshot,
  right: RepositorySnapshot,
  strictTags = false,
): boolean {
  return (
    JSON.stringify(left.shallow) === JSON.stringify(right.shallow) &&
    left.main === right.main &&
    (!strictTags || JSON.stringify(left.tags) === JSON.stringify(right.tags))
  );
}

async function createRandomSourceShallowRepository(
  tempDir: string,
  seed: number,
  rand: () => number,
  boundaryTagMode: RandomBoundaryTagMode,
): Promise<{
  readonly shallowBareDir: string;
  readonly historyLength: number;
  readonly sourceDepth: number;
  readonly boundaryCommit: string;
  readonly boundaryTagName?: string;
}> {
  const upstreamBareDir = join(tempDir, `source-upstream-${seed}.git`);
  const workDir = join(tempDir, `source-upstream-work-${seed}`);
  const shallowBareDir = join(tempDir, `source-shallow-${seed}.git`);
  const historyLength = 4 + Math.floor(rand() * 4);
  const maxDepth = Math.min(3, historyLength - 1);
  const sourceDepth = 2 + Math.floor(rand() * Math.max(1, maxDepth - 1));
  const commitHashes: string[] = [];

  git(["init", "--bare", "-b", "main", upstreamBareDir], tempDir);
  git(["init", "-b", "main", workDir], tempDir);
  git(["remote", "add", "origin", upstreamBareDir], workDir);

  for (let index = 0; index < historyLength; index++) {
    createFile(workDir, `c${index + 1}.txt`, `c${index + 1}\n`);
    git(["add", `c${index + 1}.txt`], workDir);
    git(["commit", "-m", `c${index + 1}`], workDir);
    commitHashes.push(git(["rev-parse", "HEAD"], workDir));
  }

  const boundaryCommit = commitHashes[historyLength - sourceDepth]!;
  let boundaryTagName: string | undefined;
  if (boundaryTagMode !== "none") {
    boundaryTagName = `boundary-${seed}`;
    if (boundaryTagMode === "annotated") {
      git(["tag", "-a", boundaryTagName, boundaryCommit, "-m", boundaryTagName], workDir);
    } else {
      git(["tag", boundaryTagName, boundaryCommit], workDir);
    }
  }

  const pushArgs = ["push", "-u", "origin", "main"];
  if (boundaryTagName) {
    pushArgs.push(`refs/tags/${boundaryTagName}`);
  }
  git(pushArgs, workDir);
  git(
    ["clone", "--bare", `--depth=${sourceDepth}`, `file://${upstreamBareDir}`, shallowBareDir],
    tempDir,
  );

  return {
    shallowBareDir,
    historyLength,
    sourceDepth,
    boundaryCommit,
    boundaryTagName,
  };
}

async function runInitialClone(
  repo: ReturnType<typeof initRepository>,
  url: string,
  cliDir: string,
  initialMode: RandomInitialMode,
  tempDir: string,
): Promise<void> {
  if (initialMode === "depth1") {
    await gitWithTimeout(
      ["-c", "protocol.version=2", "clone", "--depth=1", url, cliDir],
      tempDir,
      15000,
    );
    await repo.fetch(url, { depth: 1 });
    return;
  }

  await gitWithTimeout(["-c", "protocol.version=2", "clone", url, cliDir], tempDir, 15000);
  await repo.fetch(url);
}

function createFollowupOperation(
  rand: () => number,
  boundaryTagMode: RandomBoundaryTagMode,
  options: RandomSourceShallowCliComparisonOptions,
): RandomFollowupOperation {
  if (options.followupOperation) {
    return options.followupOperation;
  }

  const operations: RandomFollowupOperation[] = ["deepen", "shallowSinceReject"];
  if (boundaryTagMode !== "none") {
    operations.push("shallowExcludeTag");
  }
  return pickRandom(rand, operations);
}

async function runNanoFollowup(
  repo: ReturnType<typeof initRepository>,
  url: string,
  operation: RandomFollowupOperation,
  boundaryTagName?: string,
): Promise<void> {
  switch (operation) {
    case "deepen":
      await repo.fetch(url, { deepen: 1 });
      return;
    case "shallowExcludeTag":
      await repo.fetch(url, { shallowExclude: [boundaryTagName!] });
      return;
    case "shallowSinceReject":
      await repo.fetch(url, { shallowSince: 0 });
      return;
  }
}

async function runCliFollowup(
  cliDir: string,
  operation: RandomFollowupOperation,
  boundaryTagName?: string,
): Promise<void> {
  switch (operation) {
    case "deepen":
      await gitWithTimeout(
        ["-c", "protocol.version=2", "fetch", "--deepen=1", "origin"],
        cliDir,
        15000,
      );
      return;
    case "shallowExcludeTag":
      await gitWithTimeout(
        ["-c", "protocol.version=2", "fetch", `--shallow-exclude=${boundaryTagName!}`, "origin"],
        cliDir,
        15000,
      );
      return;
    case "shallowSinceReject":
      await gitWithTimeout(
        ["-c", "protocol.version=2", "fetch", "--shallow-since=1970-01-01T00:00:00Z", "origin"],
        cliDir,
        15000,
      );
      return;
  }
}

export async function runRandomImportSessionSourceShallowSeed(
  seed: number,
  options: RandomSourceShallowCliComparisonOptions = {},
): Promise<RandomSourceShallowCliComparisonResult> {
  const rand = createSeededRandom(seed);
  const tempDir = createTempDir(`import-shallow-random-${seed}`);
  const cliDir = join(tempDir, "cli");
  const nanoDir = join(tempDir, "nano.git");
  const initialMode = options.initialMode ?? pickRandom(rand, ["full", "depth1"]);
  const boundaryTagMode =
    options.boundaryTagMode ?? pickRandom(rand, ["none", "lightweight", "annotated"]);
  const history = await createRandomSourceShallowRepository(tempDir, seed, rand, boundaryTagMode);
  const followupOperation = createFollowupOperation(rand, boundaryTagMode, options);
  const server = startGitHttpBackendServer(tempDir, `/${basename(history.shallowBareDir)}`);
  const repo = initRepository(nanoDir);

  try {
    await runInitialClone(repo, server.url, cliDir, initialMode, tempDir);

    const initialNano = snapshotNanoRepository(repo, nanoDir, tempDir);
    const initialCli = snapshotCliRepository(cliDir);
    if (
      options.strictInitialState === true &&
      !sameComparableSnapshot(initialNano, initialCli, true)
    ) {
      return {
        seed,
        matched: false,
        mismatchPhase: "initial",
        initialMode,
        followupOperation,
        boundaryTagMode,
        sourceDepth: history.sourceDepth,
        historyLength: history.historyLength,
        boundaryTagName: history.boundaryTagName,
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
      runNanoFollowup(repo, server.url, followupOperation, history.boundaryTagName),
    ]);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliSettled = await Promise.allSettled([
      runCliFollowup(cliDir, followupOperation, history.boundaryTagName),
    ]);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    const finalNano = snapshotNanoRepository(repo, nanoDir, tempDir);
    const finalCli = snapshotCliRepository(cliDir);
    const nanoStatus = nanoSettled[0]!.status;
    const cliStatus = cliSettled[0]!.status;
    const matched =
      nanoStatus === cliStatus &&
      JSON.stringify(nanoBatches) === JSON.stringify(cliBatches) &&
      sameComparableSnapshot(finalNano, finalCli, options.strictInitialState === true);

    return {
      seed,
      matched,
      mismatchPhase: matched ? undefined : "followup",
      initialMode,
      followupOperation,
      boundaryTagMode,
      sourceDepth: history.sourceDepth,
      historyLength: history.historyLength,
      boundaryTagName: history.boundaryTagName,
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

export async function runRandomImportSessionSourceShallowSeeds(
  seeds: readonly number[],
  options: RandomSourceShallowCliComparisonOptions = {},
): Promise<readonly RandomSourceShallowCliComparisonResult[]> {
  const results: RandomSourceShallowCliComparisonResult[] = [];

  for (const seed of seeds) {
    const result = await runRandomImportSessionSourceShallowSeed(seed, options);
    results.push(result);

    if (!result.matched) {
      throw new Error(
        `Random source-shallow CLI comparison mismatch at seed ${seed}:\n` +
          JSON.stringify(result, null, 2),
      );
    }
  }

  return results;
}

if (import.meta.main) {
  const { seeds, options } = parseSeedArguments(process.argv.slice(2));
  const results = await runRandomImportSessionSourceShallowSeeds(seeds, options);
  for (const result of results) {
    console.log(`seed ${result.seed}: ok`);
  }
}
