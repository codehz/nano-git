/**
 * VirtualWorkdir 多后端合同测试入口
 */
import { describe } from "bun:test";

import { registerVirtualWorkdirContract, virtualWorkdirBackends } from "./contract.ts";

describe("VirtualWorkdir contract", () => {
  describe.each(virtualWorkdirBackends)("$name", ({ createWorkdir }) => {
    registerVirtualWorkdirContract(createWorkdir);
  });
});
