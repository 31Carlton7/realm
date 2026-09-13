import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

mkdirSync(".validation", { recursive: true });
const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const log = [];
let status = "blocked";
let summary = "Rendered Codex setup validation requires macOS.";

const run = (label, command, args, timeout) => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout });
  log.push(`## ${label}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  return result;
};

if (process.platform === "darwin") {
  const steps = [
    ["install", "pnpm", ["install", "--frozen-lockfile"], 240_000],
    ["component", "pnpm", ["--filter", "@realm/desktop", "exec", "vitest", "run", "src/renderer/src/panes/settings/settings-page.test.tsx"], 120_000],
    ["server build", "pnpm", ["--filter", "@realm/server", "build"], 120_000],
    ["desktop build", "pnpm", ["--filter", "@realm/desktop", "build"], 180_000],
    ["rendered journey", "node", ["apps/desktop/scripts/codex-setup-live.mjs"], 120_000],
  ];
  status = "passed";
  for (const [label, command, args, timeout] of steps) {
    const result = run(label, command, args, timeout);
    if (result.error || result.signal) { status = "blocked"; summary = `${label} could not complete.`; break; }
    if (result.status !== 0) { status = "failed"; summary = `${label} failed.`; break; }
  }
  if (status === "passed") summary = "Component checks and six-state rendered Codex setup journey passed on macOS.";
}

const livePath = ".validation/codex-setup-ui/live.json";
const live = existsSync(livePath) ? JSON.parse(readFileSync(livePath, "utf8")) : null;
const artifacts = live?.status === "passed" ? [livePath, ...live.artifacts.map((artifact) => artifact.path)] : [];
writeFileSync(".validation/codex-setup-ui.log", log.join("\n"));
writeFileSync(".validation/codex-setup-ui-head.json", JSON.stringify({ head, status }, null, 2));
writeFileSync(".validation/codex-setup-ui.json", JSON.stringify({
  schemaVersion: "tabellio-validator-evidence/v0.1", validatorId: "codex-setup-ui", status, summary,
  metrics: [], cost: { telemetry: "not_applicable", usd: null, modelCalls: null, toolCalls: null }, artifacts,
}, null, 2));
console.log(JSON.stringify({ head, status, summary }));
process.exitCode = status === "passed" ? 0 : status === "failed" ? 1 : 2;
