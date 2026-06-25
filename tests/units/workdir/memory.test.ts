/**
 * memory VirtualWorkdir 合同测试入口
 */

import { runVirtualWorkdirContract } from "./contract.ts";
import { createVirtualWorkdir } from "@/workdir/memory.ts";

runVirtualWorkdirContract("memory", (repo, options) => createVirtualWorkdir(repo.objects, options));
