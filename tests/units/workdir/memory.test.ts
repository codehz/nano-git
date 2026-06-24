/**
 * memory backend 合同测试入口
 */

import { runVirtualWorkdirContract } from "./contract.ts";
import { createVirtualWorkdirSession } from "@/workdir/memory.ts";

runVirtualWorkdirContract("memory", (repo, options) =>
  createVirtualWorkdirSession(repo.objects, options),
);
