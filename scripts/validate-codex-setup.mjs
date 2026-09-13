import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync(".validation", { recursive: true });
const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const result = spawnSync("pnpm", ["exec", "vitest", "run", "--config", "scripts/codex-setup.vitest.config.mjs"], { encoding: "utf8", timeout: 120000 });
const status = result.error || result.signal ? "blocked" : result.status === 0 ? "passed" : "failed";
writeFileSync(".validation/codex-setup.log", `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
writeFileSync(".validation/codex-setup-head.json", JSON.stringify({ head, status }, null, 2));
writeFileSync(".validation/codex-setup.json", JSON.stringify({
  schemaVersion: "tabellio-validator-evidence/v0.1", validatorId: "codex-setup-core", status,
  summary: `Discovery, source boundaries, and binding transaction checks: ${status}. This is not full setup or rendered UI validation.`,
  metrics: [], cost: { telemetry: "not_applicable", usd: null, modelCalls: null, toolCalls: null }, artifacts: [],
}, null, 2));
console.log(JSON.stringify({ head, status }));
process.exitCode = status === "passed" ? 0 : status === "failed" ? 1 : 2;
