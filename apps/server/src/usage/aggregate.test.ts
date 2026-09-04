import { describe, expect, it } from "vitest";
import { USAGE_OTHER_KEY, USAGE_SERIES_CAP, type AgentKind, type UsageSample } from "@realm/contracts";
import { aggregateUsage, buildBreakdown, sliceSession, type PriceLookup, type SessionFacts } from "./aggregate";

/** A day in September 2026, at noon local — bucketing is local-calendar, so fixed offsets would drift. */
const day = (d: number, hour = 12) => new Date(2026, 8, d, hour).getTime();
const FROM = day(1, 0);
const TO = day(30, 23);

const facts = (extra: Partial<SessionFacts> = {}): SessionFacts => ({
  id: "s1", title: "A session", spaceId: "sp1", spaceName: "Space", spaceSort: 0,
  environmentId: "e1", environmentLabel: "repo (main)", agentKind: "claude", model: "claude-opus-5",
  createdAt: FROM, updatedAt: TO, samples: [], ...extra,
});
const sample = (ts: number, costUsd: number, input: number, output: number, turns: number): UsageSample =>
  ({ ts, costUsd, inputTokens: input, outputTokens: output, numTurns: turns });

/** $3/M in, $15/M out — Claude-ish list prices, so the arithmetic is checkable by hand. */
const priced: PriceLookup = (model) => (model ? { priceIn: 3, priceOut: 15 } : null);
const unpriced: PriceLookup = () => null;

const emptyActivity = { toolCalls: 0, userMessages: 0, errors: 0, mcpCalls: 0, mcpFailures: 0, mcpMedianMs: 0, topTools: [], topMcpServers: [] };
const noBudget = { budget: { monthlyUsd: null, thresholds: [0.5, 0.8, 1], includeEstimated: true }, monthSpendUsd: 0, monthStart: FROM, projectedUsd: null };

describe("sliceSession — what one session contributed", () => {
  it("uses the engine's OWN dollars when it states them, and adds no estimate on top", () => {
    const s = facts({ samples: [sample(day(2), 0.4, 100_000, 20_000, 1), sample(day(3), 1.0, 300_000, 60_000, 2)] });
    const { totals } = sliceSession(s, FROM, TO, "day", priced);
    expect(totals.reportedUsd).toBeCloseTo(1.0, 6);
    // The named mutant: adding the catalog estimate to a reported cost double-counts the same tokens.
    expect(totals.estimatedUsd).toBe(0);
    expect(totals.costUsd).toBeCloseTo(1.0, 6);
  });

  it("estimates from the catalog when the engine reports tokens but no price — Codex, always", () => {
    const s = facts({ agentKind: "codex", model: "gpt-5.6", samples: [sample(day(2), 0, 1_000_000, 1_000_000, 1)] });
    const { totals } = sliceSession(s, FROM, TO, "day", priced);
    expect(totals.reportedUsd).toBe(0);
    expect(totals.estimatedUsd).toBeCloseTo(18, 6); // 1M × $3 + 1M × $15
    expect(totals.costUsd).toBeCloseTo(18, 6);
  });

  it("counts an engine that reports nothing as UNMEASURED, never as zero spend", () => {
    // The whole honesty rule in one assertion: an ACP session's tokens are unknown, not absent, and
    // a page that billed it at $0.00 would be stating something false about it.
    const s = facts({ agentKind: "acp:cursor", model: null, samples: [] });
    const { totals } = sliceSession(s, FROM, TO, "day", priced);
    expect(totals.unmeasuredSessions).toBe(1);
    expect(totals.sessions).toBe(1);
    expect(totals.costUsd).toBe(0);
    expect(totals.inputTokens).toBe(0);
  });

  it("leaves the cost at zero when nothing prices the model, rather than inventing one", () => {
    const s = facts({ agentKind: "codex", samples: [sample(day(2), 0, 1_000_000, 0, 1)] });
    expect(sliceSession(s, FROM, TO, "day", unpriced).totals.costUsd).toBe(0);
    expect(sliceSession(s, FROM, TO, "day", unpriced).totals.inputTokens).toBe(1_000_000);
  });

  it("applies the window to the DELTAS, not to the events — the pre-range total is never re-billed", () => {
    // The load-bearing one. This session had already spent $5 in August; the range is September. A
    // filter applied to the events instead of to the deltas would make September's first event look
    // like a $6 turn, and would do it again on every range change.
    const s = facts({ samples: [
      sample(new Date(2026, 7, 20, 12).getTime(), 5, 500_000, 100_000, 4),
      sample(day(2), 6, 600_000, 120_000, 5),
    ] });
    const { totals } = sliceSession(s, FROM, TO, "day", priced);
    expect(totals.costUsd).toBeCloseTo(1, 6);
    expect(totals.inputTokens).toBe(100_000);
    expect(totals.turns).toBe(1);
  });

  it("files each delta in the bucket of its own timestamp", () => {
    const s = facts({ samples: [sample(day(2), 1, 0, 0, 1), sample(day(5), 3, 0, 0, 2)] });
    const { byBucket } = sliceSession(s, FROM, TO, "day", priced);
    expect(byBucket.get(new Date(2026, 8, 2).getTime())?.costUsd).toBeCloseTo(1, 6);
    expect(byBucket.get(new Date(2026, 8, 5).getTime())?.costUsd).toBeCloseTo(2, 6);
  });
});

