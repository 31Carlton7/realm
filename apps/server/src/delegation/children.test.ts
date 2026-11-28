import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { CHILDREN_PAGE, sessionEvent, type DelegatedChild, type DispatchKind, type Session, type SessionEvent } from "@realm/contracts";
import { openDatabase, type Db } from "../db/database";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { EnvironmentsStore } from "../store/environments";
import { SessionsStore, SessionEventsStore } from "../store/sessions";
import { SettingsStore } from "../store/settings";
import { ItemsStore } from "../store/items";
import { BrowserAgentService } from "../browsers/browser-agent";
import { AgentRunService, type AgentChildRecord } from "./agent-run";
import { workingMs, type ActiveRun } from "./engine";
import { DelegatedChildren } from "./children";

afterEach(() => { vi.useRealTimers(); });

const NOW = 1_800_000_000_000;
const KINDS: DispatchKind[] = ["agent_run", "browser_agent_run", "review"];

/** Every `prepare` the stores make, with the SQL and what `all` was given, so a test can count reads
 *  and ask SQLite for the plan of the one it made. */
function counted(db: Db) {
  const reads: { sql: string; args: unknown[] }[] = [];
  const wrapped = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") {
        return (sql: string) => {
          const st = target.prepare(sql);
          const read = { sql, args: [] as unknown[] };
          reads.push(read);
          return new Proxy(st, {
            get(s, k) {
              const v = Reflect.get(s, k, s) as unknown;
              if (k === "all" || k === "get") return (...args: unknown[]) => { read.args = args; return (v as (...a: unknown[]) => unknown).apply(s, args); };
              return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(s) : v;
            },
          });
        };
      }
      const v = Reflect.get(target, key, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { db: wrapped, reads };
}

/**
 * A lead with `n` sub-agents of every kind, the way a long teammate home has them: settled agent_run
 * children with their records, browser agents with theirs, reviews with none, a fork that is nobody's
 * sub-agent, two children made in the same millisecond, one with a grandchild from before sub-agents
 * stopped delegating, one whose newest activity row no longer parses, one with a long report, one still
 * running, and one that has written nothing yet.
 */
