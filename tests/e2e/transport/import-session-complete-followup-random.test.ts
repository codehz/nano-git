/**
 * 完整仓库 follow-up shallow 请求的随机 git CLI 对照回归
 */

import { describe, test } from "bun:test";

import { runRandomImportSessionCompleteFollowupSeeds } from "./import-session-complete-followup-random.ts";

describe("Import Session - 完整仓库 follow-up shallow 随机 git CLI 对照", () => {
  test("默认随机 operation/history 组合与 git CLI 一致", async () => {
    await runRandomImportSessionCompleteFollowupSeeds([223, 257, 293], {
      strictInitialState: true,
    });
  });

  test("linear history 下 depth=1 行为与 git CLI 一致", async () => {
    await runRandomImportSessionCompleteFollowupSeeds([11, 29, 47], {
      followupOperation: "depth1",
      historyShape: "linear",
      strictInitialState: true,
    });
  });

  test("linear history 下 deepen no-op 行为与 git CLI 一致", async () => {
    await runRandomImportSessionCompleteFollowupSeeds([13, 31, 53], {
      followupOperation: "deepenNoop",
      historyShape: "linear",
      strictInitialState: true,
    });
  });

  test("linear history 下 shallow-since reject 行为与 git CLI 一致", async () => {
    await runRandomImportSessionCompleteFollowupSeeds([17, 37, 59], {
      followupOperation: "shallowSinceReject",
      historyShape: "linear",
      strictInitialState: true,
    });
  });

  test("linear history 下 future shallow-since 行为与 git CLI 一致", async () => {
    await runRandomImportSessionCompleteFollowupSeeds([79, 83, 89], {
      followupOperation: "futureShallowSince",
      historyShape: "linear",
      strictInitialState: true,
    });
  });

  test("linear history 下 shallow-exclude=main reject 行为与 git CLI 一致", async () => {
    await runRandomImportSessionCompleteFollowupSeeds([19, 41, 61], {
      followupOperation: "shallowExcludeMainReject",
      historyShape: "linear",
      strictInitialState: true,
    });
  });

  test("linear history 下 shallow-exclude=<oid> reject 行为与 git CLI 一致", async () => {
    await runRandomImportSessionCompleteFollowupSeeds([23, 43, 67], {
      followupOperation: "shallowExcludeOidReject",
      historyShape: "linear",
      strictInitialState: true,
    });
  });

  test("linear history 下 unshallow reject 行为与 git CLI 一致", async () => {
    await runRandomImportSessionCompleteFollowupSeeds([27, 49, 71], {
      followupOperation: "unshallowReject",
      historyShape: "linear",
      strictInitialState: true,
    });
  });

  test("merge history 下 depth=1 行为与 git CLI 一致", async () => {
    await runRandomImportSessionCompleteFollowupSeeds([101, 131, 163], {
      followupOperation: "depth1",
      historyShape: "merge",
      strictInitialState: true,
    });
  });

  test("merge history 下 deepen no-op 行为与 git CLI 一致", async () => {
    await runRandomImportSessionCompleteFollowupSeeds([107, 139, 173], {
      followupOperation: "deepenNoop",
      historyShape: "merge",
      strictInitialState: true,
    });
  });

  test("merge history 下 shallow-since reject 行为与 git CLI 一致", async () => {
    await runRandomImportSessionCompleteFollowupSeeds([109, 149, 181], {
      followupOperation: "shallowSinceReject",
      historyShape: "merge",
      strictInitialState: true,
    });
  });

  test("merge history 下 future shallow-since 行为与 git CLI 一致", async () => {
    await runRandomImportSessionCompleteFollowupSeeds([227, 229, 233], {
      followupOperation: "futureShallowSince",
      historyShape: "merge",
      strictInitialState: true,
    });
  });

  test("merge history 下 shallow-exclude=main reject 行为与 git CLI 一致", async () => {
    await runRandomImportSessionCompleteFollowupSeeds([113, 151, 191], {
      followupOperation: "shallowExcludeMainReject",
      historyShape: "merge",
      strictInitialState: true,
    });
  });

  test("merge history 下 shallow-exclude=<oid> reject 行为与 git CLI 一致", async () => {
    await runRandomImportSessionCompleteFollowupSeeds([127, 157, 197], {
      followupOperation: "shallowExcludeOidReject",
      historyShape: "merge",
      strictInitialState: true,
    });
  });

  test("merge history 下 unshallow reject 行为与 git CLI 一致", async () => {
    await runRandomImportSessionCompleteFollowupSeeds([137, 167, 211], {
      followupOperation: "unshallowReject",
      historyShape: "merge",
      strictInitialState: true,
    });
  });

  test("显式 branch-only refPatterns 的 depth=1 follow-up 行为与 bare git CLI 一致", async () => {
    await runRandomImportSessionCompleteFollowupSeeds([307, 331, 353], {
      fetchMode: "branchOnlyPatterns",
      followupOperation: "depth1",
      strictInitialState: true,
    });
  });

  test("显式 branch-only refSpecs 的 shallow-since reject 行为与 bare git CLI 一致", async () => {
    await runRandomImportSessionCompleteFollowupSeeds([317, 347, 367], {
      fetchMode: "branchOnlyRefSpecs",
      followupOperation: "shallowSinceReject",
      strictInitialState: true,
    });
  });

  test("显式 tag-only refPatterns 的 depth=1 follow-up 行为与 bare git CLI 一致", async () => {
    await runRandomImportSessionCompleteFollowupSeeds([373, 389, 419], {
      fetchMode: "tagOnlyPatterns",
      followupOperation: "depth1",
      strictInitialState: true,
    });
  });

  test("显式 tag-only refSpecs 的 shallow-since reject 行为与 bare git CLI 一致", async () => {
    await runRandomImportSessionCompleteFollowupSeeds([383, 401, 431], {
      fetchMode: "tagOnlyRefSpecs",
      followupOperation: "shallowSinceReject",
      strictInitialState: true,
    });
  });

  test("显式 exact-branch refPattern 的 depth=1 follow-up 行为与 bare git CLI 一致", async () => {
    await runRandomImportSessionCompleteFollowupSeeds([433, 449, 467], {
      fetchMode: "exactBranchPattern",
      followupOperation: "depth1",
      strictInitialState: true,
    });
  });

  test("显式 custom namespace refSpec 的 shallow-since reject 行为与 bare git CLI 一致", async () => {
    await runRandomImportSessionCompleteFollowupSeeds([479, 491, 503], {
      fetchMode: "customNamespaceRefSpec",
      followupOperation: "shallowSinceReject",
      strictInitialState: true,
    });
  });
});
