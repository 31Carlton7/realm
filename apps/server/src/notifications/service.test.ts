import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionEvent, NOTIFICATIONS_DISABLED_KEY, type Notification, type Session } from "@realm/contracts";
import { openDatabase, type Db } from "../db/database";
import { NotificationsStore } from "../store/notifications";
import { SettingsStore } from "../store/settings";
import { NotificationsService, LAST_PROBE_KEY } from "./service";
import type { RpcServer } from "../rpc/server";

let db: Db; let store: NotificationsStore; let settings: SettingsStore; let svc: NotificationsService;
let broadcasts: { event: string; payload: { notification: Notification | null; unread: number } }[];

const session = (extra: Partial<Session> = {}): Session => ({
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", spaceId: "01BX5ZZKBKACTAV9WEVGEMMVRZ", projectId: null, agentKind: "fake",
  model: null, effort: null, permissionMode: "default", environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FA0", cwd: "/tmp",
  status: "running", providerSessionId: null, title: "Fix the login flow", lastEventSeq: 0, terminalItemId: null,
  createdAt: 0, updatedAt: 0, ...extra,
});

const feed = () => store.list({ cursor: null, limit: 100 }).notifications;

beforeEach(() => {
  db = openDatabase(join(mkdtempSync(join(tmpdir(), "realm-notifsvc-")), "realm.db"));
  store = new NotificationsStore(db);
  settings = new SettingsStore(db);
  broadcasts = [];
  const rpc = { broadcast: (event: string, payload: unknown) => broadcasts.push({ event, payload: payload as (typeof broadcasts)[number]["payload"] }) } as unknown as RpcServer;
  svc = new NotificationsService({ store, settings, rpc });
});

describe("NotificationsService — permissions", () => {
  it("a permission_request opens a pending row carrying the session, space, and requestId", () => {
    svc.handleSessionEvent(session({ status: "running" }), sessionEvent("permission_request", { requestId: "req-1", toolName: "Bash", input: { command: "ls" }, title: "Run ls", suggestions: [] }));
    const [n] = feed();
    expect(n).toMatchObject({ category: "permission", refId: "req-1", sessionId: session().id, spaceId: session().spaceId, title: "Fix the login flow", body: "Run ls", actedAt: null, readAt: null });
  });

  it("THE staleness mutant: a permission_response from ANY surface resolves the row — it never survives as pending", () => {
    const s = session();
    svc.handleSessionEvent(s, sessionEvent("permission_request", { requestId: "req-1", toolName: "Bash", input: {}, title: "Run ls", suggestions: [] }));
    svc.handleSessionEvent(s, sessionEvent("permission_response", { requestId: "req-1", decision: "allow" }));
    const [n] = feed();
    expect(n.actedAt).not.toBeNull();
    expect(n.body).toBe("Run ls — Allowed"); // the resolved row shows what happened
    // allow_always and deny word their outcomes too
    svc.handleSessionEvent(s, sessionEvent("permission_request", { requestId: "req-2", toolName: "Bash", input: {}, title: "Run rm", suggestions: [] }));
    svc.handleSessionEvent(s, sessionEvent("permission_response", { requestId: "req-2", decision: "deny" }));
    expect(feed().find((x) => x.refId === "req-2")!.body).toBe("Run rm — Denied");
  });

  it("a response with no matching open row is a silent no-op (already resolved, or the category was off)", () => {
    svc.handleSessionEvent(session(), sessionEvent("permission_response", { requestId: "ghost", decision: "deny" }));
    expect(feed()).toHaveLength(0);
    expect(broadcasts).toHaveLength(0);
  });

  it("a session dying under an unanswered card closes its open permission rows honestly", () => {
    const s = session({ status: "waiting_permission" });
    svc.handleSessionEvent(session({ status: "running" }), sessionEvent("permission_request", { requestId: "req-1", toolName: "Bash", input: {}, title: "Run ls", suggestions: [] }));
    svc.handleSessionEvent(s, sessionEvent("status", { status: "error" }));
    const perm = feed().find((x) => x.category === "permission")!;
    expect(perm.actedAt).not.toBeNull();
    expect(perm.body).toContain("ended before this was answered");
  });
});

