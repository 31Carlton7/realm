import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Item, Session, SessionStatus } from "@realm/contracts";
import { item, profile, session, space } from "../../state/store.test-fakes";
import { listedSessions, nestChildren, rowsBySpace, sectionView, type SidebarState } from "../../components/sidebar/model";
import { bucketLabel } from "../../components/sidebar/chat-feed";
import { agentTitle, spaceSessionPage, type PageRow, type PageSessionRow } from "./session-list";

/** Bucket edges are a claim about the person's day, so they are checked in a zone that has one
 *  short day a year (the US springs forward on 8 March 2026). */
let zone: string | undefined;
beforeAll(() => { zone = process.env.TZ; process.env.TZ = "America/New_York"; });
afterAll(() => { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });

const NOW = () => new Date(2026, 9, 8, 15, 0).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Seed = { id: string; space?: string; status?: SessionStatus; at?: number; created?: number; title?: string; archived?: boolean;
  by?: Session["dispatchedBy"]; agent?: Session["agentKind"]; seq?: number; seen?: number };

/** One profile, two spaces (Versed and Other); the window holds both spaces' items, archived ones too. */
function seed(rows: Seed[]): SidebarState {
  const items: Item[] = [];
  const allSessions: Record<string, Session> = {};
  const sessionStatus: Record<string, SessionStatus> = {};
  const sessionSpace: Record<string, string> = {};
  const sessionUpdatedAt: Record<string, number> = {};
  for (const r of rows) {
    const sp = r.space ?? "v";
    const at = r.at ?? NOW() - HOUR;
    allSessions[r.id] = session(r.id, sp, { title: r.title ?? r.id, status: r.status ?? "idle", updatedAt: at, createdAt: r.created ?? at,
      dispatchedBy: r.by ?? null, agentKind: r.agent ?? "claude", lastEventSeq: r.seq ?? 4, seenSeq: r.seen ?? r.seq ?? 4 });
    sessionStatus[r.id] = r.status ?? "idle"; sessionSpace[r.id] = sp; sessionUpdatedAt[r.id] = at;
    items.push(item(`i-${r.id}`, sp, { kind: "session", refId: r.id, title: r.title ?? r.id, archived: r.archived ?? false }));
  }
  return {
    spaces: [space("v", "p1", "Versed"), space("o", "p1", "Other")], profiles: [profile("p1", "Work")],
    activeProfileId: "p1", activeSpaceId: "v", items, allItems: items.filter((i) => !i.archived),
    sessions: {}, allSessions, sessionStatus, sessionSpace, sessionUpdatedAt, quickChatId: null,
  };
}

const agent = (lead: string) => ({ sessionId: lead, kind: "agent_run" as const });
const rowsOf = (p: ReturnType<typeof spaceSessionPage>) => p.groups.flatMap((g) => g.rows);
const ids = (rows: PageRow[]) => rows.map((r) => r.id);
const lead = (p: ReturnType<typeof spaceSessionPage>, id: string) => rowsOf(p).find((r) => r.id === id) as PageSessionRow;