describe("buildBreakdown", () => {
  const withKind = (id: string, kind: AgentKind, cost: number): { facts: SessionFacts; slice: ReturnType<typeof sliceSession> } => {
    const f = facts({ id, agentKind: kind, samples: [sample(day(2), cost, 1000, 1000, 1)] });
    return { facts: f, slice: sliceSession(f, FROM, TO, "day", priced) };
  };

  it("colours by INTRINSIC order, so re-sorting the table beside it repaints nothing", () => {
    // Codex spends more than Claude here. If the colour followed rank, Claude would be slot 2 — and
    // would move back to slot 1 the moment a different range flipped the order, teaching the reader
    // a palette that then lies to them.
    const rows = buildBreakdown([withKind("a", "claude", 1), withKind("b", "codex", 99)], "agent", [new Date(2026, 8, 2).getTime()]);
    expect(rows.map((r) => [r.key, r.colorIndex])).toEqual([["claude", 0], ["codex", 1]]);
  });

  it("folds past the palette's cap into one Other row rather than reaching for a ninth hue", () => {
    const many = Array.from({ length: USAGE_SERIES_CAP + 3 }, (_, i) => {
      const f = facts({ id: `s${i}`, spaceId: `sp${i}`, spaceName: `Space ${i}`, spaceSort: i, samples: [sample(day(2), (i + 1) * 10, 0, 0, 1)] });
      return { facts: f, slice: sliceSession(f, FROM, TO, "day", priced) };
    });
    const rows = buildBreakdown(many, "space", [new Date(2026, 8, 2).getTime()]);
    expect(rows).toHaveLength(USAGE_SERIES_CAP + 1);
    const other = rows.at(-1)!;
    expect(other.key).toBe(USAGE_OTHER_KEY);
    expect(other.colorIndex).toBe(USAGE_SERIES_CAP);
    // The three cheapest spaces (10 + 20 + 30) are what got folded — spend decides who survives.
    expect(other.totals.costUsd).toBeCloseTo(60, 6);
    expect(other.totals.sessions).toBe(3);
  });

  it("keeps a null model out of one meaningless shared 'Default' row", () => {
    const a = facts({ id: "a", agentKind: "claude", model: null, samples: [sample(day(2), 1, 0, 0, 1)] });
    const b = facts({ id: "b", agentKind: "codex", model: null, samples: [sample(day(2), 0, 100, 100, 1)] });
    const rows = buildBreakdown(
      [{ facts: a, slice: sliceSession(a, FROM, TO, "day", priced) }, { facts: b, slice: sliceSession(b, FROM, TO, "day", priced) }],
      "model", [new Date(2026, 8, 2).getTime()],
    );
    expect(rows.map((r) => r.key).sort()).toEqual(["default:claude", "default:codex"]);
  });

  it("aligns each row's buckets index-for-index with the series the chart draws", () => {
    const f = facts({ samples: [sample(day(3), 2, 0, 0, 1)] });
    const buckets = [day(2, 0), day(3, 0), day(4, 0)].map((t) => new Date(t).setHours(0, 0, 0, 0));
    const rows = buildBreakdown([{ facts: f, slice: sliceSession(f, FROM, TO, "day", priced) }], "agent", buckets);
    expect(rows[0]!.buckets.map((b) => b.costUsd)).toEqual([0, 2, 0]);
  });
});

