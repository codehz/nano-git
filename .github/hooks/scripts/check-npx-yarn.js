#!/usr/bin/env node
// oxlint-disable typescript/no-unsafe-assignment typescript/no-unsafe-argument typescript/no-unsafe-call typescript/no-unsafe-member-access
// PreToolUse hook: 拦截 npx/yarn 命令，建议使用 bun/bunx
import { stdin } from "node:process";

const chunks = [];
for await (const chunk of stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));

if (input.tool_name === "run_in_terminal") {
  const cmd = input.tool_input?.command ?? "";
  const hasNpx = /(?:^|[|;&\s])npx(?:\s|$)/.test(cmd);
  const hasYarn = /(?:^|[|;&\s])yarn(?:\s|$)/.test(cmd);

  if (hasNpx || hasYarn) {
    const suggested = cmd.replace(/\bnpx\b/g, "bunx").replace(/\byarn\b/g, "bun");

    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `本项目使用 bun/bunx 而非 npx/yarn，建议执行: ${suggested}`,
        },
      }),
    );
    process.exit(0);
  }
}

console.log(JSON.stringify({ continue: true }));