describe("nesting", () => {
  it("puts sub-agents under their lead and never counts them", () => {
    // Mutant: the CHILD_ORIGINS check dropped — the agents become rows and Active reads 3.
    const p = spaceSessionPage(seed([{ id: "L" }, { id: "a1", by: agent("L") }, { id: "a2", by: agent("L") }]), "v", "active", "", NOW());
    expect(ids(rowsOf(p))).toEqual(["L"]);
    expect(lead(p, "L").agents.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(p.counts).toEqual({ active: 1, archived: 0 });
  });

  it("lists an agent whose lead is gone at the top level, as itself", () => {
    // Mutant: children filtered out unconditionally — the orphan vanishes from the page.
    const p = spaceSessionPage(seed([{ id: "orphan", by: agent("deleted") }, { id: "x" }]), "v", "active", "", NOW());
    expect(ids(rowsOf(p)).sort()).toEqual(["orphan", "x"]);
  });

  it("an agent whose lead is in another space is not nested across spaces", () => {
    const p = spaceSessionPage(seed([{ id: "L", space: "o" }, { id: "a", by: agent("L") }]), "v", "active", "", NOW());
    expect(ids(rowsOf(p))).toEqual(["a"]);
  });

  it("a grandchild goes under the top-most lead — one level deep", () => {
    // Mutant: nesting by direct parent only — the grandchild is lost under an agent that is not a row.
    const rows = seed([{ id: "L" }, { id: "a", by: agent("L"), created: 1 }, { id: "g", by: agent("a"), created: 2 }]);
    const p = spaceSessionPage(rows, "v", "active", "", NOW());
    expect(ids(rowsOf(p))).toEqual(["L"]);
    expect(lead(p, "L").agents.map((a) => a.id)).toEqual(["a", "g"]);
    // The model function on its own, for the other callers that share it.
    expect(nestChildren([...rows.items].map((i) => ({ id: i.refId, spaceId: "v", session: rows.allSessions[i.refId], createdAt: rows.allSessions[i.refId]!.createdAt })))
      .map((n) => [n.row.id, n.agents.map((a) => a.id)])).toEqual([["L", ["a", "g"]]]);
  });

  it("folds a user-dispatch batch as a fan-out, not a nest", () => {
    // Mutant: every dispatchedBy counts as a child — a batch with no lead (sessionId null) vanishes.
    const t = NOW() - HOUR;
    const batch = { sessionId: null, kind: "user-dispatch" as const };
    const p = spaceSessionPage(seed([{ id: "b1", by: batch, created: t }, { id: "b2", by: batch, created: t + 1000 }]), "v", "active", "", NOW());
    expect(rowsOf(p)).toHaveLength(1);
    expect(rowsOf(p)[0]!.kind).toBe("fan-out");
  });

  it("a fork of a session in the space is a session of its own, not its agent", () => {
    // Mutant: any dispatchedBy counts as a child — the fork disappears under the session it came from.
    const p = spaceSessionPage(seed([{ id: "src" }, { id: "fork", by: { sessionId: "src", kind: "fork" } }]), "v", "active", "", NOW());
    expect(ids(rowsOf(p)).sort()).toEqual(["fork", "src"]);
  });

  it("a lead's time is its newest agent's, and its tally is the agents' live state", () => {
    const p = spaceSessionPage(seed([{ id: "L", at: NOW() - 5 * DAY }, { id: "a", by: agent("L"), status: "running", at: NOW() - 2 * HOUR }]), "v", "active", "", NOW());
    expect(lead(p, "L").at).toBe(NOW() - 2 * HOUR);
    expect(lead(p, "L").tally.running).toBe(1);
  });

  it("drops the server's 'Agent: ' prefix for display", () => {
    expect(agentTitle("Agent: You are researching TikTok")).toBe("You are researching TikTok");
    expect(agentTitle("Agentic thoughts")).toBe("Agentic thoughts");
  });
});

describe("grouping", () => {
  it("groups by last activity, not by creation", () => {
    // Mutant: createdAt used — the session made two days ago lands under This week.
    const p = spaceSessionPage(seed([{ id: "a", created: NOW() - 2 * DAY, at: NOW() - HOUR }]), "v", "active", "", NOW());
    expect(p.groups.map((g) => g.label)).toEqual(["Today"]);
  });

  it("a session at work or waiting is under Today whatever its time", () => {
    // Mutant: no live bump — they sit back in September with the rest.
    const p = spaceSessionPage(seed([
      { id: "run", status: "running", at: NOW() - 30 * DAY },
      { id: "ask", status: "waiting_permission", at: NOW() - 30 * DAY },
      { id: "old", at: NOW() - 30 * DAY },
    ]), "v", "active", "", NOW());
    expect(p.groups[0]!.label).toBe("Today");
    expect(ids(p.groups[0]!.rows).sort()).toEqual(["ask", "run"]);
    expect(p.groups[1]!.label).toBe("September");
  });

  it("cuts buckets at local midnight, across a spring-forward day", () => {
    // Mutant: (now − ts) / 86 400 000 — the 23-hour day makes seven calendar days read as six.
    const now = new Date(2026, 2, 14, 0, 10).getTime();
    expect(bucketLabel(new Date(2026, 2, 13, 23, 50).getTime(), now)).toBe("Yesterday");
    expect(bucketLabel(new Date(2026, 2, 8, 0, 30).getTime(), now)).toBe("This week");
    expect(bucketLabel(new Date(2026, 2, 7, 23, 30).getTime(), now)).toBe("March");
    expect(bucketLabel(new Date(2026, 2, 14, 0, 1).getTime(), now)).toBe("Today");
  });

  it("names a month of another year with its year, and this year's without", () => {
    // Mutant: the year printed on the current year, or never.
    expect(bucketLabel(new Date(2026, 8, 3).getTime(), NOW())).toBe("September");
    expect(bucketLabel(new Date(2025, 7, 3).getTime(), NOW())).toBe("August 2025");
  });

  it("orders newest bucket first", () => {
    const p = spaceSessionPage(seed([
      { id: "aug", at: new Date(2026, 7, 2).getTime() }, { id: "today", at: NOW() - HOUR },
      { id: "sep", at: new Date(2026, 8, 2).getTime() }, { id: "wk", at: NOW() - 3 * DAY }, { id: "yd", at: NOW() - DAY },
    ]), "v", "active", "", NOW());
    expect(p.groups.map((g) => g.label)).toEqual(["Today", "Yesterday", "This week", "September", "August"]);
  });

  it("within a group: needs you, then running, then unread, then the rest", () => {
    // Mutant: sort by time only — the newest idle row would come first.
    const p = spaceSessionPage(seed([
      { id: "idle", at: NOW() - 1 * HOUR },
      { id: "unread", at: NOW() - 2 * HOUR, seq: 9, seen: 3 },
      { id: "running", status: "running", at: NOW() - 3 * HOUR },
      { id: "waiting", status: "waiting_permission", at: NOW() - 4 * HOUR },
    ]), "v", "active", "", NOW());
    expect(ids(p.groups[0]!.rows)).toEqual(["waiting", "running", "unread", "idle"]);
  });
});

describe("the filter and its counts", () => {
  it("splits top-level rows by the item's flag; an agent follows its lead, whatever its own flag", () => {
    // Mutant: the child's own archived flag applied — a2 leaves its active lead for the Archived view.
    const s = seed([{ id: "L" }, { id: "a1", by: agent("L") }, { id: "a2", by: agent("L"), archived: true }, { id: "gone", archived: true }]);
    const active = spaceSessionPage(s, "v", "active", "", NOW());
    expect(ids(rowsOf(active))).toEqual(["L"]);
    expect(lead(active, "L").agents.map((a) => a.id)).toEqual(["a1", "a2"]);
    const archived = spaceSessionPage(s, "v", "archived", "", NOW());
    expect(ids(rowsOf(archived))).toEqual(["gone"]);
    expect(archived.counts).toEqual({ active: 1, archived: 1 });
  });

  it("Active counts what the sidebar's section adds up to under Show more", () => {
    // Mutant: any divergence from the sidebar's derivation — orphans, fan-outs, archived, agents.
    const batch = { sessionId: null, kind: "user-dispatch" as const };
    const t = NOW() - 5 * DAY;
    const s = seed([
      ...Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, at: NOW() - i * DAY })),
      { id: "L" }, { id: "a", by: agent("L") }, { id: "orphan", by: agent("nobody") },
      { id: "b1", by: batch, created: t }, { id: "b2", by: batch, created: t + 500 },
      { id: "put-away", archived: true }, { id: "elsewhere", space: "o" },
    ]);
    const { shown, hidden } = sectionView(rowsBySpace(listedSessions(s)).get("v") ?? []);
    const p = spaceSessionPage(s, "v", "active", "", NOW());
    expect(p.counts.active).toBe(shown.length + hidden);
    expect(p.counts.active).toBe(10); // 7 + L + orphan + the fan-out
  });
});

