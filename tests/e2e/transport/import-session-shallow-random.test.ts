/**
 * source-shallow 随机 git CLI 对照回归
 */

import { describe, test } from "bun:test";

import { runRandomImportSessionSourceShallowSeeds } from "./import-session-shallow-random.ts";

describe("Import Session - source-shallow 随机 git CLI 对照", () => {
  test("默认随机 operation/history/boundary 组合与 git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([241, 277, 313], {
      strictInitialState: true,
    });
  });

  test("完整 clone 后 depth=1 的行为与 git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([9, 21, 33], {
      initialMode: "full",
      followupOperation: "depth1",
      strictInitialState: true,
    });
  });

  test("完整 clone 后 deepen=1 的请求序列与仓库状态与 git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([11, 29, 47], {
      initialMode: "full",
      followupOperation: "deepen",
      strictInitialState: true,
    });
  });

  test("完整 clone 后 shallow-exclude 边界 lightweight tag 的行为与 git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([7, 19, 31], {
      boundaryTagMode: "lightweight",
      followupOperation: "shallowExcludeTag",
      initialMode: "full",
      strictInitialState: true,
    });
  });

  test("完整 clone 后 shallow-exclude 边界 annotated tag 的行为与 git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([13, 23, 37], {
      boundaryTagMode: "annotated",
      followupOperation: "shallowExcludeTag",
      initialMode: "full",
      strictInitialState: true,
    });
  });

  test("depth=1 clone 后 deepen=1 的行为与 git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([41, 53, 67], {
      followupOperation: "deepen",
      initialMode: "depth1",
      strictInitialState: true,
    });
  });

  test("depth=1 clone 后 shallow-exclude 边界 lightweight tag 的行为与 git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([5, 17, 29], {
      boundaryTagMode: "lightweight",
      followupOperation: "shallowExcludeTag",
      initialMode: "depth1",
      strictInitialState: true,
    });
  });

  test("depth=1 clone 后 shallow-exclude 边界 annotated tag 的行为与 git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([13, 23, 37], {
      boundaryTagMode: "annotated",
      followupOperation: "shallowExcludeTag",
      initialMode: "depth1",
      strictInitialState: true,
    });
  });

  test("source-shallow 下 shallow-since 拒绝语义与 git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([71, 83, 97], {
      followupOperation: "shallowSinceReject",
      strictInitialState: true,
    });
  });

  test("source-shallow 下 future shallow-since 行为与 git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([73, 101, 137], {
      followupOperation: "futureShallowSince",
      strictInitialState: true,
    });
  });

  test("source-shallow 下 unshallow 行为与 git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([59, 89, 109], {
      followupOperation: "unshallow",
      strictInitialState: true,
    });
  });

  test("merge-history source-shallow 下完整 clone 后 deepen=1 的请求序列与仓库状态与 git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([101, 113, 127], {
      historyShape: "merge",
      initialMode: "full",
      followupOperation: "deepen",
      strictInitialState: true,
    });
  });

  test("merge-history source-shallow 下完整 clone 后 depth=1 的行为与 git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([97, 131, 167], {
      historyShape: "merge",
      initialMode: "full",
      followupOperation: "depth1",
      strictInitialState: true,
    });
  });

  test("merge-history source-shallow 下完整 clone 后带 annotated 边界 tag 的 deepen=1 行为与 git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([139, 181, 223], {
      boundaryTagMode: "annotated",
      historyShape: "merge",
      initialMode: "full",
      followupOperation: "deepen",
      strictInitialState: true,
    });
  });

  test("merge-history source-shallow 下完整 clone 后带 lightweight 边界 tag 的 deepen=1 行为与 git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([167, 227, 257], {
      boundaryTagMode: "lightweight",
      historyShape: "merge",
      initialMode: "full",
      followupOperation: "deepen",
      strictInitialState: true,
    });
  });

  test("merge-history source-shallow 下 depth=1 clone 后 deepen=1 的请求序列与仓库状态与 git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([107, 149, 173], {
      historyShape: "merge",
      initialMode: "depth1",
      followupOperation: "deepen",
      strictInitialState: true,
    });
  });

  test("merge-history source-shallow 下 depth=1 clone 后带 lightweight 边界 tag 的 deepen=1 行为与 git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([151, 199, 239], {
      boundaryTagMode: "lightweight",
      historyShape: "merge",
      initialMode: "depth1",
      followupOperation: "deepen",
      strictInitialState: true,
    });
  });

  test("merge-history source-shallow 下 depth=1 clone 后带 annotated 边界 tag 的 deepen=1 行为与 git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([131, 173, 211], {
      boundaryTagMode: "annotated",
      historyShape: "merge",
      initialMode: "depth1",
      followupOperation: "deepen",
      strictInitialState: true,
    });
  });

  test("merge-history source-shallow 下完整 clone 后 shallow-exclude 边界 lightweight tag 的行为与 git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([109, 137, 163], {
      boundaryTagMode: "lightweight",
      followupOperation: "shallowExcludeTag",
      historyShape: "merge",
      initialMode: "full",
      strictInitialState: true,
    });
  });

  test("merge-history source-shallow 下完整 clone 后 shallow-exclude 边界 annotated tag 的行为与 git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([139, 157, 181], {
      boundaryTagMode: "annotated",
      followupOperation: "shallowExcludeTag",
      historyShape: "merge",
      initialMode: "full",
      strictInitialState: true,
    });
  });

  test("merge-history source-shallow 下 depth=1 clone 后 shallow-exclude 边界 lightweight tag 的行为与 git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([103, 151, 179], {
      boundaryTagMode: "lightweight",
      followupOperation: "shallowExcludeTag",
      historyShape: "merge",
      initialMode: "depth1",
      strictInitialState: true,
    });
  });

  test("merge-history source-shallow 下 depth=1 clone 后 shallow-exclude 边界 annotated tag 的行为与 git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([131, 149, 167], {
      boundaryTagMode: "annotated",
      followupOperation: "shallowExcludeTag",
      historyShape: "merge",
      initialMode: "depth1",
      strictInitialState: true,
    });
  });

  test("merge-history source-shallow 下 shallow-since 拒绝语义与 git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([173, 191, 197], {
      followupOperation: "shallowSinceReject",
      historyShape: "merge",
      strictInitialState: true,
    });
  });

  test("merge-history source-shallow 下 future shallow-since 行为与 git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([269, 271, 277], {
      followupOperation: "futureShallowSince",
      historyShape: "merge",
      strictInitialState: true,
    });
  });

  test("merge-history source-shallow 下 unshallow 行为与 git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([157, 211, 263], {
      followupOperation: "unshallow",
      historyShape: "merge",
      strictInitialState: true,
    });
  });

  test("source-shallow 下显式 branch-only refPatterns 的初始 full fetch 拒绝行为与 bare git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([281, 307, 331], {
      fetchMode: "branchOnlyPatterns",
      followupOperation: "depth1",
      initialMode: "full",
      strictInitialState: true,
    });
  });

  test("source-shallow 下显式 branch-only refSpecs 的 deepen follow-up 行为与 bare git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([293, 317, 347], {
      fetchMode: "branchOnlyRefSpecs",
      followupOperation: "deepen",
      initialMode: "depth1",
      strictInitialState: true,
    });
  });

  test("source-shallow 下显式 tag-only refPatterns 的 shallow-since reject 行为与 bare git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([353, 373, 389], {
      boundaryTagMode: "annotated",
      fetchMode: "tagOnlyPatterns",
      followupOperation: "shallowSinceReject",
      initialMode: "full",
      strictInitialState: true,
    });
  });

  test("source-shallow 下显式 tag-only refSpecs 的 boundary tag shallow-exclude 行为与 bare git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([367, 383, 401], {
      boundaryTagMode: "annotated",
      fetchMode: "tagOnlyRefSpecs",
      followupOperation: "shallowExcludeTag",
      initialMode: "depth1",
      strictInitialState: true,
    });
  });

  test("source-shallow 下显式 exact-branch refPattern 的初始 full fetch 拒绝行为与 bare git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([419, 433, 449], {
      fetchMode: "exactBranchPattern",
      followupOperation: "depth1",
      initialMode: "full",
      strictInitialState: true,
    });
  });

  test("source-shallow 下显式 custom namespace refSpec 的 unshallow 行为与 bare git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([467, 479, 491], {
      fetchMode: "customNamespaceRefSpec",
      followupOperation: "unshallow",
      initialMode: "full",
      strictInitialState: true,
    });
  });

  test("source-shallow 下 noTags + 显式 tag-only refPatterns 的初始 full fetch 语义与 bare git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([503, 521, 547], {
      boundaryTagMode: "annotated",
      fetchMode: "tagOnlyPatterns",
      followupOperation: "depth1",
      initialMode: "full",
      noTags: true,
      strictInitialState: true,
    });
  });

  test("source-shallow 下 noTags + 显式 heads+tags refPatterns 的初始 full fetch 拒绝语义与 bare git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([557, 571, 587], {
      boundaryTagMode: "annotated",
      fetchMode: "headTagPatterns",
      followupOperation: "depth1",
      initialMode: "full",
      noTags: true,
      strictInitialState: true,
    });
  });

  test("source-shallow 下 noTags + 显式 tag-only refSpecs 的初始 full fetch 语义与 bare git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([593, 607, 617], {
      boundaryTagMode: "annotated",
      fetchMode: "tagOnlyRefSpecs",
      followupOperation: "depth1",
      initialMode: "full",
      noTags: true,
      strictInitialState: true,
    });
  });

  test("source-shallow 下 noTags + 显式 heads+tags refSpecs 的初始 full fetch 拒绝语义与 bare git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([631, 643, 659], {
      boundaryTagMode: "annotated",
      fetchMode: "headTagRefSpecs",
      followupOperation: "depth1",
      initialMode: "full",
      noTags: true,
      strictInitialState: true,
    });
  });

  test("source-shallow 下 noTags + 显式 custom namespace refSpec 的初始 full fetch 语义与 bare git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([673, 691, 709], {
      fetchMode: "customNamespaceRefSpec",
      followupOperation: "depth1",
      initialMode: "full",
      noTags: true,
      strictInitialState: true,
    });
  });
});
