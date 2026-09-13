import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync(".validation", { recursive: true });
const install = spawnSync("pnpm", ["--filter", "@realm/desktop...", "install", "--frozen-lockfile", "--ignore-scripts"], { encoding: "utf8", timeout: 180000 });
let summary = "Desktop dependencies unavailable; rendered Codex setup validation is blocked.";
let log = `${install.stdout ?? ""}\n${install.stderr ?? ""}`;
if (install.status === 0) {
  const test = spawnSync("pnpm", ["--filter", "@realm/desktop", "exec", "vitest", "run", "src/renderer/src/panes/settings/settings-page.test.tsx"], { encoding: "utf8", timeout: 120000 });
  log += `\n${test.stdout ?? ""}\n${test.stderr ?? ""}`;
  summary = test.status === 0 ? "Component checks passed; rendered macOS screenshots and interaction review remain blocked." : "Codex setup component checks failed.";
}
const status = install.status === 0 && /component checks failed/i.test(summary) ? "failed" : "blocked";
writeFileSync(".validation/codex-setup-ui.log", log);
writeFileSync(".validation/codex-setup-ui.json", JSON.stringify({ schemaVersion: "tabellio-validator-evidence/v0.1", validatorId: "codex-setup-ui", status, summary, metrics: [], cost: { telemetry: "not_applicable", usd: null, modelCalls: null, toolCalls: null }, artifacts: [] }, null, 2));
console.log(JSON.stringify({ status, summary }));
process.exitCode = status === "failed" ? 1 : 2;
