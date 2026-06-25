/**
 * file VirtualWorkdir 合同测试入口
 */

import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runVirtualWorkdirContract } from "./contract.ts";
import { openFileVirtualWorkdir } from "@/workdir/file.ts";

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

runVirtualWorkdirContract("file", (repo, options) => {
  const root = mkdtempSync(join(tmpdir(), "nano-git-workdir-contract-file-"));
  tempRoots.push(root);
  return openFileVirtualWorkdir(repo.objects, root, {
    ...options,
    create: true,
  });
});