describe("search", () => {
  it("matches an agent's title and returns its lead with the agent marked", () => {
    // Mutant: only top-level titles searched — the lead is dropped.
    const s = seed([{ id: "L", title: "bible app quiz" }, { id: "a", by: agent("L"), title: "Agent: research paywall copy" }, { id: "x", title: "send email" }]);
    const p = spaceSessionPage(s, "v", "active", "PAYWALL", NOW());
    expect(ids(rowsOf(p))).toEqual(["L"]);
    expect(rowsOf(p)[0]!.hits).toEqual(["a"]);
    // The counts are the unfiltered totals.
    expect(p.counts.active).toBe(2);
  });

  it("matches a row's own title, case-insensitively", () => {
    const p = spaceSessionPage(seed([{ id: "a", title: "Test Paywall" }, { id: "b", title: "other" }]), "v", "active", " paywall ", NOW());
    expect(ids(rowsOf(p))).toEqual(["a"]);
    expect(rowsOf(p)[0]!.hits).toEqual([]);
  });
});

describe("the row", () => {
  it("marks the agent only where it differs from the space's usual one", () => {
    // Mutant: always marked (every row) or never.
    const p = spaceSessionPage(seed([{ id: "a" }, { id: "b" }, { id: "c", agent: "codex" }]), "v", "active", "", NOW());
    expect(rowsOf(p).map((r) => [r.id, (r as PageSessionRow).otherAgent])).toEqual(
      expect.arrayContaining([["a", null], ["b", null], ["c", "codex"]]));
  });

  it("is empty only when nothing was ever sent — never by its title", () => {
    // Mutant: keyed on the title "New session".
    const p = spaceSessionPage(seed([
      { id: "fresh", title: "Renamed but never used", seq: 0 },
      { id: "used", title: "New session", seq: 3 },
    ]), "v", "active", "", NOW());
    expect(lead(p, "fresh").empty).toBe(true);
    expect(lead(p, "used").empty).toBe(false);
  });
});
