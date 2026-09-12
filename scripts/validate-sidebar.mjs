import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

mkdirSync(".validation", { recursive: true });
const mode = process.argv[2] ?? "gesture";
if (!["gesture", "visual"].includes(mode)) throw new Error("Expected gesture or visual");
const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
let status = "blocked";
let summary = "Rendered macOS evidence for this candidate is required; see docs/dev/sidebar-validation.md.";
try {
  if (mode === "gesture") {
    const result = spawnSync("npm", ["exec", "--yes", "--package=vitest@3.2.4", "--", "vitest", "run", "--config", "scripts/gesture.vitest.config.mjs"], { encoding: "utf8", timeout: 120_000 });
    writeFileSync(".validation/gesture.log", `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    status = result.error || result.signal ? "blocked" : result.status === 0 ? "passed" : "failed";
    summary = `Gesture regression suite: ${status}. See gesture.log.`;
  } else if (process.env.REALM_SIDEBAR_VISUAL_EVIDENCE) {
    const input = JSON.parse(readFileSync(process.env.REALM_SIDEBAR_VISUAL_EVIDENCE, "utf8"));
    const checks = ["singleSpaceStable", "verticalScrollPreserved", "deliberateSwipeWorks", "cancelAndMomentumSettle", "darkAndLightReviewed"];
    if (input.head !== head || !input.observer || !checks.every(key => typeof input.checks?.[key] === "boolean")) throw new Error("Incomplete or stale rendered evidence");
    if (!Array.isArray(input.captures) || !["dark", "light"].every(theme => input.captures.some(capture => capture.theme === theme))) throw new Error("Dark and light captures required");
    for (const capture of input.captures) {
      const bytes = readFileSync(capture.path);
      if (!bytes.length || createHash("sha256").update(bytes).digest("hex") !== capture.sha256) throw new Error("Missing or changed capture");
    }
    status = checks.every(key => input.checks[key]) ? "passed" : "failed";
    summary = `Rendered checks recorded by ${input.observer}: ${status}.`;
    writeFileSync(".validation/rendered-receipt.json", JSON.stringify(input, null, 2));
  }
} catch (error) { summary = `Validation blocked: ${error.message}`; }
const evidence = {
  schemaVersion: "tabellio-validator-evidence/v0.1",
  validatorId: `sidebar-${mode}`,
  status, summary, metrics: [],
  cost: { telemetry: "not_applicable", usd: null, modelCalls: null, toolCalls: null },
  artifacts: [],
};
writeFileSync(`.validation/${mode}.json`, JSON.stringify(evidence, null, 2));
writeFileSync(`.validation/${mode}-head.json`, JSON.stringify({ head, status }, null, 2));
console.log(JSON.stringify({ head, mode, status, summary }));
process.exitCode = status === "passed" ? 0 : status === "failed" ? 1 : 2;