describe("aggregateUsage", () => {
  it("names the engines that report nothing, so the gap is explained rather than mysterious", () => {
    const sessions = [
      facts({ id: "a", agentKind: "acp:cursor", model: null }),
      facts({ id: "b", agentKind: "acp:goose", model: null }),
      facts({ id: "c", agentKind: "claude", samples: [sample(day(2), 1, 100, 100, 1)] }),
    ];
    const out = aggregateUsage({ sessions, from: FROM, to: TO, bucket: "day", priceFor: priced, activity: emptyActivity, budget: noBudget });
    expect(out.unmeasuredKinds).toEqual(["acp:cursor", "acp:goose"]);
    expect(out.totals.unmeasuredSessions).toBe(2);
    expect(out.totals.sessions).toBe(3);
    expect(out.totals.costUsd).toBeCloseTo(1, 6);
  });

  it("names the models it could not price, which is why an estimate is missing", () => {
    const sessions = [facts({ agentKind: "codex", model: "some-private-model", samples: [sample(day(2), 0, 1000, 1000, 1)] })];
    const out = aggregateUsage({ sessions, from: FROM, to: TO, bucket: "day", priceFor: unpriced, activity: emptyActivity, budget: noBudget });
    expect(out.unpricedModels).toEqual(["some-private-model"]);
  });

  it("does not call an engine that reports nothing 'unpriced' — that is a different story", () => {
    const sessions = [facts({ agentKind: "acp:qwen", model: "qwen3" })];
    const out = aggregateUsage({ sessions, from: FROM, to: TO, bucket: "day", priceFor: unpriced, activity: emptyActivity, budget: noBudget });
    expect(out.unpricedModels).toEqual([]);
    expect(out.unmeasuredKinds).toEqual(["acp:qwen"]);
  });

  it("builds the bucket series from the RANGE, so a quiet day is a gap and not a missing column", () => {
    const sessions = [facts({ samples: [sample(day(2), 1, 0, 0, 1)] })];
    const out = aggregateUsage({ sessions, from: day(1, 0), to: day(5, 23), bucket: "day", priceFor: priced, activity: emptyActivity, budget: noBudget });
    expect(out.buckets).toHaveLength(5);
    expect(out.series.map((p) => p.totals.costUsd)).toEqual([0, 1, 0, 0, 0]);
  });

  it("counts a session once in the totals even though it spans several buckets", () => {
    // The named mutant: summing per-bucket totals for the session count would report this one
    // session as three.
    const sessions = [facts({ samples: [sample(day(2), 1, 0, 0, 1), sample(day(3), 2, 0, 0, 2), sample(day(4), 3, 0, 0, 3)] })];
    const out = aggregateUsage({ sessions, from: FROM, to: TO, bucket: "day", priceFor: priced, activity: emptyActivity, budget: noBudget });
    expect(out.totals.sessions).toBe(1);
    expect(out.totals.costUsd).toBeCloseTo(3, 6);
  });

  it("leaves sessions with nothing to report out of the leaderboard", () => {
    const sessions = [facts({ id: "quiet", agentKind: "acp:cursor", model: null }), facts({ id: "loud", samples: [sample(day(2), 2, 100, 100, 1)] })];
    const out = aggregateUsage({ sessions, from: FROM, to: TO, bucket: "day", priceFor: priced, activity: emptyActivity, budget: noBudget });
    expect(out.sessions.map((s) => s.id)).toEqual(["loud"]);
  });
});
