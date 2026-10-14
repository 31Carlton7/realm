import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { readLog } from "./log";
import { UNKNOWN_APP, scoreLog } from "./log-score";
import type { ShadowRow } from "./shadow";

/**
 * Scoring the decision log. What must die: a step Laya chose counted as its own success, two models'
 * rows averaged together, a threshold judged on the steps it was fitted on, a site called ready on too
 * few steps or too low a score, and a step without a site dropped instead of kept as "unknown".
 */

let seq = 0;
function row(o: { surface?: ShadowRow["surface"]; app?: string; right?: boolean; confidence?: number; source?: "agent" | "laya"; asked?: boolean; checkpoint?: string | null; sensitive?: { rule: boolean; p: number }; verify?: { truth: boolean; p: number; rule: boolean; asked?: boolean } } = {}): ShadowRow {
  const n = seq++;
  return {
    v: 1, prompt: 2, id: `r${n}`, at: new Date(Date.UTC(2026, 9, 14, 0, 0, n)).toISOString(),
    surface: o.surface ?? "browser", tool: "browser_act", spaceId: "sp", sessionId: "s",
    ...(o.app !== undefined ? { app: o.app } : {}),
    intent: "open the docs", candidates: [{ id: "1", role: "link", label: "Docs" }, { id: "2", role: "link", label: "Home" }], chosen: { id: "1" },
    checkpoint: o.checkpoint === undefined ? "english@55cf4c4" : o.checkpoint,
    laya: {
      target: o.asked === false ? null : { choice: o.right === false ? "2" : "1", probabilities: {}, confidence: o.confidence ?? 0.9, ms: 40 },
      sensitive: o.sensitive ? { p: o.sensitive.p, parts: { money: o.sensitive.p, delete: 0, send: 0, secret: 0 }, confidence: 0.5, ms: 30 } : null,
      verify: o.verify && o.verify.asked !== false ? { p: o.verify.p, confidence: 0.5, ms: 30, before: "", after: "", diff: "" } : null,
      errors: [],
    },
    truth: {
      target: { id: "1", source: o.source ?? "agent" },
      sensitive: { value: o.sensitive?.rule ?? false, source: "rule", matched: null },
      permission: null,
      verify: o.verify ? { value: o.verify.truth, source: "heuristic", why: "" } : null,
    },
    baseline: { verify: o.verify ? { value: o.verify.rule, changed: true, alert: false } : null },
  };
}
const many = (n: number, o: Parameters<typeof row>[0] = {}) => Array.from({ length: n }, () => row(o));

describe("scoring the decision log", () => {
  it("grades a pick against the agent's choice, and never counts a step Laya chose or was not asked about", () => {
    const s = scoreLog([row(), row(), row({ right: false }), row({ source: "laya", right: true }), row({ asked: false })]);
    expect(s.bySurface).toHaveLength(1);
    expect(s.bySurface[0]!.steps).toBe(5);
    expect(s.bySurface[0]!.target).toMatchObject({ n: 3, accuracy: 0.6667, p50Ms: 40 });
  });

  it("scores the newest row's checkpoint alone, and lists every checkpoint the log holds", () => {
    const s = scoreLog([row({ checkpoint: "old", right: false }), row({ checkpoint: "old", right: false }), row({ checkpoint: "new" })]);
    expect(s.checkpoint).toBe("new");
    expect(s.rows).toBe(1);
    expect(s.bySurface[0]!.target.accuracy).toBe(1);
    expect(s.checkpoints).toEqual([{ name: "old", rows: 2 }, { name: "new", rows: 1 }]);
    expect(scoreLog([row({ checkpoint: "old", right: false }), row({ checkpoint: "new" })], { checkpoint: "old" }).bySurface[0]!.target.accuracy).toBe(0);
  });

  it("splits by surface and by site, keeping steps logged without a site as unknown", () => {
    const s = scoreLog([row({ app: "github.com" }), row({ app: "github.com", right: false }), row({ app: "x.com" }), row(), row({ surface: "simulator", app: "Settings" })]);
    expect(s.bySurface.map((g) => [g.surface, g.app, g.steps])).toEqual([["browser", null, 4], ["simulator", null, 1]]);
    expect(s.byApp.map((g) => [g.surface, g.app, g.target.n, g.target.accuracy])).toEqual([
      ["browser", "github.com", 2, 0.5], ["browser", UNKNOWN_APP, 1, 1], ["browser", "x.com", 1, 1], ["simulator", "Settings", 1, 1],
    ]);
  });

  it("fits no threshold under forty graded steps, and says how many it has", () => {
    const g = scoreLog(many(39, { app: "a.com" })).byApp[0]!;
    expect(g.assist.threshold).toBeNull();
    expect(g.ready).toEqual({ yes: false, reason: "39 graded steps; needs 40" });
  });

  it("calls a site ready when it is right often enough and precise above a threshold fitted on older steps", () => {
    const g = scoreLog(many(40, { app: "a.com" })).byApp[0]!;
    expect(g.assist).toMatchObject({ threshold: 0.9, precision: 1, coverage: 1, covered: 20, measuredOn: 20 });
    expect(g.ready.yes).toBe(true);
  });

  it("judges the threshold on the newer half only: older steps that were right do not vouch for newer ones that were not", () => {
    // 41 of 42 right overall clears 95%, but the one miss sits above the threshold in the newer half.
    const g = scoreLog([...many(21, { confidence: 0.9 }), ...many(20, { confidence: 0.9 }), row({ confidence: 0.95, right: false })]).byApp[0]!;
    expect(g.target.accuracy).toBeGreaterThanOrEqual(0.95);
    expect(g.assist.threshold).toBe(0.9);
    expect(g.assist.precision).toBeLessThan(0.98);
    expect(g.ready).toEqual({ yes: false, reason: "95.2% precise on newer steps; needs 98%" });
  });

  it("holds a site back below 95% however confident its picks are", () => {
    const g = scoreLog([...many(36), ...many(4, { right: false, confidence: 0.1 })]).byApp[0]!;
    expect(g.ready).toEqual({ yes: false, reason: "right 90%; needs 95%" });
  });

  it("reports Laya's sensitive recall against the rule, and verify beside the screen-diff rule on the same steps", () => {
    const g = scoreLog([
      row({ sensitive: { rule: true, p: 0.8 } }), row({ sensitive: { rule: true, p: 0.2 } }), row({ sensitive: { rule: false, p: 0.1 } }),
      row({ verify: { truth: true, p: 0.9, rule: true } }), row({ verify: { truth: false, p: 0.9, rule: false } }),
      // Laya never answered this one, so the rule is not credited with it either: both on the same steps.
      row({ verify: { truth: true, p: 0, rule: false, asked: false } }),
    ]).bySurface[0]!;
    expect(g.sensitive).toEqual({ n: 3, flagged: 2, recall: 0.5, agreement: 0.6667 });
    expect(g.verify).toEqual({ n: 2, accuracy: 0.5, ruleAccuracy: 1 });
  });
});

describe("reading the log back", () => {
  it("reads the rotated files oldest first and skips a torn line", () => {
    const dir = tempDir("realm-laya-log-score-");
    const [a, b, c] = [row(), row(), row()];
    writeFileSync(join(dir, "decisions.1.jsonl"), `${JSON.stringify(a)}\n`);
    writeFileSync(join(dir, "decisions.jsonl"), `${JSON.stringify(b)}\n${JSON.stringify(c)}\n{"v":1,"id":`);
    expect(readLog([join(dir, "decisions.jsonl"), join(dir, "decisions.1.jsonl")]).map((r) => r.id)).toEqual([a.id, b.id, c.id]);
  });
});
