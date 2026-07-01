/**
 * Virtual Worktree diff 基准脚本
 *
 * 对比两条路径：
 * 1. 当前 `worktree.diff()` 的索引直读路径
 * 2. `rebuildNormalizedChangeIndex()` 的全量快照重建路径
 *
 * 默认覆盖三类典型 workload：
 * - 10k files / 100 changed
 * - 批量 move
 * - 同一路径反复修改
 *
 * 用法：
 * - `bun run examples/worktree-diff-benchmark.ts`
 * - `bun run examples/worktree-diff-benchmark.ts --quick`
 */

import { createMemoryRepository } from "../src/repository/memory.ts";
import { patchTree } from "../src/repository/tree/tree-patch.ts";
import {
  exportVirtualDiffFromChangeRecords,
  rebuildNormalizedChangeIndex,
} from "../src/worktree/engine/change-index.ts";
import { openVirtualWorktree } from "../src/worktree/engine/worktree.ts";
import { createVirtualWorktreeMemoryStateStore } from "../src/worktree/store/memory-backend.ts";

import type { Repository } from "../src/repository/types.ts";
import type { SHA1 } from "../src/types/index.ts";
import type { VirtualWorktree } from "../src/worktree/core.ts";
import type { VirtualWorktreeStateStore } from "../src/worktree/store/state-store.ts";

interface BenchOptions {
  readonly quick: boolean;
}

interface ScenarioRuntime {
  readonly repo: Repository;
  readonly state: VirtualWorktreeStateStore;
  readonly worktree: VirtualWorktree;
  readonly changedPathCount: number;
}

interface ScenarioDefinition {
  readonly name: string;
  readonly indexedIterations: number;
  readonly baselineIterations: number;
  readonly setup: () => ScenarioRuntime;
}

interface BenchStats {
  readonly iterations: number;
  readonly totalMs: number;
  readonly averageMs: number;
}

interface BenchResult {
  readonly scenario: string;
  readonly indexed: BenchStats;
  readonly baseline: BenchStats;
  readonly diffEntryCount: number;
  readonly changeRecordCount: number;
  readonly changedPathCount: number;
}

const options = readBenchOptions();
const scenarios = createScenarioDefinitions(options);

console.log("=== Virtual Worktree diff benchmark ===");
console.log(`模式: ${options.quick ? "quick" : "full"}`);
console.log("");

const results = scenarios.map(runScenarioBenchmark);
console.table(
  results.map((result) => ({
    场景: result.scenario,
    变更路径: result.changedPathCount,
    diff条目: result.diffEntryCount,
    变更记录: result.changeRecordCount,
    "索引直读均值(ms)": formatMs(result.indexed.averageMs),
    "全量重建均值(ms)": formatMs(result.baseline.averageMs),
    倍数: formatRatio(result.baseline.averageMs / result.indexed.averageMs),
  })),
);

function readBenchOptions(): BenchOptions {
  return {
    quick: Bun.argv.includes("--quick"),
  };
}

function createScenarioDefinitions(options: BenchOptions): readonly ScenarioDefinition[] {
  if (options.quick) {
    return [
      {
        name: "大树小改动（2k / 20）",
        indexedIterations: 400,
        baselineIterations: 12,
        setup: () => setupLargeTreeSmallChangeScenario(2_000, 20),
      },
      {
        name: "批量 move（2k / 200）",
        indexedIterations: 300,
        baselineIterations: 10,
        setup: () => setupBatchRenameScenario(2_000, 200),
      },
      {
        name: "重复改写同一路径（2k / 200 次）",
        indexedIterations: 1_200,
        baselineIterations: 24,
        setup: () => setupRepeatedModifyScenario(2_000, 200),
      },
    ];
  }

  return [
    {
      name: "大树小改动（10k / 100）",
      indexedIterations: 500,
      baselineIterations: 16,
      setup: () => setupLargeTreeSmallChangeScenario(10_000, 100),
    },
    {
      name: "批量 move（10k / 1k）",
      indexedIterations: 400,
      baselineIterations: 12,
      setup: () => setupBatchRenameScenario(10_000, 1_000),
    },
    {
      name: "重复改写同一路径（10k / 500 次）",
      indexedIterations: 1_500,
      baselineIterations: 30,
      setup: () => setupRepeatedModifyScenario(10_000, 500),
    },
  ];
}

function runScenarioBenchmark(definition: ScenarioDefinition): BenchResult {
  const runtime = definition.setup();
  const indexedDiff = runtime.worktree.diff();
  const baselineDiff = computeBaselineDiff(runtime.repo, runtime.state);
  assertDiffParity(definition.name, indexedDiff, baselineDiff);

  warmup(() => runtime.worktree.diff(), 10);
  warmup(() => computeBaselineDiff(runtime.repo, runtime.state), 2);

  const indexed = measure(() => runtime.worktree.diff(), definition.indexedIterations);
  const baseline = measure(
    () => computeBaselineDiff(runtime.repo, runtime.state),
    definition.baselineIterations,
  );

  return {
    scenario: definition.name,
    indexed,
    baseline,
    diffEntryCount: indexedDiff.length,
    changeRecordCount: runtime.state.listChangeRecords().length,
    changedPathCount: runtime.changedPathCount,
  };
}

