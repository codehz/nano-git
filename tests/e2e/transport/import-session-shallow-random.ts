/**
 * source-shallow 场景下 repo.fetch() 与 git CLI 的随机对照
 *
 * 目标是扩大以下高风险组合的真实对照覆盖：
 * - 源仓库自身是 shallow
 * - 初始 clone 为完整 / depth=1
 * - 边界带 lightweight / annotated tag
 * - 后续执行 deepen / shallow-exclude / shallow-since / unshallow
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
type RandomFollowupOperation =
  | "depth1"
  | "deepen"
  | "shallowExcludeTag"
  | "shallowSinceReject"
  | "futureShallowSince"
  | "unshallow";
type RandomBoundaryTagMode = "none" | "lightweight" | "annotated";
type RandomHistoryShape = "linear" | "merge";

interface RandomSourceShallowCliComparisonOptions {
  readonly initialMode?: RandomInitialMode;
  readonly followupOperation?: RandomFollowupOperation;
  readonly boundaryTagMode?: RandomBoundaryTagMode;
  readonly historyShape?: RandomHistoryShape;
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
  readonly historyShape: RandomHistoryShape;
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
  readonly futureShallowSince?: number;
}

const FUTURE_SHALLOW_SINCE_SAMPLES = [
  4_102_444_800, 4_102_444_801, 4_102_448_400, 4_102_531_200, 4_294_967_295, 4_294_967_296,
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

function parseSeedArguments(args: readonly string[]): {
  readonly seeds: number[];
  readonly options: RandomSourceShallowCliComparisonOptions;
} {
  const seedArgs: string[] = [];
  const options: {
    initialMode?: RandomInitialMode;
    followupOperation?: RandomFollowupOperation;
    boundaryTagMode?: RandomBoundaryTagMode;
    historyShape?: RandomHistoryShape;
    strictInitialState?: boolean;
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
    if (arg === "--depth1") {
      options.followupOperation = "depth1";
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
    if (arg === "--future-shallow-since") {
      options.followupOperation = "futureShallowSince";
      continue;
    }
    if (arg === "--unshallow") {
      options.followupOperation = "unshallow";
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

function readBareShallowSync(gitDir: string): string[] {
  const shallowPath = join(gitDir, "shallow");
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
  historyShape: RandomHistoryShape,
): Promise<{
  readonly shallowBareDir: string;
  readonly historyLength: number;
  readonly sourceDepth: number;
  readonly boundaryCommit: string;
  readonly boundaryTagName?: string;
}> {
  if (historyShape === "merge") {
    return createRandomMergeSourceShallowRepository(tempDir, seed, rand, boundaryTagMode);
  }

  return createRandomLinearSourceShallowRepository(tempDir, seed, rand, boundaryTagMode);
}

async function createRandomLinearSourceShallowRepository(
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

async function createRandomMergeSourceShallowRepository(
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
  const baseCommitCount = 3 + Math.floor(rand() * 2);
  const topicCommitCount = 2 + Math.floor(rand() * 2);
  const mainAdvanceCount = 1 + Math.floor(rand() * 2);
  const sourceDepth = 3;

  git(["init", "--bare", "-b", "main", upstreamBareDir], tempDir);
  git(["init", "-b", "main", workDir], tempDir);
  git(["remote", "add", "origin", upstreamBareDir], workDir);

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
  const topicBoundaryCommit = git(["rev-parse", "HEAD"], workDir);

  git(["checkout", "main"], workDir);
  for (let index = 0; index < mainAdvanceCount; index++) {
    createFile(workDir, `main-advance-${index + 1}.txt`, `main-advance-${index + 1}\n`);
    git(["add", `main-advance-${index + 1}.txt`], workDir);
    git(["commit", "-m", `main-advance-${index + 1}`], workDir);
  }
  const mainBoundaryCommit = git(["rev-parse", "HEAD"], workDir);

  const boundaryCommit = rand() < 0.5 ? topicBoundaryCommit : mainBoundaryCommit;
  let boundaryTagName: string | undefined;
  if (boundaryTagMode !== "none") {
    boundaryTagName = `boundary-${seed}`;
    if (boundaryTagMode === "annotated") {
      git(["tag", "-a", boundaryTagName, boundaryCommit, "-m", boundaryTagName], workDir);
    } else {
      git(["tag", boundaryTagName, boundaryCommit], workDir);
    }
  }

  git(["merge", "--no-ff", "topic", "-m", `merge-topic-${seed}`], workDir);
  createFile(workDir, "tail-after-merge.txt", "tail-after-merge\n");
  git(["add", "tail-after-merge.txt"], workDir);
  git(["commit", "-m", "tail-after-merge"], workDir);

  const pushArgs = ["push", "-u", "origin", "main", "topic"];
  if (boundaryTagName) {
    pushArgs.push(`refs/tags/${boundaryTagName}`);
  }
  git(pushArgs, workDir);
  git(
    ["clone", "--bare", `--depth=${sourceDepth}`, `file://${upstreamBareDir}`, shallowBareDir],
    tempDir,
  );

  const shallowEntries = readBareShallowSync(shallowBareDir);
  if (!shallowEntries.includes(boundaryCommit)) {
    throw new Error(
      `merge source-shallow seed ${seed} did not preserve expected boundary tag target`,
    );
  }

  return {
    shallowBareDir,
    historyLength: baseCommitCount + topicCommitCount + mainAdvanceCount + 2,
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

  const operations: RandomFollowupOperation[] = [
    "depth1",
    "deepen",
    "shallowSinceReject",
    "futureShallowSince",
    "unshallow",
  ];
  if (boundaryTagMode !== "none") {
    operations.push("shallowExcludeTag");
  }
  return pickRandom(rand, operations);
}

function readCliMaxAge(workDir: string, shallowSince: number): string {
  return git(["rev-parse", `--since=@${shallowSince}`], workDir).replace("--max-age=", "");
}

function withoutDeepenSince(batch: readonly string[]): string[] {
  return batch.filter((line) => !line.startsWith("deepen-since "));
}

function findDeepenSince(batch: readonly string[]): string | undefined {
  return batch.find((line) => line.startsWith("deepen-since "));
}

function futureShallowSinceMatchesCliWindow(params: {
  readonly nanoBatches: readonly string[][];
  readonly cliBatches: readonly string[][];
  readonly beforeNanoMaxAge: string;
  readonly afterNanoMaxAge: string;
  readonly beforeCliMaxAge: string;
  readonly afterCliMaxAge: string;
}): boolean {
  if (params.nanoBatches.length !== 1 || params.cliBatches.length !== 1) {
    return false;
  }

  const nanoBatch = params.nanoBatches[0]!;
  const cliBatch = params.cliBatches[0]!;
  if (
    JSON.stringify(withoutDeepenSince(nanoBatch)) !== JSON.stringify(withoutDeepenSince(cliBatch))
  ) {
    return false;
  }

  const nanoDeepenSince = findDeepenSince(nanoBatch);
  const cliDeepenSince = findDeepenSince(cliBatch);
  return (
    nanoDeepenSince !== undefined &&
    cliDeepenSince !== undefined &&
    [params.beforeNanoMaxAge, params.afterNanoMaxAge].includes(
      nanoDeepenSince.slice("deepen-since ".length),
    ) &&
    [params.beforeCliMaxAge, params.afterCliMaxAge].includes(
      cliDeepenSince.slice("deepen-since ".length),
    )
  );
}

async function runNanoFollowup(
  repo: ReturnType<typeof initRepository>,
  url: string,
  operation: RandomFollowupOperation,
  boundaryTagName?: string,
  futureShallowSince?: number,
): Promise<void> {
  switch (operation) {
    case "depth1":
      await repo.fetch(url, { depth: 1 });
      return;
    case "deepen":
      await repo.fetch(url, { deepen: 1 });
      return;
    case "shallowExcludeTag":
      await repo.fetch(url, { shallowExclude: [boundaryTagName!] });
      return;
    case "shallowSinceReject":
      await repo.fetch(url, { shallowSince: 0 });
      return;
    case "futureShallowSince":
      await repo.fetch(url, { shallowSince: futureShallowSince! });
      return;
    case "unshallow":
      await repo.fetch(url, { unshallow: true });
      return;
  }
}

async function runCliFollowup(
  cliDir: string,
  operation: RandomFollowupOperation,
  boundaryTagName?: string,
  futureShallowSince?: number,
): Promise<void> {
  switch (operation) {
    case "depth1":
      await gitWithTimeout(
        ["-c", "protocol.version=2", "fetch", "--depth=1", "origin"],
        cliDir,
        15000,
      );
      return;
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
    case "futureShallowSince":
      await gitWithTimeout(
        ["-c", "protocol.version=2", "fetch", `--shallow-since=@${futureShallowSince!}`, "origin"],
        cliDir,
        15000,
      );
      return;
    case "unshallow":
      await gitWithTimeout(
        ["-c", "protocol.version=2", "fetch", "--unshallow", "origin"],
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
  const historyShape = options.historyShape ?? "linear";
  const history = await createRandomSourceShallowRepository(
    tempDir,
    seed,
    rand,
    boundaryTagMode,
    historyShape,
  );
  const followupOperation = createFollowupOperation(rand, boundaryTagMode, options);
  const futureShallowSince =
    followupOperation === "futureShallowSince"
      ? pickRandom(rand, FUTURE_SHALLOW_SINCE_SAMPLES)
      : undefined;
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
        historyShape,
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
        futureShallowSince,
      };
    }

    server.clearRequests();
    const beforeNanoMaxAge =
      futureShallowSince !== undefined ? readCliMaxAge(cliDir, futureShallowSince) : undefined;
    const nanoSettled = await Promise.allSettled([
      runNanoFollowup(
        repo,
        server.url,
        followupOperation,
        history.boundaryTagName,
        futureShallowSince,
      ),
    ]);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);
    const afterNanoMaxAge =
      futureShallowSince !== undefined ? readCliMaxAge(cliDir, futureShallowSince) : undefined;

    server.clearRequests();
    const beforeCliMaxAge =
      futureShallowSince !== undefined ? readCliMaxAge(cliDir, futureShallowSince) : undefined;
    const cliSettled = await Promise.allSettled([
      runCliFollowup(cliDir, followupOperation, history.boundaryTagName, futureShallowSince),
    ]);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);
    const afterCliMaxAge =
      futureShallowSince !== undefined ? readCliMaxAge(cliDir, futureShallowSince) : undefined;

    const finalNano = snapshotNanoRepository(repo, nanoDir, tempDir);
    const finalCli = snapshotCliRepository(cliDir);
    const nanoStatus = nanoSettled[0]!.status;
    const cliStatus = cliSettled[0]!.status;
    const matched =
      nanoStatus === cliStatus &&
      (futureShallowSince === undefined
        ? JSON.stringify(nanoBatches) === JSON.stringify(cliBatches)
        : futureShallowSinceMatchesCliWindow({
            nanoBatches,
            cliBatches,
            beforeNanoMaxAge: beforeNanoMaxAge!,
            afterNanoMaxAge: afterNanoMaxAge!,
            beforeCliMaxAge: beforeCliMaxAge!,
            afterCliMaxAge: afterCliMaxAge!,
          })) &&
      sameComparableSnapshot(finalNano, finalCli, options.strictInitialState === true);

    return {
      seed,
      matched,
      mismatchPhase: matched ? undefined : "followup",
      initialMode,
      followupOperation,
      boundaryTagMode,
      historyShape,
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
      futureShallowSince,
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
