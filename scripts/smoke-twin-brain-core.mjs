#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const steps = [
  { name: "server build", cwd: "osrs-mcp-server", command: "cmd", args: ["/c", "npm", "run", "build"] },
  { name: "server mcp smoke", cwd: "osrs-mcp-server", command: "cmd", args: ["/c", "npm", "run", "smoke:mcp"] },
  { name: "server planner smoke", cwd: "osrs-mcp-server", command: "cmd", args: ["/c", "npm", "run", "smoke:planner"] },
  { name: "server reflex smoke", cwd: "osrs-mcp-server", command: "cmd", args: ["/c", "npm", "run", "smoke:reflex"] },
  { name: "server navigation smoke", cwd: "osrs-mcp-server", command: "cmd", args: ["/c", "npm", "run", "smoke:navigation"] },
  { name: "server runtime modules smoke", cwd: "osrs-mcp-server", command: "cmd", args: ["/c", "npm", "run", "smoke:runtime-modules"] },
  { name: "brain build", cwd: "osrs-agent-brain", command: "cmd", args: ["/c", "npm", "run", "build"] },
  { name: "brain prompt smoke", cwd: "osrs-agent-brain", command: "cmd", args: ["/c", "npm", "run", "smoke:prompt"] },
  { name: "brain tools smoke", cwd: "osrs-agent-brain", command: "cmd", args: ["/c", "npm", "run", "smoke:brain-tools"] },
  { name: "brain policy smoke", cwd: "osrs-agent-brain", command: "cmd", args: ["/c", "npm", "run", "smoke:brain-policy"] },
  { name: "brain strategist smoke", cwd: "osrs-agent-brain", command: "cmd", args: ["/c", "npm", "run", "smoke:strategist"] },
];

const results = [];
for (const step of steps) {
  const startedAt = Date.now();
  process.stderr.write(`\n[core-smoke] ${step.name}\n`);
  const result = await runStep(step);
  results.push({
    name: step.name,
    ok: result.code === 0,
    code: result.code,
    durationMs: Date.now() - startedAt,
  });
  if (result.code !== 0) {
    console.error(JSON.stringify({ ok: false, failedStep: step.name, results }, null, 2));
    process.exit(result.code ?? 1);
  }
}

console.log(JSON.stringify({
  ok: true,
  suite: "twin-brain-core",
  results,
}, null, 2));

function runStep(step) {
  return new Promise((resolve) => {
    const child = spawn(step.command, step.args, {
      cwd: path.join(repoRoot, step.cwd),
      stdio: "inherit",
      shell: false,
      env: process.env,
    });
    child.on("close", (code) => resolve({ code }));
    child.on("error", (error) => {
      console.error(`[core-smoke] ${step.name} failed to start: ${error.message}`);
      resolve({ code: 1 });
    });
  });
}