function seed(n: number) {
  const home = tempDir("realm-children-");
  const raw = openDatabase(join(home, "realm.db"));
  const { db, reads } = counted(raw);
  const profile = new ProfilesStore(raw).create({ name: "W", icon: "x", color: "#000" });
  const space = new SpacesStore(raw, home).create({ profileId: profile.id, name: "S", icon: "f" });
  const env = new EnvironmentsStore(raw).ensurePrimary(space.id);
  const sessions = new SessionsStore(db);
  const events = new SessionEventsStore(db);
  const settings = new SettingsStore(db);
  const make = (title: string, dispatchedBy: Session["dispatchedBy"], createdAt: number) => {
    const s = sessions.create({ spaceId: space.id, projectId: null, agentKind: "fake", model: "m", effort: null, permissionMode: "default", environmentId: env.id, title, dispatchedBy });
    raw.prepare("UPDATE sessions SET created_at = ? WHERE id = ?").run(createdAt, s.id);
    return s.id;
  };
  const lead = make("Lead", null, NOW - 1_000_000);
  const kids: string[] = [];
  for (let i = 0; i < n; i++) {
    const kind = KINDS[i % KINDS.length]!;
    // The third and fourth were made in the same millisecond: only the id tells them apart.
    const id = make(`Child ${i}`, { kind, sessionId: lead }, NOW - 500_000 + (i === 3 ? 2 : i) * 1000);
    kids.push(id);
    if (i % 5 !== 4) {
      events.append(id, sessionEvent("user_message", { text: `task ${i}`, attachments: [] }));
      events.append(id, sessionEvent("tool_call", { toolUseId: `t${i}`, name: "Bash", input: { command: `ls ${i}` }, parentToolUseId: null }));
      events.append(id, sessionEvent("assistant_text", { messageId: `m${i}`, text: i === 2 ? "x".repeat(3000) : `report ${i}` }));
      if (i % 3 === 1) events.append(id, sessionEvent("error", { message: `failed ${i}` }));
    }
    if (kind === "agent_run") {
      settings.set(`agentRun.child:${id}`, { parentSessionId: lead, goal: `goal ${i}`, skills: null, depth: 1, startedAt: NOW - 400_000 + i,
        ...(i === 0 ? {} : { settledAt: NOW - 300_000, outcome: "done", workedMs: 1234 + i }), budgetMs: 60_000, ...(i === 6 ? { stopNote: "Stopped by Realm" } : {}) } satisfies AgentChildRecord);
    }
    if (kind === "browser_agent_run") settings.set(`browserAgent.child:${id}`, { parentSessionId: lead, goal: `browse ${i}`, allowedOrigins: null, maxActs: 15 });
  }
  if (n > 1) {
    // A row a later build can no longer read, newest of its activity: the one before it is what it was doing.
    raw.prepare("INSERT INTO session_events (session_id, ts, type, payload_json) VALUES (?, ?, 'tool_call', '{\"broken\":')").run(kids[1]!, NOW);
  }
  make("A fork", { kind: "fork", sessionId: lead }, NOW - 1);
  const grandchild = n > 0 ? make("Grandchild", { kind: "agent_run", sessionId: kids[0]! }, NOW - 100) : null;
  if (grandchild) {
    events.append(grandchild, sessionEvent("assistant_text", { messageId: "g", text: "grand report" }));
    settings.set(`agentRun.child:${grandchild}`, { parentSessionId: kids[0]!, goal: "grand goal", skills: null, depth: 2 } satisfies AgentChildRecord);
    make("A grandchild's fork", { kind: "fork", sessionId: kids[0]! }, NOW - 50);
  }
  // The first child is still running: the engine has its run.
  const runs: ActiveRun[] = n > 0 ? [{ parentSessionId: lead, childSessionId: kids[0]!, startedAt: NOW - 9000, pausedMs: 1000 } as ActiveRun] : [];
  const engine = { running: (parent: string) => runs.filter((r) => r.parentSessionId === parent) };
  const agentRuns = new AgentRunService({ settings, engine } as never);
  const browserAgents = new BrowserAgentService({ settings } as never);
  const children = new DelegatedChildren({ sessions, events, items: new ItemsStore(raw), rpc: { broadcast: () => {} }, agentRuns, browserAgents });

  /** What `DelegatedChildren.list` answered before it read in batches: every child, oldest first, each
   *  read on its own. The reference the batched read must match field for field. */
  const ACTIVITY: SessionEvent["type"][] = ["tool_call", "permission_request", "assistant_text", "error"];
  const oldDescribe = (s: Session): DelegatedChild => {
    const record = agentRuns.record(s.id);
    const run = record ? engine.running(record.parentSessionId).find((r) => r.childSessionId === s.id) : undefined;
    const live = run ? workingMs(run, Date.now()) : null;
    const working = live !== null ? { ms: live, at: Date.now() } : record?.workedMs !== undefined ? { ms: record.workedMs, at: Date.now() } : null;
    const report = events.lastOfType(s.id, "assistant_text");
    const text = report?.type === "assistant_text" ? report.payload.text : null;
    const browse = (settings.get(`browserAgent.child:${s.id}`) as { goal?: string } | null)?.goal ?? null;
    return {
      session: s, goal: record?.goal ?? browse, startedAt: record?.startedAt ?? s.createdAt, settledAt: record?.settledAt ?? null, outcome: record?.outcome ?? null,
      report: text === null ? null : text.length > 2000 ? `${text.slice(0, 1999).trimEnd()}…` : text,
      activity: events.lastOfTypes(s.id, ACTIVITY), budgetMs: record?.budgetMs ?? null, working,
      ...(record?.stopNote ? { note: record.stopNote } : {}),
    };
  };
  const kidsOf = (id: string) => sessions.listDispatchedBy(id).filter((s) => s.dispatchedBy && KINDS.includes(s.dispatchedBy.kind));
  const oldList = (id: string): DelegatedChild[] => kidsOf(id).map((s) => {
    const nested = kidsOf(s.id).map(oldDescribe);
    return nested.length > 0 ? { ...oldDescribe(s), children: nested } : oldDescribe(s);
  });
  return { raw, reads, lead, kids, grandchild, children, oldList };
}

