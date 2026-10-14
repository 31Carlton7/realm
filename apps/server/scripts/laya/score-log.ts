/**
 * Scores Laya on the steps this Mac really took: the decision log against what the agent did, by
 * surface and by app or site (`src/laya/log-score.ts`). It asks Laya nothing — every answer is the one
 * logged — so it needs no venv and starts no server.
 *
 *   pnpm --filter @realm/server exec tsx scripts/laya/score-log.ts --home <REALM_HOME> [--checkpoint <name>] [--json <out.json>]
 *
 * `--home` is required, never assumed: the log holds other apps' content and is only read, never
 * copied. Rows from before sites were logged count under "unknown".
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DecisionLog, readLog } from "../../src/laya/log";
import { pct as percent, scoreLog, type LogScoreGroup } from "../../src/laya/log-score";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
const home = args.get("home");
if (!home) throw new Error("--home <REALM_HOME> is required");

const log = new DecisionLog({ path: join(home, "laya", "decisions.jsonl") });
const score = scoreLog(readLog(log.files()), args.has("checkpoint") ? { checkpoint: args.get("checkpoint")! } : {});
const out = args.get("json");
if (out) writeFileSync(out, JSON.stringify(score, null, 2) + "\n");

const pct = (x: number, n: number) => (n ? percent(x) : "—");
const line = (g: LogScoreGroup) => [
  (g.app ?? `${g.surface} (all)`).padEnd(28),
  String(g.target.n).padStart(5),
  pct(g.target.accuracy, g.target.n).padStart(8),
  `${g.target.p50Ms} ms`.padStart(8),
  `${pct(g.sensitive.recall, g.sensitive.flagged)} of ${g.sensitive.flagged}`.padStart(12),
  `${pct(g.verify.accuracy, g.verify.n)} / ${pct(g.verify.ruleAccuracy, g.verify.n)}`.padStart(16),
  `  ${g.ready.yes ? "READY" : "not yet"}: ${g.ready.reason}`,
].join(" ");

console.log(`checkpoint ${score.checkpoint ?? "(none)"}: ${score.rows} steps, ${score.from ?? "—"} to ${score.to ?? "—"}`);
const others = score.checkpoints.filter((c) => c.name !== score.checkpoint);
if (others.length) console.log(`not scored: ${others.map((c) => `${c.name ?? "(none)"} (${c.rows})`).join(", ")}`);
console.log("Target is a ceiling: the shadow always offers Laya the agent's own element; Assist may not.\n");
console.log(`${"".padEnd(28)} ${"n".padStart(5)} ${"target".padStart(8)} ${"p50".padStart(8)} ${"sens recall".padStart(12)} ${"verify / rule".padStart(16)}`);
for (const surface of score.bySurface) {
  console.log(line(surface));
  for (const g of score.byApp.filter((a) => a.surface === surface.surface).sort((a, b) => b.target.n - a.target.n)) console.log(line(g));
  console.log("");
}
