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
    });
  });

  test("完整 clone 后 shallow-exclude 边界 lightweight tag 的行为与 git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([7, 19, 31], {
      boundaryTagMode: "lightweight",
      followupOperation: "shallowExcludeTag",
      initialMode: "full",
    });
  });

  test("完整 clone 后 shallow-exclude 边界 annotated tag 的行为与 git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([13, 23, 37], {
      boundaryTagMode: "annotated",
      followupOperation: "shallowExcludeTag",
      initialMode: "full",
    });
  });

  test("depth=1 clone 后 deepen=1 的行为与 git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([41, 53, 67], {
      followupOperation: "deepen",
      initialMode: "depth1",
    });
  });

  test("source-shallow 下 shallow-since 拒绝语义与 git CLI 一致", async () => {
    await runRandomImportSessionSourceShallowSeeds([71, 83, 97], {
      followupOperation: "shallowSinceReject",
    });
  });
});