describe("DelegatedChildren.list", () => {
  it("answers every child and grandchild, field for field, as the one-read-per-child list did — newest first", () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    const { lead, children, oldList, kids, grandchild } = seed(9);
    const reference = oldList(lead);
    expect(reference).toHaveLength(9);
    const got = children.list(lead, { limit: null });
    expect(got.nextBefore).toBeNull();
    expect(got.children).toEqual([...reference].reverse());
    // The cases the seed is for, so a reference that lost one cannot pass for a match.
    const first = got.children.find((c) => c.session.id === kids[0])!;
    expect(first.children?.map((g) => [g.session.id, g.goal, g.report])).toEqual([[grandchild, "grand goal", "grand report"]]);
    expect(first.working).toEqual({ ms: 8000, at: NOW });
    expect(got.children.find((c) => c.session.id === kids[1])!.activity).toMatchObject({ type: "error" });
    expect(got.children.find((c) => c.session.id === kids[2])!.report).toHaveLength(2000);
    expect(got.children.find((c) => c.session.id === kids[4])!).toMatchObject({ goal: `browse 4`, report: null, activity: null });
    expect(got.children.find((c) => c.session.id === kids[6])!.note).toBe("Stopped by Realm");
    expect(got.children.some((c) => c.session.title === "A fork")).toBe(false);
  });

  it("pages newest first: each page starts after the last one ended, ties broken by id, until there are no more", () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    const { lead, children } = seed(10);
    const all = children.list(lead, { limit: null }).children;
    const at = (c: DelegatedChild) => [c.session.createdAt, c.session.id] as const;
    const sorted = [...all].sort((a, b) => b.session.createdAt - a.session.createdAt || (a.session.id < b.session.id ? 1 : -1));
    expect(all.map((c) => c.session.id)).toEqual(sorted.map((c) => c.session.id));
    expect(new Set(all.map((c) => c.session.createdAt)).size).toBe(9); // two share a millisecond
    const pages: DelegatedChild[][] = [];
    let before: { createdAt: number; id: string } | undefined;
    for (;;) {
      const page = children.list(lead, { limit: 3, before });
      pages.push(page.children);
      if (!page.nextBefore) break;
      const last = page.children.at(-1)!;
      expect(page.nextBefore).toEqual({ createdAt: at(last)[0], id: at(last)[1] });
      before = page.nextBefore;
    }
    expect(pages.map((p) => p.length)).toEqual([3, 3, 3, 1]);
    expect(pages.flat()).toEqual(all);
  });

  it("reads a page of the newest when no limit is given, and says where the next one starts", () => {
    const { lead, children } = seed(CHILDREN_PAGE + 4);
    const all = children.list(lead, { limit: null }).children;
    const first = children.list(lead);
    expect(first.children.map((c) => c.session.id)).toEqual(all.slice(0, CHILDREN_PAGE).map((c) => c.session.id));
    const rest = children.list(lead, { before: first.nextBefore! });
    expect(rest.children.map((c) => c.session.id)).toEqual(all.slice(CHILDREN_PAGE).map((c) => c.session.id));
    expect(rest.nextBefore).toBeNull();
    expect(children.list(lead, { limit: CHILDREN_PAGE + 4 }).nextBefore).toBeNull();
  });

  it("counts every one of the lead's sub-agents on each page, and no session that is not one", () => {
    const { lead, children } = seed(CHILDREN_PAGE + 5);
    const first = children.list(lead);
    expect(first.children).toHaveLength(CHILDREN_PAGE);
    expect(first.total).toBe(CHILDREN_PAGE + 5);
    expect(children.list(lead, { before: first.nextBefore! }).total).toBe(CHILDREN_PAGE + 5);
    expect(children.list(lead, { limit: null }).total).toBe(CHILDREN_PAGE + 5);
  });

  it("makes the same number of reads for three children as for sixty", () => {
    const readsFor = (n: number) => {
      const { lead, children, reads } = seed(n);
      const from = reads.length;
      expect(children.list(lead, { limit: null }).children).toHaveLength(n);
      return reads.length - from;
    };
    const few = readsFor(3);
    expect(readsFor(60)).toBe(few);
    // The sessions, how many there are, their newest lines, the two kinds of record, and the one
    // unreadable row read on past.
    expect(few).toBeLessThanOrEqual(6);
  });

  it("finds the children by the dispatcher index, without scanning sessions or sorting in a temporary tree", () => {
    const { lead, children, reads, raw } = seed(4);
    const from = reads.length;
    children.list(lead, { limit: 2, before: { createdAt: NOW, id: "Z".repeat(26) } });
    const page = reads.slice(from).find((r) => r.sql.includes("WITH page AS"))!;
    const plan = (raw.prepare(`EXPLAIN QUERY PLAN ${page.sql}`).all(...(page.args as never[])) as { detail: string }[]).map((r) => r.detail);
    expect(plan.filter((d) => d.includes("sessions_dispatched_by")).length).toBeGreaterThanOrEqual(2);
    expect(plan.filter((d) => /^SCAN s\b/.test(d) || d.includes("TEMP B-TREE"))).toEqual([]);
  });
});

describe("DelegatedChildren.one", () => {
  it("answers one child, its sub-agents under it, field for field as the list has it, and nothing for one that is not the lead's", () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    const { raw, lead, children, kids, grandchild } = seed(9);
    const listed = children.list(lead, { limit: null }).children;
    for (const id of kids) expect(children.one(lead, id)).toEqual(listed.find((c) => c.session.id === id));
    expect(children.one(lead, kids[0]!)!.children?.map((g) => g.session.id)).toEqual([grandchild]);
    expect(children.one(lead, lead)).toBeNull();
    // A fork names the lead it came from, but is nobody's sub-agent.
    const fork = (raw.prepare("SELECT id FROM sessions WHERE title = 'A fork'").get() as { id: string }).id;
    expect(children.one(lead, fork)).toBeNull();
    expect(children.one(kids[0]!, kids[1]!)).toBeNull();
    // A grandchild is its own parent's sub-agent, not the lead's.
    expect(children.one(lead, grandchild!)).toBeNull();
    expect(children.one(kids[0]!, grandchild!)).toMatchObject({ goal: "grand goal", report: "grand report" });
  });

  it("makes the same number of reads for a child with sub-agents of its own as for one without", () => {
    const { lead, children, reads, kids } = seed(9);
    const readsFor = (id: string) => {
      const from = reads.length;
      expect(children.one(lead, id)).not.toBeNull();
      return reads.length - from;
    };
    // kids[0] has a grandchild; kids[3] is the same kind with none.
    const without = readsFor(kids[3]!);
    expect(readsFor(kids[0]!)).toBe(without);
    // The session, the sessions it started, their newest lines and the two kinds of record.
    expect(without).toBeLessThanOrEqual(5);
  });
});
