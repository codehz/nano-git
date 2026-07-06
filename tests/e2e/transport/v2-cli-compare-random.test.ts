/**
 * v2 fetch 随机 git CLI 对照回归
 */

import { describe, test } from "bun:test";

import { runRandomV2CliComparisonSeeds } from "./v2-cli-compare-random.ts";

describe.skip("v2 协议 - 随机 git CLI 对照", () => {
  test("代表性随机 seed 的 fetch 请求序列与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([7, 45, 83, 121, 173]);
  });

  test("带 annotated tag 的随机 seed 请求序列与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([19, 63, 107], { includeTags: true });
  });

  test("带远端 tag 且 no-tags 的随机 seed 请求序列与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([19, 63, 107], {
      includeTags: true,
      noTags: true,
    });
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

  test("带 tag alias burst、mixed tags 与 ref alias 且 no-tags 的随机 seed 请求序列与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([2217, 2286, 2344], {
      includeTagAliases: true,
      includeLightweightTags: true,
      includeRefAliases: true,
      includeTags: true,
      noTags: true,
    });
  });

  test("带 tag alias burst、mixed tags、ref alias 与 orphan 分支的随机 seed 请求序列与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([2363, 2421, 2488, 2501], {
      includeTagAliases: true,
      includeLightweightTags: true,
      includeOrphans: true,
      includeRefAliases: true,
      includeTags: true,
    });
  });

  test("默认 repo.fetch() 在 mixed tags 与 ref alias 场景下的请求序列与 tag 状态与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([2603, 2671, 2737, 3482, 3501], {
      defaultFetch: true,
      includeTagAliases: true,
      includeLightweightTags: true,
      includeRefAliases: true,
      includeTags: true,
    });
  });

  test("默认 repo.fetch() 在 mixed tags、ref alias 与 orphan 分支场景下的请求序列与 tag 状态与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([3801, 3841, 3879], {
      defaultFetch: true,
      includeTagAliases: true,
      includeLightweightTags: true,
      includeOrphans: true,
      includeRefAliases: true,
      includeTags: true,
    });
  });

  test("默认 repo.fetch() 在 lightweight tag 主导场景下的请求序列与 tag 状态与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([3881, 3917, 3953], {
      defaultFetch: true,
      includeLightweightTags: true,
      includeTags: true,
    });
  });

  test("默认 repo.fetch() + no-tags 在带远端 tags 场景下的请求序列与 tag 状态与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([19, 63, 107], {
      defaultFetch: true,
      includeTags: true,
      noTags: true,
    });
  });

  test("repo.fetch({ refPatterns: [heads] }) 在 mixed tags、ref alias 与 orphan 分支场景下的请求序列与 tag 状态与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([1462, 2217, 3801], {
      explicitHeadPatterns: true,
      includeTagAliases: true,
      includeLightweightTags: true,
      includeOrphans: true,
      includeRefAliases: true,
      includeTags: true,
    });
  });

  test("repo.fetch({ refSpecs: [heads] }) 在 mixed tags、ref alias 与 orphan 分支场景下的请求序列与 refs/tag 状态与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([1462, 2217, 3801], {
      explicitHeadRefSpecs: true,
      includeTagAliases: true,
      includeLightweightTags: true,
      includeOrphans: true,
      includeRefAliases: true,
      includeTags: true,
    });
  });

  test("repo.fetch({ refPatterns: [heads, tags] }) 在 mixed tags、ref alias 与 orphan 分支场景下的请求序列与 tag 状态与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([1462, 2217, 3801, 4281], {
      explicitTagPatterns: true,
      includeTagAliases: true,
      includeLightweightTags: true,
      includeOrphans: true,
      includeRefAliases: true,
      includeTags: true,
    });
  });

  test("repo.fetch({ refSpecs: [heads, tags] }) 在 mixed tags、ref alias 与 orphan 分支场景下的请求序列与 refs 状态与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([1462, 2217, 3801], {
      explicitTagRefSpecs: true,
      includeTagAliases: true,
      includeLightweightTags: true,
      includeOrphans: true,
      includeRefAliases: true,
      includeTags: true,
    });
  });

  test("repo.fetch({ refPatterns: [tags] }) 在 mixed tags、ref alias 与 orphan 分支场景下的请求序列与 refs/tag 状态与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([1462, 2217, 3801, 4281], {
      explicitTagOnlyPatterns: true,
      includeTagAliases: true,
      includeLightweightTags: true,
      includeOrphans: true,
      includeRefAliases: true,
      includeTags: true,
    });
  });

  test("repo.fetch({ refSpecs: [tags] }) 在 mixed tags、ref alias 与 orphan 分支场景下的请求序列与 refs 状态与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([1462, 2217, 3801], {
      explicitTagOnlyRefSpecs: true,
      includeTagAliases: true,
      includeLightweightTags: true,
      includeOrphans: true,
      includeRefAliases: true,
      includeTags: true,
    });
  });

  test("repo.fetch({ noTags: true, refPatterns: [tags] }) 在 mixed tags、ref alias 与 orphan 分支场景下的请求序列与 refs/tag 状态与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([1462, 2217, 3801, 4281], {
      explicitTagOnlyPatterns: true,
      includeTagAliases: true,
      includeLightweightTags: true,
      includeOrphans: true,
      includeRefAliases: true,
      includeTags: true,
      noTags: true,
    });
  });

  test("repo.fetch({ noTags: true, refPatterns: [heads, tags] }) 在 mixed tags、ref alias 与 orphan 分支场景下的请求序列与 refs/tag 状态与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([1462, 2217, 3801, 4281], {
      explicitTagPatterns: true,
      includeTagAliases: true,
      includeLightweightTags: true,
      includeOrphans: true,
      includeRefAliases: true,
      includeTags: true,
      noTags: true,
    });
  });

  test("repo.fetch({ noTags: true, refSpecs: [tags] }) 在 mixed tags、ref alias 与 orphan 分支场景下的请求语义与 refs 状态与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([1462, 2217, 3801], {
      explicitTagOnlyRefSpecs: true,
      includeTagAliases: true,
      includeLightweightTags: true,
      includeOrphans: true,
      includeRefAliases: true,
      includeTags: true,
      noTags: true,
    });
  });

  test("repo.fetch({ noTags: true, refSpecs: [heads, tags] }) 在 mixed tags、ref alias 与 orphan 分支场景下的请求序列与 refs 状态与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([1462, 2217, 3801], {
      explicitTagRefSpecs: true,
      includeTagAliases: true,
      includeLightweightTags: true,
      includeOrphans: true,
      includeRefAliases: true,
      includeTags: true,
      noTags: true,
    });
  });

  test("协商压力模式下默认 heads fetch 请求序列与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([4003, 4051, 4129], {
      negotiationStress: true,
    });
  });

  test("协商压力模式下 default repo.fetch() 的请求序列与 tag 状态与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([4201, 4273, 4349], {
      defaultFetch: true,
      includeTagAliases: true,
      includeLightweightTags: true,
      includeOrphans: true,
      includeRefAliases: true,
      includeTags: true,
      negotiationStress: true,
    });
  });

  test("协商压力模式下 default repo.fetch() + no-tags 的请求序列与 tag 状态与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([5011, 5031, 5071], {
      defaultFetch: true,
      includeTagAliases: true,
      includeLightweightTags: true,
      includeOrphans: true,
      includeRefAliases: true,
      includeTags: true,
      noTags: true,
      negotiationStress: true,
    });
  });

  test("协商压力模式下显式 heads-only refPatterns 的请求序列与 tag 状态与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([4921, 4941, 4981], {
      explicitHeadPatterns: true,
      includeTagAliases: true,
      includeLightweightTags: true,
      includeOrphans: true,
      includeRefAliases: true,
      includeTags: true,
      negotiationStress: true,
    });
  });

  test("协商压力模式下显式 heads-only refspec 的请求序列与 refs/tag 状态与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([4409, 4481, 4547], {
      explicitHeadRefSpecs: true,
      includeTagAliases: true,
      includeLightweightTags: true,
      includeOrphans: true,
      includeRefAliases: true,
      includeTags: true,
      negotiationStress: true,
    });
  });

  test("协商压力模式下显式 heads+tags refPatterns 的请求序列与 tag 状态与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([4921, 4941, 4981], {
      explicitTagPatterns: true,
      includeTagAliases: true,
      includeLightweightTags: true,
      includeOrphans: true,
      includeRefAliases: true,
      includeTags: true,
      negotiationStress: true,
    });
  });

  test("协商压力模式下显式 tag-only refPatterns 的请求语义与 refs/tag 状态与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([4921, 4941, 4981], {
      explicitTagOnlyPatterns: true,
      includeTagAliases: true,
      includeLightweightTags: true,
      includeOrphans: true,
      includeRefAliases: true,
      includeTags: true,
      negotiationStress: true,
      relaxedHaveComparison: true,
    });
  });

  test("协商压力模式下显式 tag-only refspec 的请求语义与 refs 状态与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([4409, 4417, 4481, 4547], {
      explicitTagOnlyRefSpecs: true,
      includeTagAliases: true,
      includeLightweightTags: true,
      includeOrphans: true,
      includeRefAliases: true,
      includeTags: true,
      negotiationStress: true,
      relaxedHaveComparison: true,
    });
  });

  test("协商压力模式下 noTags + 显式 tag-only refPatterns 的请求序列与 refs/tag 状态与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([4921, 4941, 4981], {
      explicitTagOnlyPatterns: true,
      includeTagAliases: true,
      includeLightweightTags: true,
      includeOrphans: true,
      includeRefAliases: true,
      includeTags: true,
      noTags: true,
      negotiationStress: true,
    });
  });

  test("协商压力模式下 noTags + 显式 tag-only refspec 的请求语义与 refs 状态与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([4409, 4417, 4481, 4547], {
      explicitTagOnlyRefSpecs: true,
      includeTagAliases: true,
      includeLightweightTags: true,
      includeOrphans: true,
      includeRefAliases: true,
      includeTags: true,
      noTags: true,
      negotiationStress: true,
      relaxedHaveComparison: true,
    });
  });

  test("协商压力模式下 noTags + 显式 heads+tags refPatterns 的请求序列与 refs/tag 状态与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([4921, 4941, 4981], {
      explicitTagPatterns: true,
      includeTagAliases: true,
      includeLightweightTags: true,
      includeOrphans: true,
      includeRefAliases: true,
      includeTags: true,
      noTags: true,
      negotiationStress: true,
    });
  });

  test("协商压力模式下 noTags + 显式 heads+tags refspec 的请求序列与 refs 状态与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([4921, 4941, 4981], {
      explicitTagRefSpecs: true,
      includeTagAliases: true,
      includeLightweightTags: true,
      includeOrphans: true,
      includeRefAliases: true,
      includeTags: true,
      noTags: true,
      negotiationStress: true,
    });
  });

  test("协商压力模式下显式 heads+tags refspec 的请求序列与 refs 状态与 git CLI 一致", async () => {
    await runRandomV2CliComparisonSeeds([4409, 4481, 4547], {
      explicitTagRefSpecs: true,
      includeTagAliases: true,
      includeLightweightTags: true,
      includeOrphans: true,
      includeRefAliases: true,
      includeTags: true,
      negotiationStress: true,
    });
  });
});
