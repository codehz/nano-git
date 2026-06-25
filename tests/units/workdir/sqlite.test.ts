/**
 * sqlite VirtualWorkdir 合同测试入口
 */

import { runVirtualWorkdirContract } from "./contract.ts";
import { openSqliteVirtualWorkdir } from "@/workdir/sqlite.ts";

runVirtualWorkdirContract("sqlite", (repo, options) => {
  return openSqliteVirtualWorkdir(repo.objects, ":memory:", "demo", {
    ...options,
    create: true,
  });
});
