/**
 * v2 fetch 随机 git CLI 对照回归
 */

import { describe, test } from "bun:test";

import { runRandomV2CliComparisonSeeds } from "./v2-cli-compare-random.ts";

describe("v2 协议 - 随机 git CLI 对照", () => {
  test("代表性随机 seed 的 fetch 请求序列与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([7, 45, 83, 121, 173]);
  });

  test("带 annotated tag 的随机 seed 请求序列与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([19, 63, 107], { includeTags: true });
  });

  test("带 orphan 分支的随机 seed 请求序列与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([23, 71, 149], { includeOrphans: true });
  });

  test("同时带 annotated tag 与 orphan 分支的随机 seed 请求序列与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([601, 643, 689], {
      includeOrphans: true,
      includeTags: true,
    });
  });

  test("混合 lightweight tag 与 annotated tag 的随机 seed 请求序列与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([704, 787, 863], {
      includeLightweightTags: true,
      includeTags: true,
    });
  });

  test("混合 lightweight tag、annotated tag 与 orphan 分支的随机 seed 请求序列与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([863, 905, 947], {
      includeLightweightTags: true,
      includeOrphans: true,
      includeTags: true,
    });
  });

  test("带 ref alias 的随机 seed 请求序列与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([1325, 1387, 1446], {
      includeRefAliases: true,
    });
  });

  test("带 ref alias 与 annotated tag 的随机 seed 请求序列与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([1462, 1498, 1541], {
      includeRefAliases: true,
      includeTags: true,
    });
  });

  test("带 ref alias、mixed tags 与 orphan 分支的随机 seed 请求序列与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([1566, 1608, 1647], {
      includeRefAliases: true,
      includeLightweightTags: true,
      includeOrphans: true,
      includeTags: true,
    });
  });

  test("带 tag alias burst 的随机 seed 请求序列与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([2073, 2134, 2198], {
      includeTagAliases: true,
      includeTags: true,
    });
  });

  test("带 tag alias burst、mixed tags 与 ref alias 的随机 seed 请求序列与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([2217, 2286, 2344], {
      includeTagAliases: true,
      includeLightweightTags: true,
      includeRefAliases: true,
      includeTags: true,
    });
  });

  test("带 tag alias burst、mixed tags、ref alias 与 orphan 分支的随机 seed 请求序列与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([2363, 2421, 2488], {
      includeTagAliases: true,
      includeLightweightTags: true,
      includeOrphans: true,
      includeRefAliases: true,
      includeTags: true,
    });
  });
});
