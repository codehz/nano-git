/**
 * source-shallow 随机 git CLI 对照回归
 */

import { describe, test } from "bun:test";

import { runRandomImportSessionSourceShallowSeeds } from "./import-session-shallow-random.ts";

describe("Import Session - source-shallow 随机 git CLI 对照", () => {
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

  test("merge-history source-shallow 下 unshallow 行为与 git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([157, 211, 263], {
      followupOperation: "unshallow",
      historyShape: "merge",
      strictInitialState: true,
    });
  });
});
