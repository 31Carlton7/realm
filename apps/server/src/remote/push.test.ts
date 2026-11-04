import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@realm/test-utils";
import { NOTIFICATIONS_IPHONE_KEY, type Notification } from "@realm/contracts";
import { openDatabase } from "../db/database";
import type { RelayedNotification } from "../notifications/relay";
import { SettingsStore } from "../store/settings";
import type { PushPayload } from "./gateway";
import { collapseId, PhonePushes, PUSH_HOLD_MS, pushCategory, pushLine, stillWaiting } from "./push";

type Sent = { phoneId: string; payload: PushPayload; o: { urgent: boolean; collapse: string | null; badge: number | null } };

const SESSION = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

function rig(o: { phones?: string[]; away?: boolean } = {}) {
  const sent: Sent[] = [];
  const phones = o.phones ?? ["phoneA", "phoneB"];
  let away = o.away ?? false;
  const listeners = new Set<() => void>();
  const presence = {
    away: () => away,
    onChange: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    set(v: boolean) { const was = away; away = v; if (was !== v) for (const l of listeners) l(); },
  };
  const rows = new Map<string, Notification>();
  const settings = new SettingsStore(openDatabase(join(tempDir("realm-push-"), "realm.db")));
  const pushes = new PhonePushes({
    remote: {
      phones: () => phones.map((phoneId) => ({ phoneId })),
      push: async (phoneId, payload, opts) => { sent.push({ phoneId, payload, o: opts }); return { ok: true, status: 200, reason: null }; },
    },
    presence, settings,
    notification: (id) => rows.get(id) ?? null,
    needsYou: () => 3,
    titleOf: (id) => (id === SESSION ? "Fix the login flow" : null),
  });
  /** A surfaced feed row, and what the relay hands the phone transport for it. */
  const moment = (n: Partial<Notification> & Pick<Notification, "id" | "category">, hint?: RelayedNotification["hint"],
    tool?: RelayedNotification["tool"]): RelayedNotification => {
    const row: Notification = { spaceId: null, sessionId: SESSION, refId: `ref-${n.id}`, title: "Untitled session", body: "Allow Bash?", createdAt: 0, readAt: null,
      actedAt: n.category === "session_done" ? 1 : null, ...n };
    rows.set(row.id, row);
    return { category: row.category, title: row.title, body: row.body, id: row.id, refId: row.refId, sessionId: row.sessionId, ...(hint ? { hint } : {}),
      ...(tool ? { tool } : {}) };
  };
  return { sent, rows, settings, presence, pushes, moment, phones };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("pushes to a paired phone (Plan 28, When the phone buzzes)", () => {
  it("away, a moment goes at once: one sealed push per paired phone, worded from the session", async () => {
    const r = rig({ away: true });
    r.pushes.send(r.moment({ id: "n1", category: "permission", refId: "req-1" }));
    await vi.runOnlyPendingTimersAsync();
    expect(r.sent.map((s) => s.phoneId)).toEqual(["phoneA", "phoneB"]);
    expect(r.sent[0]!.payload).toEqual({ kind: "permission", title: "Fix the login flow", body: "Allow Bash?", session: SESSION });
    // A moment from a Mac that did not say which tool asked offers no answers on the notification.
    expect(r.sent[0]!.payload).not.toHaveProperty("category");
    expect(r.sent[0]!.o).toEqual({
      urgent: true,
      // The feed's own dedup key, hashed: a repeat replaces the push before it, and the relay learns nothing.
      collapse: createHash("sha256").update("permission:req-1").digest("hex"),
      badge: 3,
    });
    expect(r.sent[1]!.payload).toEqual(r.sent[0]!.payload);
  });

  it("words each of the three moments as its kind, urgent only when something waits on an answer", () => {
    const r = rig({ away: true });
    r.pushes.send(r.moment({ id: "q", category: "permission" }, { kind: "question", line: "Which database?" }));
    r.pushes.send(r.moment({ id: "d", category: "session_done", body: "Finished a turn" }));
    r.pushes.send(r.moment({ id: "f", category: "session_done", body: "Failed" }, { kind: "failed" }));
    r.pushes.send(r.moment({ id: "b", category: "run_blocked", sessionId: null, title: "Nightly report", body: "Wants a sign-off" }));
    const one = r.sent.filter((s) => s.phoneId === "phoneA").map((s) => ({ kind: s.payload.kind, title: s.payload.title, body: s.payload.body, urgent: s.o.urgent }));
    expect(one).toEqual([
      { kind: "question", title: "Fix the login flow", body: "Which database?", urgent: true },
      { kind: "finished", title: "Fix the login flow", body: "Finished a turn", urgent: false },
      { kind: "failed", title: "Fix the login flow", body: "Failed", urgent: false },
      // No session to name, so the row's own title.
      { kind: "blocked", title: "Nightly report", body: "Wants a sign-off", urgent: true },
    ]);
  });

  it("present, a moment waits two minutes and goes only if it is still waiting", () => {
    const r = rig({ away: false });
    r.pushes.send(r.moment({ id: "n1", category: "permission" }));
    vi.advanceTimersByTime(PUSH_HOLD_MS - 1);
    // THE mutant: no hold-back at all, and the phone buzzes in the owner's pocket while they sit at the Mac.
    expect(r.sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(r.sent).toHaveLength(2);
  });

  it("present, a request answered at the Mac never buzzes, and a finished turn read there never does", () => {
    const r = rig({ away: false });
    r.pushes.send(r.moment({ id: "answered", category: "permission" }));
    r.pushes.send(r.moment({ id: "read", category: "session_done", body: "Finished a turn" }));
    r.pushes.send(r.moment({ id: "unread", category: "session_done", body: "Finished a turn" }));
    // Answered and read on the Mac inside the two minutes.
    r.rows.set("answered", { ...r.rows.get("answered")!, actedAt: 5 });
    r.rows.set("read", { ...r.rows.get("read")!, readAt: 5 });
    vi.advanceTimersByTime(PUSH_HOLD_MS);
    // THE mutant: send when the hold ends whatever happened meanwhile.
    expect(r.sent.map((s) => s.payload.kind)).toEqual(["finished", "finished"]);
    expect(new Set(r.sent.map((s) => s.o.collapse))).toEqual(new Set([collapseId("session_done", "ref-unread")]));
  });

  it("the owner walking away sends what was held at once — only what still waits, and only once", () => {
    const r = rig({ away: false });
    r.pushes.send(r.moment({ id: "waiting", category: "permission" }));
    r.pushes.send(r.moment({ id: "answered", category: "permission" }));
    r.rows.set("answered", { ...r.rows.get("answered")!, actedAt: 5 });
    vi.advanceTimersByTime(30_000);
    r.presence.set(true);
    expect(r.sent.map((s) => `${s.phoneId}:${s.o.collapse === collapseId("permission", "ref-waiting")}`)).toEqual(["phoneA:true", "phoneB:true"]);
    vi.advanceTimersByTime(PUSH_HOLD_MS);
    expect(r.sent).toHaveLength(2);
  });

  it("a surfaced row raised again while held is held once, not twice", () => {
    const r = rig({ away: false });
    const n = r.moment({ id: "n1", category: "permission" });
    r.pushes.send(n);
    vi.advanceTimersByTime(60_000);
    r.pushes.send(n);
    vi.advanceTimersByTime(PUSH_HOLD_MS);
    expect(r.sent).toHaveLength(2);
  });

  it("sends nothing once iPhone pushes are switched off in Settings, or the last phone is removed, even mid-hold", () => {
    const r = rig({ away: false });
    expect(r.pushes.wants()).toBe(true);
    r.pushes.send(r.moment({ id: "n1", category: "permission" }));
    r.settings.set(NOTIFICATIONS_IPHONE_KEY, false);
    expect(r.pushes.wants()).toBe(false);
    vi.advanceTimersByTime(PUSH_HOLD_MS);
    expect(r.sent).toEqual([]);
    r.settings.set(NOTIFICATIONS_IPHONE_KEY, true);
    r.phones.splice(0);
    expect(r.pushes.wants()).toBe(false);
  });

  it("close() drops what was held: nothing fires into a closing app", () => {
    const r = rig({ away: false });
    r.pushes.send(r.moment({ id: "n1", category: "permission" }));
    r.pushes.close();
    vi.advanceTimersByTime(PUSH_HOLD_MS);
    r.presence.set(true);
    expect(r.sent).toEqual([]);
  });
});

describe("what a push's notification answers", () => {
  it("a permission carries its request and the desktop card's answers; a finished or failed turn takes a reply", () => {
    const r = rig({ away: true, phones: ["phoneA"] });
    r.pushes.send(r.moment({ id: "p", category: "permission", refId: "req-1" }, undefined, { name: "Bash", onSite: false }));
    r.pushes.send(r.moment({ id: "d", category: "session_done", refId: SESSION, body: "Finished a turn" }));
    r.pushes.send(r.moment({ id: "f", category: "session_done", refId: SESSION, body: "Failed" }, { kind: "failed" }));
    expect(r.sent.map((s) => ({ category: s.payload.category, request: s.payload.request }))).toEqual([
      { category: "permission", request: "req-1" },
      { category: "reply", request: undefined },
      { category: "reply", request: undefined },
    ]);
    expect(r.sent[0]!.payload).toEqual({ kind: "permission", title: "Fix the login flow", body: "Allow Bash?", session: SESSION,
      category: "permission", request: "req-1" });
    expect(r.sent[1]!.payload).not.toHaveProperty("request");
  });

  it("names Allow always's scope as the desktop card does: a space for computer_act, a site for a password on its own page", () => {
    const at = (name: string, onSite = false) => pushCategory({ sessionId: SESSION, refId: "req-1", tool: { name, onSite } }, "permission");
    expect(at("Bash")).toBe("permission");
    expect(at("computer_act")).toBe("permission.space");
    expect(at("browser_fill_credential", true)).toBe("permission.site");
    expect(at("browser_fill_credential", false)).toBe("permission");
  });

  it("leaves to the app what a notification cannot answer: a plan, a question, a blocked run, and anything without a session", () => {
    const tool = { name: "Bash", onSite: false };
    expect(pushCategory({ sessionId: SESSION, refId: "req-1", tool: { name: "ExitPlanMode", onSite: false } }, "permission")).toBeNull();
    expect(pushCategory({ sessionId: SESSION, refId: "req-1", tool: { name: "AskUserQuestion", onSite: false } }, "question")).toBeNull();
    expect(pushCategory({ sessionId: SESSION, refId: "run-1" }, "blocked")).toBeNull();
    expect(pushCategory({ sessionId: null, refId: "req-1", tool }, "permission")).toBeNull();
    expect(pushCategory({ sessionId: SESSION, refId: null, tool }, "permission")).toBeNull();
    expect(pushCategory({ sessionId: null, refId: "run-1" }, "finished")).toBeNull();
  });
});

describe("what a push says", () => {
  it("is one line of at most 120 characters", () => {
    expect(pushLine("Run\n  `pnpm   test`\tnow")).toBe("Run `pnpm test` now");
    const long = pushLine("x".repeat(400));
    expect(long).toHaveLength(120);
    expect(long.endsWith("…")).toBe(true);
    expect(pushLine(null)).toBe("");
  });

  it("counts a moment as waiting until it is answered — or, for a finished turn, read — and a row that is gone as not", () => {
    const row: Notification = { id: "n", category: "permission", spaceId: null, sessionId: null, refId: "r", title: "t", body: null, createdAt: 0, readAt: 3, actedAt: null };
    expect(stillWaiting(row)).toBe(true);
    expect(stillWaiting({ ...row, actedAt: 4 })).toBe(false);
    expect(stillWaiting({ ...row, category: "run_blocked" })).toBe(true);
    expect(stillWaiting({ ...row, category: "session_done", actedAt: 1, readAt: null })).toBe(true);
    expect(stillWaiting({ ...row, category: "session_done", actedAt: 1, readAt: 2 })).toBe(false);
    expect(stillWaiting(null)).toBe(false);
  });
});