function setupLargeTreeSmallChangeScenario(
  totalFiles: number,
  changedFiles: number,
): ScenarioRuntime {
  const { repo, paths, worktree, state } = createBaseWorktree(totalFiles);
  for (const [index, path] of selectSpreadPaths(paths, changedFiles).entries()) {
    worktree.writeFile(path, Buffer.from(`changed:${index}:${path}\n`));
  }
  return {
    repo,
    state,
    worktree,
    changedPathCount: changedFiles,
  };
}

function setupBatchRenameScenario(totalFiles: number, renameCount: number): ScenarioRuntime {
  const { repo, paths, worktree, state } = createBaseWorktree(totalFiles);
  for (const path of selectSpreadPaths(paths, renameCount)) {
    const target = path.replace("/file-", "/renamed-");
    worktree.move(path, target);
  }
  return {
    repo,
    state,
    worktree,
    changedPathCount: renameCount,
  };
}

function setupRepeatedModifyScenario(totalFiles: number, rewriteCount: number): ScenarioRuntime {
  const { repo, paths, worktree, state } = createBaseWorktree(totalFiles);
  const targetPath = paths[Math.floor(paths.length / 2)];
  if (targetPath === undefined) {
    throw new Error("Repeated modify scenario requires at least one base path");
  }
  for (let index = 0; index < rewriteCount; index += 1) {
    worktree.writeFile(targetPath, Buffer.from(`rewrite:${index}\n`));
  }
  return {
    repo,
    state,
    worktree,
    changedPathCount: 1,
  };
}

function createBaseWorktree(totalFiles: number): {
  readonly repo: Repository;
  readonly baseTree: SHA1;
  readonly paths: readonly string[];
  readonly state: VirtualWorktreeStateStore;
  readonly worktree: VirtualWorktree;
} {
  const repo = createMemoryRepository();
  const rootTree = repo.createTree([]);
  const paths = createFixturePaths(totalFiles);
  const ops = paths.map((path, index) => ({
    op: "upsert",
    path,
    mode: "100644",
    hash: repo.writeBlob(Buffer.from(`base:${index}:${path}\n`)),
  })) satisfies Parameters<typeof patchTree>[2];
  const baseTree = patchTree(repo.objects, rootTree, ops).rootHash;
  const state = createVirtualWorktreeMemoryStateStore(baseTree);
  const worktree = openVirtualWorktree(repo.objects, state);

  return {
    repo,
    baseTree,
    paths,
    state,
    worktree,
  };
}

function createFixturePaths(totalFiles: number): readonly string[] {
  const paths: string[] = [];
  for (let index = 0; index < totalFiles; index += 1) {
    const dir = `dir-${String(Math.floor(index / 100)).padStart(4, "0")}`;
    const path = `${dir}/file-${String(index).padStart(6, "0")}.txt`;
    paths.push(path);
  }
  return paths;
}

function selectSpreadPaths(paths: readonly string[], count: number): readonly string[] {
  if (count >= paths.length) {
    return [...paths];
  }

  const out: string[] = [];
  const step = paths.length / count;
  for (let index = 0; index < count; index += 1) {
    const path = paths[Math.floor(index * step)];
    if (path === undefined) {
      continue;
    }
    out.push(path);
  }
  return out;
}

function computeBaselineDiff(repo: Repository, state: VirtualWorktreeStateStore) {
  return exportVirtualDiffFromChangeRecords(rebuildNormalizedChangeIndex(repo.objects, state));
}

function assertDiffParity(
  scenarioName: string,
  indexedDiff: ReturnType<VirtualWorktree["diff"]>,
  baselineDiff: ReturnType<typeof computeBaselineDiff>,
): void {
  const indexedJson = JSON.stringify(indexedDiff);
  const baselineJson = JSON.stringify(baselineDiff);
  if (indexedJson !== baselineJson) {
    throw new Error(`Benchmark scenario '${scenarioName}' produced divergent diff results`);
  }
}

function warmup(fn: () => unknown, iterations: number): void {
  for (let index = 0; index < iterations; index += 1) {
    fn();
  }
}

function measure(fn: () => unknown, iterations: number): BenchStats {
  const startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    fn();
  }
  const totalMs = performance.now() - startedAt;
  return {
    iterations,
    totalMs,
    averageMs: totalMs / iterations,
  };
}

function formatMs(ms: number): string {
  return ms.toFixed(ms >= 10 ? 2 : 3);
}

function formatRatio(ratio: number): string {
  return `${ratio.toFixed(1)}x`;
}