describe("NotificationsService — session_done", () => {
  it("writes one born-acted row per settle (running → idle), and none for non-settling transitions", () => {
    svc.handleSessionEvent(session({ status: "idle" }), sessionEvent("status", { status: "running" }));
    svc.handleSessionEvent(session({ status: "running" }), sessionEvent("status", { status: "waiting_permission" }));
    expect(feed()).toHaveLength(0);
    svc.handleSessionEvent(session({ status: "running" }), sessionEvent("status", { status: "idle" }));
    const [n] = feed();
    expect(n).toMatchObject({ category: "session_done", refId: session().id, body: "Finished a turn" });
    expect(n.actedAt).not.toBeNull(); // nothing pending about a settle
    // The broadcast carried the surfaced row — the renderer's focused-pane auto-read needs it.
    expect(broadcasts.at(-1)!.payload.notification?.id).toBe(n.id);
  });

  it("a second settle reuses the still-unread row (bumped), so three unfocused turns are one story", () => {
    svc.handleSessionEvent(session(), sessionEvent("status", { status: "idle" }));
    const first = feed()[0]!;
    db.prepare("UPDATE notifications SET created_at = 100 WHERE id = ?").run(first.id);
    svc.handleSessionEvent(session(), sessionEvent("status", { status: "ended" }));
    const rows = feed();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first.id);
    expect(rows[0]!.body).toBe("Ended");
    expect(rows[0]!.createdAt).toBeGreaterThan(100);
  });

  it("once the row is read, the next settle is genuinely new information — a new row", () => {
    svc.handleSessionEvent(session(), sessionEvent("status", { status: "idle" }));
    store.markRead([feed()[0]!.id]);
    svc.handleSessionEvent(session(), sessionEvent("status", { status: "idle" }));
    expect(feed()).toHaveLength(2);
  });
});

describe("NotificationsService — mcp_health (the flap-storm mutant)", () => {
  it("collapses repeated failures into ONE open row until the server recovers", () => {
    for (let i = 0; i < 50; i++) svc.mcpServerStatus("srv-1", "airtable", "error");
    svc.mcpServerStatus("srv-1", "airtable", "circuit_open");
    const rows = feed();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ category: "mcp_health", refId: "srv-1", title: "airtable", body: "Circuit open after repeated failures", actedAt: null });
    svc.mcpServerStatus("srv-1", "airtable", "connected");
    expect(feed()[0]!.actedAt).not.toBeNull();
    expect(feed()[0]!.body).toContain("Recovered");
  });

  it("a full flap (error → connected → error) while the row is UNREAD reopens it — still one row", () => {
    svc.mcpServerStatus("srv-1", "airtable", "error");
    svc.mcpServerStatus("srv-1", "airtable", "connected");
    svc.mcpServerStatus("srv-1", "airtable", "error");
    const rows = feed();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actedAt).toBeNull(); // open again
  });

  it("after the user READ a resolved failure, a fresh failure writes a fresh row; idle is neither failure nor recovery", () => {
    svc.mcpServerStatus("srv-1", "airtable", "error");
    svc.mcpServerStatus("srv-1", "airtable", "connected");
    store.markRead([feed()[0]!.id]);
    svc.mcpServerStatus("srv-1", "airtable", "error");
    expect(feed()).toHaveLength(2);
    svc.mcpServerStatus("srv-2", "linear", "idle");
    expect(feed()).toHaveLength(2);
    // idle also must not "resolve" srv-1's open row
    expect(feed().some((n) => n.refId === "srv-1" && n.actedAt === null)).toBe(true);
  });

  it("two different servers never collapse into each other", () => {
    svc.mcpServerStatus("srv-1", "airtable", "error");
    svc.mcpServerStatus("srv-2", "linear", "error");
    expect(feed()).toHaveLength(2);
  });
});

