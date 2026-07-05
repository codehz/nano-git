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
  readonly nanoTags: readonly string[];
  readonly cliTags: readonly string[];
}

interface RandomCliComparisonOptions {
  readonly includeTags?: boolean;
  readonly includeLightweightTags?: boolean;
  readonly includeTagAliases?: boolean;
  readonly includeOrphans?: boolean;
  readonly includeRefAliases?: boolean;
  readonly noTags?: boolean;
}

interface RandomCliBranchState {
  readonly name: string;
  readonly family: string;
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

async function cloneGitCli(
  url: string,
  localDir: string,
  tempDir: string,
  options: RandomCliComparisonOptions = {},
) {
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
  if (options.includeTags && !options.noTags) {
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
    noTags?: boolean;
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
    if (arg === "--no-tags") {
      options.noTags = true;
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

    const mergeableBranches = () => branches;
    const allBranchNames = () => branches.map((branch) => branch.name);
    const mergeableBranchNames = () => mergeableBranches().map((branch) => branch.name);
    const findBranch = (branchName: string) =>
      branches.find((branch) => branch.name === branchName)!;

    const preOps = 12 + Math.floor(rand() * 10);
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

      if (branches.length < 5 && opRoll < 0.28) {
        const base = pickRandom(rand, allBranchNames());
        const branch = `topic-${index}`;
        git(["checkout", base], workDir);
        git(["checkout", "-b", branch], workDir);
        branches.push({ name: branch, family: findBranch(base).family });
        commitFile(workDir, branch, serial++);
        git(["push", "-u", serverRepoDir, branch], workDir);
        continue;
      }

      if (options.includeRefAliases && branches.length < 6 && opRoll < 0.34) {
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

      if (mergeableBranches().length > 1 && opRoll < 0.5) {
        const target = rand() < 0.6 ? "main" : pickRandom(rand, mergeableBranchNames());
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
    const nanoRepo = options.noTags
      ? await cloneNanoWithNoTags(url, join(tempDir, "nano"))
      : options.includeTags
        ? await cloneNanoHeadsAndTags(url, join(tempDir, "nano"))
        : await cloneNanoHeads(url, join(tempDir, "nano"));
    const cliDir = join(tempDir, "cli");
    await cloneGitCli(url, cliDir, tempDir, options);

    const postOps = 4 + Math.floor(rand() * 5);
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

      if (mergeableBranches().length > 1 && opRoll < 0.4) {
        const target = rand() < 0.55 ? "main" : pickRandom(rand, mergeableBranchNames());
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

      if (branches.length < 6 && opRoll < 0.52) {
        const base = pickRandom(rand, allBranchNames());
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

    server.clearRequests();
    const nanoResult = options.noTags
      ? await fetchNanoWithNoTags(nanoRepo, url)
      : options.includeTags
        ? await fetchNanoHeadsAndTags(nanoRepo, url)
        : await fetchNanoHeads(nanoRepo, url);
    if ("canApply" in nanoResult && !nanoResult.canApply) {
      throw new Error(`Random CLI comparison seed ${seed} produced non-applicable preview`);
    }
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await fetchGitCli(cliDir, options);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);
    const nanoTags = git(
      ["--git-dir", join(tempDir, "nano"), "for-each-ref", "--format=%(refname)", "refs/tags"],
      tempDir,
    )
      .split("\n")
      .filter((line) => line.length > 0);
    const cliTags = git(["for-each-ref", "--format=%(refname)", "refs/tags"], cliDir)
      .split("\n")
      .filter((line) => line.length > 0);
    const matched =
      JSON.stringify(nanoBatches) === JSON.stringify(cliBatches) &&
      (options.noTags !== true || JSON.stringify(nanoTags) === JSON.stringify(cliTags));

    return {
      seed,
      matched,
      nanoBatches,
      cliBatches,
      branches: allBranchNames(),
      nanoTags,
      cliTags,
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
              nanoTags: result.nanoTags,
              cliTags: result.cliTags,
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
