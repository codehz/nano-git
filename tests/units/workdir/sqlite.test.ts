/**
 * sqlite backend 合同测试入口
 */

import { runVirtualWorkdirContract } from "./contract.ts";
import { createSqliteVirtualWorkdirBackend } from "@/workdir/sqlite.ts";

runVirtualWorkdirContract("sqlite", (repo, options) => {
  const backend = createSqliteVirtualWorkdirBackend(":memory:");
  const sessionId = backend.createSession(options);
  return backend.openSession(repo.objects, sessionId);
});