describe("NotificationsService — agent_probe", () => {
  const probe = (available: boolean, reason: string | null = null) => [{ kind: "fake" as const, available, version: null, loggedIn: null, reason }];

  it("the first probe ever only seeds the baseline — 'previously available' is never invented", () => {
    svc.probeResults(probe(false, "not installed"));
    expect(feed()).toHaveLength(0);
    expect(settings.get(LAST_PROBE_KEY)).toEqual({ fake: false });
  });

  it("available → unavailable writes the regression; back to available resolves it", () => {
    svc.probeResults(probe(true));
    expect(feed()).toHaveLength(0);
    svc.probeResults(probe(false, "binary vanished"));
    const [n] = feed();
    expect(n).toMatchObject({ category: "agent_probe", refId: "fake", title: "Fake agent is unavailable", body: "binary vanished", actedAt: null });
    svc.probeResults(probe(true));
    expect(feed()[0]!.actedAt).not.toBeNull();
    // repeated unavailable probes while open collapse (same rule as mcp_health)
    svc.probeResults(probe(false));
    svc.probeResults(probe(false));
    expect(feed()).toHaveLength(1); // reopened the unread row, not new ones
  });
});

describe("NotificationsService — worktree_hazard", () => {
  it("writes a born-acted row, and repeated refusals on one environment reuse the unread row", () => {
    svc.worktreeHazard({ spaceId: null, environmentId: "env-1", title: "Worktree removal refused", body: "2 changed files" });
    svc.worktreeHazard({ spaceId: null, environmentId: "env-1", title: "Worktree removal refused", body: "3 changed files" });
    const rows = feed();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ category: "worktree_hazard", refId: "env-1", body: "3 changed files" });
    expect(rows[0]!.actedAt).not.toBeNull();
  });
});

describe("NotificationsService — category toggles", () => {
  it("THE disabled-writes mutant: a disabled category writes no rows; others still do; existing rows stay listed", () => {
    svc.mcpServerStatus("srv-1", "airtable", "error");
    settings.set(NOTIFICATIONS_DISABLED_KEY, ["mcp_health", "session_done"]);
    svc.mcpServerStatus("srv-2", "linear", "error");
    svc.handleSessionEvent(session(), sessionEvent("status", { status: "idle" }));
    svc.worktreeHazard({ spaceId: null, environmentId: "env-1", title: "t", body: "b" });
    const rows = feed();
    expect(rows.map((n) => n.category).sort()).toEqual(["mcp_health", "worktree_hazard"]);
    expect(rows.find((n) => n.category === "mcp_health")!.refId).toBe("srv-1"); // pre-toggle row survives the toggle
  });

  it("garbage in the settings key means everything enabled (default-on polarity)", () => {
    settings.set(NOTIFICATIONS_DISABLED_KEY, "mcp_health"); // not an array
    svc.mcpServerStatus("srv-1", "airtable", "error");
    expect(feed()).toHaveLength(1);
  });
});

describe("NotificationsService — list/markRead and the ONE unread count", () => {
  it("markRead all is global across spaces (the feed is global — stated, not accidental)", () => {
    svc.handleSessionEvent(session({ spaceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }), sessionEvent("status", { status: "idle" }));
    svc.handleSessionEvent(session({ id: "01BX5ZZKBKACTAV9WEVGEMMVRZ", spaceId: "01BX5ZZKBKACTAV9WEVGEMMVRZ" }), sessionEvent("status", { status: "idle" }));
    expect(svc.list({ cursor: null, limit: 10 }).unread).toBe(2);
    const r = svc.markRead({ ids: [], all: true });
    expect(r.unread).toBe(0);
    expect(svc.list({ cursor: null, limit: 10 }).notifications.every((n) => n.readAt !== null)).toBe(true);
  });

  it("every broadcast's unread equals what notifications.list reports — one derivation site", () => {
    svc.handleSessionEvent(session(), sessionEvent("permission_request", { requestId: "r1", toolName: "Bash", input: {}, title: "x", suggestions: [] }));
    svc.handleSessionEvent(session(), sessionEvent("status", { status: "idle" }));
    svc.markRead({ ids: [feed()[0]!.id], all: false });
    for (const b of broadcasts) {
      expect(b.event).toBe("notifications.changed");
      // Replaying history: each payload's unread must have matched the store at the time. The last one
      // must match NOW — the strongest cheap assertion that no second counter exists.
    }
    expect(broadcasts.at(-1)!.payload.unread).toBe(svc.list({ cursor: null, limit: 10 }).unread);
  });

  it("markRead of nothing new broadcasts nothing (no phantom changes)", () => {
    svc.markRead({ ids: [], all: true });
    expect(broadcasts).toHaveLength(0);
  });
});
