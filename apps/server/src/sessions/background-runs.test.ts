import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { AsyncQueue, type AgentAdapter, type AgentHandle, type UserMessage } from "@realm/adapters";
import { sessionEvent, type Session, type SessionEvent, type SessionEventPayload } from "@realm/contracts";
import { openDatabase, type Db } from "../db/database";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { ProjectsStore } from "../store/projects";
import { ItemsStore } from "../store/items";
import { EnvironmentsStore } from "../store/environments";
import { SessionsStore, SessionEventsStore } from "../store/sessions";
import { SettingsStore } from "../store/settings";
import { NotificationsStore } from "../store/notifications";
import { NotificationsService } from "../notifications/service";
import { BrowserPermissionBroker } from "../browsers/permissions";
import { SessionService } from "./service";
import { waitFor } from "../test-utils";

/** What a driven handle was asked to do, for a test to read back. */
type DrivenHandle = { events: AsyncQueue<SessionEvent>; sent: UserMessage[]; stops: string[]; interrupts: number };

/**
 * An adapter the test speaks for. A handle says nothing by itself: every event a session's agent
 * says is one the test pushed onto its queue, which is the only way to put a status, a card and a
 * background run in the orders a workflow really produces them — a card raised with no turn in
 * flight, a turn that ends under one, a run alive in a session at rest. The scripted adapter cannot
 * say any of those, and it must not learn `stopTask`, which only Claude has.
 *
 * `kind: "claude"` because that is the agent whose runs these are. `stoppable` and `refuse` shape
 * the handle's `stopTask`: absent altogether, or rejecting the way the Claude adapter does. `onStop`
 * is what the harness says while a stop is out, before the call answers: a stop can be what ends a
 * turn, and the settle it produces has to reach the service while it is still waiting on the call.
 */
class DrivenAdapter implements AgentAdapter {
  readonly kind = "claude" as const;
  readonly handles: DrivenHandle[] = [];
  stoppable = true;
  refuse = false;
  onStop: ((h: DrivenHandle) => Promise<void>) | null = null;

  async probe() { return { kind: this.kind, available: true, version: "test", loggedIn: true, reason: null }; }

  start(): AgentHandle {
    const h: DrivenHandle = { events: new AsyncQueue<SessionEvent>(), sent: [], stops: [], interrupts: 0 };
    this.handles.push(h);
    return {
      events: h.events,
      send: async (m) => { h.sent.push(m); },
      respondPermission: () => {},
      interrupt: async () => { h.interrupts++; },
      setOptions: async () => {},
      ...(this.stoppable ? { stopTask: async (toolUseId: string) => {
        h.stops.push(toolUseId);
        if (this.refuse) throw new Error("Claude Code could not stop that run.");
        await this.onStop?.(h);
      } } : {}),
      dispose: async () => { h.events.push(sessionEvent("status", { status: "ended" })); h.events.close(); },
    };
  }
}

/**
 * The session service over a real database, with the driven adapter, the real permission broker
 * wired to it the way `createApp` wires it, and the real notifications feed. A hand-built graph
 * rather than `createApp` because what is under test is the service's reading of events no scripted
 * agent can produce. Everything it never reaches here is a stub of the one method `ensureLive`
 * calls, and every hook that starts work nobody asked for (the recap, a goal's next turn, failover)
 * records that it was called instead.
 */
function build(db: Db, home: string) {
  const sessionsStore = new SessionsStore(db);
  const events = new SessionEventsStore(db);
  const settings = new SettingsStore(db);
  const feedStore = new NotificationsStore(db);
  const broadcasts: { event: string; payload: unknown }[] = [];
  const rpc = { broadcast: (event: string, payload: unknown) => { broadcasts.push({ event, payload }); } };
  const feed = new NotificationsService({ store: feedStore, settings, rpc: rpc as never });
  const adapter = new DrivenAdapter();
  const heard = { recaps: [] as string[], goalSettles: [] as { interrupted: boolean; unprompted: boolean }[], goalErrors: [] as string[], failover: [] as string[] };
  const late: { sessions: SessionService | null } = { sessions: null };
  const broker = new BrowserPermissionBroker({
    permissionMode: () => "default",
    emit: (id, ev) => late.sessions?.emitExternal(id, ev),
    restore: (id) => late.sessions?.restoreStatus(id),
  });
  const sessions = new SessionService({
    db, rpc, sessions: sessionsStore, events, items: new ItemsStore(db), spaces: new SpacesStore(db, home),
    projects: new ProjectsStore(db), environments: new EnvironmentsStore(db), settings,
    worktrees: {}, ports: { ensureBlock: async () => {} }, terminals: {},
    adapters: { claude: adapter },
    skills: { injectionFor: () => null, wouldInject: () => false },
    gateway: { register: () => ({ name: "realm", transport: "http", url: "http://127.0.0.1:1/mcp", headers: {} }), release: () => {}, realmProvidersFor: () => [] },
    memory: { systemContextFor: () => undefined, sourcesFor: () => ({}) },
    browserPermissions: broker,
    notifications: { handleSessionEvent: (s: Session, ev: SessionEvent) => feed.handleSessionEvent(s, ev), probeResults: () => {} },
    summaries: { onSettled: async (id: string) => { heard.recaps.push(id); } },
    goals: {
      onUsage: () => {},
      onError: (id: string) => { heard.goalErrors.push(id); },
      onSettled: async (_id: string, o: { interrupted: boolean; unprompted: boolean }) => { heard.goalSettles.push(o); },
    },
    failover: {
      turnStarted: () => {}, cancel: () => {}, release: () => {}, close: () => {}, extraSystemContext: () => undefined,
      onError: (_s: unknown, message: string) => { heard.failover.push(message); },
    },
  } as never);
  late.sessions = sessions;
  return { sessions, adapter, broker, events, sessionsStore, feedStore, heard, broadcasts };
}

let db: Db; let home: string; let spaceId: string; let world: ReturnType<typeof build>;

beforeEach(() => {
  home = tempDir("realm-background-runs-");
  db = openDatabase(join(home, "realm.db"));
  const profile = new ProfilesStore(db).create({ name: "P", icon: "x", color: "#000" });
  spaceId = new SpacesStore(db, home).create({ profileId: profile.id, name: "Work", icon: "folder" }).id;
  world = build(db, home);
});

afterEach(async () => {
  await world.sessions.closeAll();
  for (const s of world.sessionsStore.listAll()) world.broker.release(s.id);
  db.close();
});

/** Past every consequence of what was just pushed: the pump and everything it starts here are chains
 *  of microtasks over a synchronous database, so one turn of the timer queue is behind all of them. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const status = (s: SessionEventPayload<"status">["status"], marks: Omit<SessionEventPayload<"status">, "status"> = {}) => sessionEvent("status", { status: s, ...marks });
const task = (toolUseId: string, s: "running" | "stopped", ts?: number) => sessionEvent("background_task", { toolUseId, status: s }, ts);
const newSession = () => world.sessions.create({ spaceId, projectId: null, agentKind: "claude", model: null, effort: null, permissionMode: "default" }).session;
/** What the harness does as it kills a run whose card held a turn's settle: the card closes and the
 *  adapter pays that settle, and the service has taken it in before the stop's own answer arrives. */
const settlesDuringStop = async (h: DrivenHandle) => { h.events.push(status("idle")); await flush(); };

/** A session whose first message has gone out, so it holds a live handle the test now speaks for. */
async function live() {
  const s = newSession();
  await world.sessions.send(s.id, { text: "go", attachments: [] });
  const handle = world.adapter.handles.at(-1)!;
  const say = async (...evs: SessionEvent[]) => { for (const e of evs) handle.events.push(e); await flush(); };
  return { id: s.id, environmentId: s.environmentId, handle, say };
}

/**
 * A session at rest with one message parked in its queue, because the turn it waited behind was
 * stopped, and with the feed already read. So anything that took a later status for a settle shows:
 * a new feed row, a second recap, a goal step, or the parked message going out.
 */
async function parked() {
  const s = await live();
  await s.say(status("running"));
  await world.sessions.send(s.id, { text: "queued", attachments: [] });
  await s.say(status("idle", { interrupted: true }));
  world.feedStore.markAllRead();
  return s;
}

/** A session at rest with one run alive, which is where a run's own stop control is pressed. */
async function oneRunAtRest() {
  const s = await live();
  await s.say(status("running"), task("t1", "running"), status("idle"));
  return s;
}

/** `promise`, or a failure after `ms`: for a wait the service bounds at ten seconds of its own. */
async function within<T>(ms: number, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`still waiting after ${ms}ms`)), ms); });
  try { return await Promise.race([promise, late]); } finally { clearTimeout(timer); }
}

const row = (id: string) => world.sessionsStore.get(id)!;
const logged = (id: string) => world.events.listAfter(id, 0, 1000).map((e) => e.event);
const statusesLogged = (id: string) => logged(id).flatMap((e) => (e.type === "status" ? [e.payload] : []));
const tasksLogged = (id: string) => logged(id).flatMap((e) => (e.type === "background_task" ? [e.payload] : []));
const doneRows = () => world.feedStore.list({ cursor: null, limit: 100 }).notifications.filter((n) => n.category === "session_done");
const queued = (id: string) => world.sessions.queuedPrompts(id).map((q) => q.text);
const texts = (h: DrivenHandle) => h.sent.map((m) => m.text);
/** The broker's card on this session: the newest request in its log. */
const cardOf = (id: string) => logged(id).flatMap((e) => (e.type === "permission_request" ? [e.payload.requestId] : [])).at(-1)!;
const openBrokerCard = (id: string) => world.broker.gate(id, "browser_act", "Click Submit", {});
/** Every status a window was told this session has, in order: what `session.status` carried. */
const announced = (id: string) => world.broadcasts.flatMap((b) => {
  const p = b.payload as { sessionId: string; status: string };
  return b.event === "session.status" && p.sessionId === id ? [p.status] : [];
});
/** What the goal was told of the person stopping the session, which is what pauses it. */
const goalStops = () => world.heard.goalSettles.filter((o) => o.interrupted);

describe("a settle, and the idle that is not one", () => {
  it("still sends the queued message when a turn settles", async () => {
    const s = await live();
    await s.say(status("running"));
    await world.sessions.send(s.id, { text: "next", attachments: [] });
    await s.say(status("idle"));
    await waitFor(() => s.handle.sent.length === 2);
    expect(texts(s.handle)).toEqual(["go", "next"]);
  });

  it("still asks for the recap when a turn settles", async () => {
    const s = await live();
    await s.say(status("running"));
    await world.sessions.send(s.id, { text: "next", attachments: [] });
    await s.say(status("idle"));
    await waitFor(() => s.handle.sent.length === 2);
    expect(world.heard.recaps).toEqual([s.id]);
  });

  it("still writes the feed row when a turn settles", async () => {
    const s = await live();
    await s.say(status("running"));
    await world.sessions.send(s.id, { text: "next", attachments: [] });
    await s.say(status("idle"));
    await waitFor(() => s.handle.sent.length === 2);
    expect(doneRows()).toHaveLength(1);
  });

  it("tells the goal that a settle was of a turn somebody sent", async () => {
    const s = await live();
    await s.say(status("running"), status("idle"));
    expect(world.heard.goalSettles).toEqual([{ interrupted: false, unprompted: false }]);
  });

  it("tells the goal that a settle was of a turn nobody sent, as the adapter marked it", async () => {
    const s = await live();
    await s.say(status("running"), status("idle", { unprompted: true }));
    expect(world.heard.goalSettles).toEqual([{ interrupted: false, unprompted: true }]);
  });

  it("still asks for the recap at the settle of a turn nobody sent", async () => {
    const s = await live();
    await s.say(status("running"), status("idle", { unprompted: true }));
    expect(world.heard.recaps).toEqual([s.id]);
  });

  it("writes no feed row for the idle that closes a card raised between turns", async () => {
    const s = await parked();
    await s.say(status("waiting_permission", { betweenTurns: true }), status("idle", { betweenTurns: true }));
    expect(doneRows()).toHaveLength(1);
  });

  it("asks for no recap on the idle that closes a card raised between turns", async () => {
    const s = await parked();
    await s.say(status("waiting_permission", { betweenTurns: true }), status("idle", { betweenTurns: true }));
    expect(world.heard.recaps).toHaveLength(1);
  });

  it("takes no goal step on the idle that closes a card raised between turns", async () => {
    const s = await parked();
    await s.say(status("waiting_permission", { betweenTurns: true }), status("idle", { betweenTurns: true }));
    expect(world.heard.goalSettles).toEqual([{ interrupted: true, unprompted: false }]);
  });

  it("drains nothing from the queue on the idle that closes a card raised between turns", async () => {
    const s = await parked();
    await s.say(status("waiting_permission", { betweenTurns: true }), status("idle", { betweenTurns: true }));
    expect(queued(s.id)).toEqual(["queued"]);
    expect(texts(s.handle)).toEqual(["go"]);
  });

  it("leaves the queue parked when that idle is also marked interrupted", async () => {
    const s = await parked();
    await s.say(status("waiting_permission", { betweenTurns: true }), status("idle", { betweenTurns: true, interrupted: true }));
    expect(queued(s.id)).toEqual(["queued"]);
    expect(texts(s.handle)).toEqual(["go"]);
  });

  it("still releases a caller waiting for the session to come to rest on a between-turns idle", async () => {
    const s = await live();
    await s.say(status("running"), status("idle"), status("waiting_permission", { betweenTurns: true }));
    const delivered = world.sessions.deliverInterjection(s.id, { text: "a question", from: { sessionId: s.id, title: "Peer" } }, { interruptFirst: true });
    await flush();
    await s.say(status("idle", { betweenTurns: true, interrupted: true }));
    await within(2_000, delivered);
    expect(texts(s.handle)).toEqual(["go", "a question"]);
  });
});

describe("a message sent while the session waits on a card", () => {
  it("is delivered at once, and not queued, when the card was raised between turns", async () => {
    const s = await live();
    await s.say(status("running"), status("idle"), status("waiting_permission", { betweenTurns: true }));
    await world.sessions.send(s.id, { text: "also this", attachments: [] });
    expect(texts(s.handle)).toEqual(["go", "also this"]);
    expect(queued(s.id)).toEqual([]);
  });

  it("interrupts nothing when it is sent now while the card was raised between turns", async () => {
    const s = await live();
    await s.say(status("running"), status("idle"), status("waiting_permission", { betweenTurns: true }));
    await world.sessions.send(s.id, { text: "also this", attachments: [] }, "steer");
    expect(s.handle.interrupts).toBe(0);
    expect(texts(s.handle)).toEqual(["go", "also this"]);
  });

  it("is still queued when the card was raised in a turn", async () => {
    const s = await live();
    await s.say(status("running"), status("waiting_permission"));
    await world.sessions.send(s.id, { text: "later", attachments: [] });
    expect(queued(s.id)).toEqual(["later"]);
    expect(texts(s.handle)).toEqual(["go"]);
  });

  it("is delivered at once when the only card open is the broker's and the adapter is at rest", async () => {
    const s = await live();
    await s.say(status("running"), status("idle"));
    void openBrokerCard(s.id);
    const waiting = row(s.id).status;
    await world.sessions.send(s.id, { text: "also this", attachments: [] });
    expect(waiting).toBe("waiting_permission");
    expect(texts(s.handle)).toEqual(["go", "also this"]);
    expect(queued(s.id)).toEqual([]);
  });

  it("is still queued when the broker's card is open in a turn", async () => {
    const s = await live();
    await s.say(status("running"));
    void openBrokerCard(s.id);
    await world.sessions.send(s.id, { text: "later", attachments: [] });
    expect(queued(s.id)).toEqual(["later"]);
  });

  it("is still queued when a live adapter has said nothing yet, as a wait always was", async () => {
    const s = await live();
    void openBrokerCard(s.id);
    await world.sessions.send(s.id, { text: "later", attachments: [] });
    expect(queued(s.id)).toEqual(["later"]);
  });
});

describe("the broker's card and the session's status", () => {
  it("says running again when the broker's last card closes in a turn", async () => {
    const s = await live();
    await s.say(status("running"));
    const gate = openBrokerCard(s.id);
    world.broker.resolve(cardOf(s.id), "allow");
    await gate;
    expect(statusesLogged(s.id).slice(-2)).toEqual([{ status: "waiting_permission" }, { status: "running" }]);
    expect(row(s.id).status).toBe("running");
  });

  it("says nothing when the broker's card closes while the adapter has a card of its own open", async () => {
    const s = await live();
    await s.say(status("running"));
    const gate = openBrokerCard(s.id);
    await s.say(status("waiting_permission"));
    const before = statusesLogged(s.id).length;
    world.broker.resolve(cardOf(s.id), "allow");
    await gate;
    expect(statusesLogged(s.id)).toHaveLength(before);
    expect(row(s.id).status).toBe("waiting_permission");
  });

  it("says idle marked betweenTurns when the broker's card closes with the adapter at rest", async () => {
    const s = await live();
    await s.say(status("running"), status("idle"));
    const gate = openBrokerCard(s.id);
    world.broker.resolve(cardOf(s.id), "allow");
    await gate;
    expect(statusesLogged(s.id).at(-1)).toEqual({ status: "idle", betweenTurns: true });
    expect(row(s.id).status).toBe("idle");
  });

  it("marks the wait betweenTurns when the broker raises its card with the adapter at rest", async () => {
    const s = await live();
    await s.say(status("running"), status("idle"));
    void openBrokerCard(s.id);
    expect(statusesLogged(s.id).at(-1)).toEqual({ status: "waiting_permission", betweenTurns: true });
  });

  it("settles nothing a second time when the broker's card closes with the adapter at rest", async () => {
    const s = await live();
    await s.say(status("running"), status("idle"));
    const gate = openBrokerCard(s.id);
    world.broker.resolve(cardOf(s.id), "allow");
    await gate;
    expect(world.heard.recaps).toEqual([s.id]);
    expect(doneRows()).toHaveLength(1);
  });

  it("says running when the card closes on a live session whose adapter has said nothing yet", async () => {
    const s = await live();
    const gate = openBrokerCard(s.id);
    world.broker.resolve(cardOf(s.id), "allow");
    await gate;
    expect(statusesLogged(s.id)).toEqual([{ status: "waiting_permission" }, { status: "running" }]);
  });

  it("puts a session with no process back to idle, marked betweenTurns, when a card closes on it", async () => {
    const s = newSession();
    const gate = openBrokerCard(s.id);
    world.broker.resolve(cardOf(s.id), "allow");
    await gate;
    expect(statusesLogged(s.id)).toEqual([{ status: "waiting_permission", betweenTurns: true }, { status: "idle", betweenTurns: true }]);
  });

  it("delivers a message at once on a session with no process, though a server card is open", async () => {
    const s = newSession();
    void openBrokerCard(s.id);
    await world.sessions.send(s.id, { text: "now", attachments: [] });
    expect(world.adapter.handles.map(texts)).toEqual([["now"]]);
  });

  it("takes no settle from a new process's first idle under a server card", async () => {
    const s = newSession();
    void openBrokerCard(s.id);
    await world.sessions.send(s.id, { text: "now", attachments: [] });
    world.adapter.handles.at(-1)!.events.push(status("idle"));
    await flush();
    expect(world.heard.recaps).toEqual([]);
  });

  it("takes one goal step when the adapter says idle twice under the broker's card", async () => {
    const s = await live();
    await s.say(status("running"));
    void openBrokerCard(s.id);
    await s.say(status("idle"), status("idle"));
    expect(world.heard.goalSettles).toEqual([{ interrupted: false, unprompted: false }]);
  });

  it("asks for one recap when the adapter says idle twice under the broker's card", async () => {
    const s = await live();
    await s.say(status("running"));
    void openBrokerCard(s.id);
    await s.say(status("idle"), status("idle"));
    expect(world.heard.recaps).toEqual([s.id]);
  });

  it("still settles a second turn under the broker's card when running came between the two idles", async () => {
    const s = await live();
    await s.say(status("running"));
    void openBrokerCard(s.id);
    await s.say(status("idle"), status("running"), status("idle"));
    expect(world.heard.recaps).toEqual([s.id, s.id]);
  });

  it("follows the adapter's running with the wait while the broker's card is open", async () => {
    const s = await live();
    await s.say(status("running"));
    void openBrokerCard(s.id);
    await s.say(status("waiting_permission"), status("running"));
    expect(statusesLogged(s.id).slice(-2)).toEqual([{ status: "running" }, { status: "waiting_permission" }]);
    expect(row(s.id).status).toBe("waiting_permission");
  });

  it("settles a turn that ends under the broker's card", async () => {
    const s = await live();
    await s.say(status("running"));
    void openBrokerCard(s.id);
    await s.say(status("idle"));
    expect(world.heard.recaps).toEqual([s.id]);
  });

  it("writes one feed row for a turn that ends under the broker's card", async () => {
    const s = await live();
    await s.say(status("running"));
    void openBrokerCard(s.id);
    await s.say(status("idle"));
    expect(doneRows()).toHaveLength(1);
  });

  it("still sends the queued message when a turn ends under the broker's card", async () => {
    const s = await live();
    await s.say(status("running"));
    await world.sessions.send(s.id, { text: "next", attachments: [] });
    void openBrokerCard(s.id);
    await s.say(status("idle"));
    await waitFor(() => s.handle.sent.length === 2);
    expect(texts(s.handle)).toEqual(["go", "next"]);
  });

  it("follows the idle of a turn that ends under the broker's card with the wait", async () => {
    const s = await live();
    await s.say(status("running"));
    void openBrokerCard(s.id);
    await s.say(status("idle"));
    expect(statusesLogged(s.id).slice(-2)).toEqual([{ status: "idle" }, { status: "waiting_permission", betweenTurns: true }]);
  });

  it("tells the window nothing but the wait when the adapter says running under the broker's card", async () => {
    const s = await live();
    await s.say(status("running"));
    void openBrokerCard(s.id);
    const before = announced(s.id).length;
    await s.say(status("waiting_permission"), status("running"));
    expect(announced(s.id).slice(before)).toEqual(["waiting_permission", "waiting_permission"]);
  });

  it("tells the window nothing but the wait when a turn ends under the broker's card", async () => {
    const s = await live();
    await s.say(status("running"));
    void openBrokerCard(s.id);
    const before = announced(s.id).length;
    await s.say(status("idle"));
    expect(announced(s.id).slice(before)).toEqual(["waiting_permission"]);
  });

  it("still sends the adapter's own status to the window as an event of the session under the broker's card", async () => {
    const s = await live();
    await s.say(status("running"));
    void openBrokerCard(s.id);
    await s.say(status("idle"));
    const sent = world.broadcasts.flatMap((b) => (b.event === "session.event" ? [(b.payload as { event: SessionEvent }).event] : []));
    expect(sent.flatMap((e) => (e.type === "status" ? [e.payload] : [])).slice(-2)).toEqual([{ status: "idle" }, { status: "waiting_permission", betweenTurns: true }]);
  });

  it("moves the row again with the adapter's status once the broker's card has closed", async () => {
    const s = await live();
    await s.say(status("running"));
    const gate = openBrokerCard(s.id);
    world.broker.resolve(cardOf(s.id), "allow");
    await gate;
    const before = announced(s.id).length;
    await s.say(status("idle"));
    expect(announced(s.id).slice(before)).toEqual(["idle"]);
  });

  it("does not take the adapter's own word from a status it composed itself", async () => {
    const s = await live();
    await s.say(status("running"));
    const gate = openBrokerCard(s.id);
    await s.say(status("idle"));
    world.broker.resolve(cardOf(s.id), "allow");
    await gate;
    expect(statusesLogged(s.id).at(-1)).toEqual({ status: "idle", betweenTurns: true });
    expect(world.heard.recaps).toEqual([s.id]);
  });

  it("leaves ended as the last word when the process goes while the broker's card is open", async () => {
    const s = await live();
    await s.say(status("running"));
    void openBrokerCard(s.id);
    await world.sessions.stopAgent(s.id);
    expect(statusesLogged(s.id).at(-1)).toEqual({ status: "ended" });
    expect(row(s.id).status).toBe("ended");
  });
});

describe("a card of the server's own, and a process that ends", () => {
  it("refuses the call that was waiting on the server's card when the session's process ends", async () => {
    const s = await live();
    await s.say(status("running"));
    const gate = openBrokerCard(s.id);
    await world.sessions.stopAgent(s.id);
    expect((await within(2_000, gate)).allowed).toBe(false);
  });

  it("writes the card's denial to the log when the session's process ends", async () => {
    const s = await live();
    await s.say(status("running"));
    void openBrokerCard(s.id);
    const card = cardOf(s.id);
    await world.sessions.stopAgent(s.id);
    expect(logged(s.id).flatMap((e) => (e.type === "permission_response" ? [e.payload] : []))).toEqual([{ requestId: card, decision: "deny" }]);
  });

  it("says nothing when a card closes on a session whose process has ended", async () => {
    const s = await live();
    await s.say(status("running"));
    void openBrokerCard(s.id);
    await world.sessions.stopAgent(s.id);
    expect(logged(s.id).slice(-2).map((e) => (e.type === "status" ? e.payload.status : e.type))).toEqual(["ended", "permission_response"]);
  });

  it("does not follow the next process's running with a wait for a card the last process left", async () => {
    const s = await live();
    await s.say(status("running"));
    void openBrokerCard(s.id);
    await world.sessions.stopAgent(s.id);
    await world.sessions.send(s.id, { text: "again", attachments: [] });
    world.adapter.handles.at(-1)!.events.push(status("running"));
    await flush();
    expect(statusesLogged(s.id).at(-1)).toEqual({ status: "running" });
  });

  it("still closes the runs a process left behind when closing its cards fails", async () => {
    const s = await live();
    await s.say(status("running"), task("t1", "running"), status("idle"));
    world.broker.withdraw = () => { throw new Error("the broker is gone"); };
    await world.sessions.stopAgent(s.id);
    expect(tasksLogged(s.id).at(-1)).toEqual({ toolUseId: "t1", status: "stopped", outcome: "stopped" });
  });
});

describe("Stop, and a card of the server's own", () => {
  it("refuses the call that was waiting on the card when the session is stopped", async () => {
    const s = await live();
    await s.say(status("running"));
    const gate = openBrokerCard(s.id);
    await world.sessions.interrupt(s.id);
    expect((await gate).allowed).toBe(false);
    expect(s.handle.interrupts).toBe(1);
  });

  it("writes the card's denial to the log when the session is stopped", async () => {
    const s = await live();
    await s.say(status("running"));
    void openBrokerCard(s.id);
    const card = cardOf(s.id);
    await world.sessions.interrupt(s.id);
    expect(logged(s.id).flatMap((e) => (e.type === "permission_response" ? [e.payload] : []))).toEqual([{ requestId: card, decision: "deny" }]);
  });

  it("reads idle once the stopped turn settles, with no card left to wait on", async () => {
    const s = await live();
    await s.say(status("running"));
    void openBrokerCard(s.id);
    await world.sessions.interrupt(s.id);
    await s.say(status("idle", { interrupted: true }));
    expect(statusesLogged(s.id).slice(-3)).toEqual([{ status: "waiting_permission" }, { status: "running" }, { status: "idle", interrupted: true }]);
    expect(row(s.id).status).toBe("idle");
  });

  it("closes the server's card before a message sent now interrupts the turn", async () => {
    const s = await live();
    await s.say(status("running"));
    const gate = openBrokerCard(s.id);
    const sent = world.sessions.send(s.id, { text: "do this instead", attachments: [] }, "steer");
    await flush();
    await s.say(status("idle", { interrupted: true }));
    await within(2_000, sent);
    expect((await gate).allowed).toBe(false);
    expect(texts(s.handle)).toEqual(["go", "do this instead"]);
  });

  it("leaves the card alone when the session has no live process to stop", async () => {
    const s = newSession();
    void openBrokerCard(s.id);
    await world.sessions.interrupt(s.id);
    expect(world.broker.holds(s.id)).toBe(true);
  });
});

describe("Stop with no turn in flight, and the session's goal", () => {
  it("tells the goal of the stop when Stop is pressed on a card raised between turns", async () => {
    const s = await live();
    await s.say(status("running"), task("t1", "running"), status("idle"), status("waiting_permission", { betweenTurns: true }));
    await world.sessions.interrupt(s.id);
    await s.say(status("idle", { betweenTurns: true, interrupted: true }));
    expect(goalStops()).toEqual([{ interrupted: true, unprompted: false }]);
  });

  it("tells the goal of the stop when Stop closes the server's own card between turns", async () => {
    const s = await live();
    await s.say(status("running"), task("t1", "running"), status("idle"));
    void openBrokerCard(s.id);
    await world.sessions.interrupt(s.id);
    expect(goalStops()).toEqual([{ interrupted: true, unprompted: false }]);
  });

  it("tells the goal once when Stop is pressed in a turn, through that turn's own settle", async () => {
    const s = await live();
    await s.say(status("running"));
    await world.sessions.interrupt(s.id);
    await s.say(status("idle", { interrupted: true }));
    expect(goalStops()).toHaveLength(1);
  });

  it("tells the goal once when Stop is pressed on a card whose turn has already ended", async () => {
    const s = await live();
    await s.say(status("running"), status("waiting_permission"));
    await world.sessions.interrupt(s.id);
    await s.say(status("idle", { interrupted: true }));
    expect(goalStops()).toHaveLength(1);
  });

  it("tells the goal nothing when the session has no live process to stop", async () => {
    const s = newSession();
    await world.sessions.interrupt(s.id);
    expect(world.heard.goalSettles).toEqual([]);
  });
});

describe("stopping the last thing a session has going", () => {
  it("tells the goal of the stop when the session's only run is stopped at rest", async () => {
    const s = await oneRunAtRest();
    await world.sessions.stopTask(s.id, "t1");
    expect(goalStops()).toEqual([{ interrupted: true, unprompted: false }]);
  });

  it("tells the goal nothing when one of two runs is stopped", async () => {
    const s = await oneRunAtRest();
    await s.say(task("t2", "running"));
    await world.sessions.stopTask(s.id, "t1");
    expect(goalStops()).toEqual([]);
  });

  it("tells the goal nothing when a run is stopped during a turn", async () => {
    const s = await live();
    await s.say(status("running"), task("t1", "running"));
    await world.sessions.stopTask(s.id, "t1");
    expect(goalStops()).toEqual([]);
  });

  it("tells the goal of the stop when the session's only run is stopped while its launch turn's settle waited on that run's card", async () => {
    const s = await live();
    await s.say(status("running"), task("t1", "running"), status("waiting_permission"));
    world.adapter.onStop = settlesDuringStop;
    await world.sessions.stopTask(s.id, "t1");
    expect(goalStops()).toEqual([{ interrupted: true, unprompted: false }]);
  });

  it("tells the goal nothing when the harness refuses the stop", async () => {
    world.adapter.refuse = true;
    const s = await oneRunAtRest();
    await world.sessions.stopTask(s.id, "t1").catch(() => {});
    expect(goalStops()).toEqual([]);
  });

  it("tells the goal nothing when the stop names a call that is not the run alive", async () => {
    const s = await oneRunAtRest();
    await world.sessions.stopTask(s.id, "some-other-call");
    expect(goalStops()).toEqual([]);
  });

  it("closes the server's card when the session's only run is stopped at rest", async () => {
    const s = await oneRunAtRest();
    const gate = openBrokerCard(s.id);
    await world.sessions.stopTask(s.id, "t1");
    expect((await within(2_000, gate)).allowed).toBe(false);
  });

  it("closes the server's card when the session's only run is stopped while its launch turn's settle waited on that run's card", async () => {
    const s = await live();
    await s.say(status("running"), task("t1", "running"), status("waiting_permission"));
    const gate = openBrokerCard(s.id);
    world.adapter.onStop = settlesDuringStop;
    await world.sessions.stopTask(s.id, "t1");
    expect((await within(2_000, gate)).allowed).toBe(false);
  });

  it("reads idle once that stop has closed the server's card", async () => {
    const s = await oneRunAtRest();
    void openBrokerCard(s.id);
    await world.sessions.stopTask(s.id, "t1");
    expect(row(s.id).status).toBe("idle");
  });

  it("leaves the server's card open when one of two runs is stopped", async () => {
    const s = await oneRunAtRest();
    await s.say(task("t2", "running"));
    void openBrokerCard(s.id);
    await world.sessions.stopTask(s.id, "t1");
    expect(world.broker.holds(s.id)).toBe(true);
  });

  it("leaves the server's card open when a run is stopped during a turn", async () => {
    const s = await live();
    await s.say(status("running"), task("t1", "running"));
    void openBrokerCard(s.id);
    await world.sessions.stopTask(s.id, "t1");
    expect(world.broker.holds(s.id)).toBe(true);
  });

  it("leaves the server's card open when the harness refuses the stop", async () => {
    world.adapter.refuse = true;
    const s = await oneRunAtRest();
    void openBrokerCard(s.id);
    await world.sessions.stopTask(s.id, "t1").catch(() => {});
    expect(world.broker.holds(s.id)).toBe(true);
  });
});

describe("a session at rest, which is what the recap waits for", () => {
  it("counts a session that reads idle as at rest", async () => {
    const s = await live();
    await s.say(status("running"), status("idle"));
    expect(world.sessions.atRest(s.id)).toBe(true);
  });

  it("does not count a session in a turn as at rest", async () => {
    const s = await live();
    await s.say(status("running"));
    expect(world.sessions.atRest(s.id)).toBe(false);
  });

  it("counts a session that waits on a card raised between turns as at rest", async () => {
    const s = await live();
    await s.say(status("running"), status("idle"), status("waiting_permission", { betweenTurns: true }));
    expect(world.sessions.atRest(s.id)).toBe(true);
  });

  it("counts a session whose only open card is the server's, with the adapter at rest, as at rest", async () => {
    const s = await live();
    await s.say(status("running"), status("idle"));
    void openBrokerCard(s.id);
    expect(world.sessions.atRest(s.id)).toBe(true);
  });

  it("does not count a session whose turn's settle waits for a card as at rest", async () => {
    const s = await live();
    await s.say(status("running"), status("waiting_permission"));
    expect(world.sessions.atRest(s.id)).toBe(false);
  });

  it("does not count a session whose turn runs under the server's card as at rest", async () => {
    const s = await live();
    await s.say(status("running"));
    void openBrokerCard(s.id);
    expect(world.sessions.atRest(s.id)).toBe(false);
  });
});

describe("an error in a turn nobody sent", () => {
  const unprompted = sessionEvent("error", { message: "API Error: 400", unprompted: true });

  it("is kept from failover, which has no message of that turn to send again", async () => {
    const s = await live();
    await s.say(status("running"), unprompted, status("idle"));
    expect(world.heard.failover).toEqual([]);
  });

  it("is still counted by goal mode", async () => {
    const s = await live();
    await s.say(status("running"), unprompted, status("idle"));
    expect(world.heard.goalErrors).toEqual([s.id]);
  });

  it("is still written to the log, mark and all", async () => {
    const s = await live();
    await s.say(status("running"), unprompted, status("idle"));
    expect(logged(s.id).flatMap((e) => (e.type === "error" ? [e.payload] : []))).toEqual([{ message: "API Error: 400", unprompted: true }]);
  });

  it("leaves an error in a turn somebody sent on its way to failover", async () => {
    const s = await live();
    await s.say(status("running"), sessionEvent("error", { message: "Claude AI usage limit reached" }), status("idle"));
    expect(world.heard.failover).toEqual(["Claude AI usage limit reached"]);
  });
});

describe("a run alive in a session at rest", () => {
  it("keeps the session's environment busy", async () => {
    const s = await live();
    await s.say(status("running"), task("t1", "running"), status("idle"));
    expect(world.sessions.isEnvironmentBusy(s.environmentId)).toBe(true);
  });

  it("frees the environment when the run stops", async () => {
    const s = await live();
    await s.say(status("running"), task("t1", "running"), status("idle"), task("t1", "stopped"));
    expect(world.sessions.isEnvironmentBusy(s.environmentId)).toBe(false);
  });

  it("counts the session as working", async () => {
    const s = await live();
    await s.say(status("running"), task("t1", "running"), status("idle"));
    expect(world.sessions.statusCounts()).toEqual({ working: 1, needsYou: 0 });
  });

  it("stops counting the session as working when the run stops", async () => {
    const s = await live();
    await s.say(status("running"), task("t1", "running"), status("idle"), task("t1", "stopped"));
    expect(world.sessions.statusCounts()).toEqual({ working: 0, needsYou: 0 });
  });

  it("counts a session whose run goes on behind an open card as working and as needing you", async () => {
    const s = await live();
    await s.say(status("running"), task("t1", "running"), status("idle"), status("waiting_permission", { betweenTurns: true }));
    expect(world.sessions.statusCounts()).toEqual({ working: 1, needsYou: 1 });
  });

  it("counts a session that waits on a card with no run alive as needing you only, as it always did", async () => {
    const s = await live();
    await s.say(status("running"), status("waiting_permission"));
    expect(world.sessions.statusCounts()).toEqual({ working: 0, needsYou: 1 });
  });

  it("is not ended by a stop that names another call", async () => {
    const s = await live();
    await s.say(status("running"), task("t1", "running"), task("a-shell-command", "stopped"), status("idle"));
    expect(world.sessions.hasRunAlive(s.id)).toBe(true);
  });

  it("is forgotten when the session's handle ends", async () => {
    const s = await live();
    await s.say(status("running"), task("t1", "running"), status("idle"));
    await world.sessions.stopAgent(s.id);
    expect(world.sessions.hasRunAlive(s.id)).toBe(false);
    expect(world.sessions.statusCounts().working).toBe(0);
  });
});

describe("the session's status, for whoever counts the sessions at work", () => {
  it("is said again when the session's last run stops at rest", async () => {
    const s = await live();
    await s.say(status("running"), task("t1", "running"), status("idle"));
    const before = announced(s.id).length;
    await s.say(task("t1", "stopped"));
    expect(announced(s.id).slice(before)).toEqual(["idle"]);
  });

  it("is said again only after the run's own event has gone out", async () => {
    const s = await live();
    await s.say(status("running"), task("t1", "running"), status("idle"), task("t1", "stopped"));
    expect(world.broadcasts.slice(-2).map((b) => b.event)).toEqual(["session.event", "session.status"]);
  });

  it("is said again when the session's first run starts", async () => {
    const s = await live();
    await s.say(status("running"));
    const before = announced(s.id).length;
    await s.say(task("t1", "running"));
    expect(announced(s.id).slice(before)).toEqual(["running"]);
  });

  it("is not said again when one of two runs stops", async () => {
    const s = await live();
    await s.say(status("running"), task("t1", "running"), task("t2", "running"), status("idle"));
    const before = announced(s.id).length;
    await s.say(task("t1", "stopped"));
    expect(announced(s.id).slice(before)).toEqual([]);
  });

  it("is not said again for a stop that names a call with no run alive", async () => {
    const s = await live();
    await s.say(status("running"), status("idle"));
    const before = announced(s.id).length;
    await s.say(task("a-shell-command", "stopped"));
    expect(announced(s.id).slice(before)).toEqual([]);
  });
});

describe("a run whose process is gone", () => {
  it("is closed in the log as stopped when its handle ends, because a run does not finish after its process", async () => {
    const s = await live();
    await s.say(status("running"), task("t1", "running"), status("idle"));
    await world.sessions.stopAgent(s.id);
    expect(tasksLogged(s.id)).toEqual([{ toolUseId: "t1", status: "running" }, { toolUseId: "t1", status: "stopped", outcome: "stopped" }]);
  });

  it("is broadcast as stopped when its handle ends, so an open window drops its row", async () => {
    const s = await live();
    await s.say(status("running"), task("t1", "running"), status("idle"));
    await world.sessions.stopAgent(s.id);
    const last = world.broadcasts.filter((b) => b.event === "session.event").at(-1)!.payload as { sessionId: string; event: SessionEvent; ephemeral: boolean };
    expect(last).toMatchObject({ sessionId: s.id, ephemeral: false, event: { type: "background_task", payload: { toolUseId: "t1", status: "stopped", outcome: "stopped" } } });
  });

  it("gets no second stop when the harness had already stopped it", async () => {
    const s = await live();
    await s.say(status("running"), task("t1", "running"), sessionEvent("background_task", { toolUseId: "t1", status: "stopped", outcome: "completed" }), status("idle"));
    await world.sessions.stopAgent(s.id);
    expect(tasksLogged(s.id)).toEqual([{ toolUseId: "t1", status: "running" }, { toolUseId: "t1", status: "stopped", outcome: "completed" }]);
  });

  it("is closed at boot, dated where the log stops", async () => {
    const s = newSession();
    world.events.append(s.id, task("t1", "running", 2_000));
    world.sessions.markStaleOnBoot();
    expect(logged(s.id).at(-1)).toEqual({ type: "background_task", ts: 2_000, payload: { toolUseId: "t1", status: "stopped", outcome: "stopped" } });
  });

  it("is still dated where the log stopped when boot closes a card the log left open before it", async () => {
    const s = newSession();
    world.events.append(s.id, sessionEvent("permission_request", { requestId: "r1", toolName: "Bash", input: {}, title: "Allow Bash?", suggestions: [] }, 1_000));
    world.events.append(s.id, task("t1", "running", 2_000));
    world.sessions.markStaleOnBoot();
    expect(logged(s.id).slice(-2)).toEqual([
      { type: "permission_response", ts: expect.any(Number), payload: { requestId: "r1", decision: "deny" } },
      { type: "background_task", ts: 2_000, payload: { toolUseId: "t1", status: "stopped", outcome: "stopped" } },
    ]);
  });

  it("is left alone at boot when the log already says it stopped", async () => {
    const s = newSession();
    world.events.append(s.id, task("t1", "running", 1_000));
    world.events.append(s.id, task("t1", "stopped", 2_000));
    world.sessions.markStaleOnBoot();
    expect(logged(s.id)).toHaveLength(2);
  });

  it("is written no stop while the server shuts down, where events are dropped", async () => {
    const s = await live();
    await s.say(status("running"), task("t1", "running"), status("idle"));
    await world.sessions.closeAll();
    expect(tasksLogged(s.id)).toEqual([{ toolUseId: "t1", status: "running" }]);
  });

  it("is closed at the next boot when it was alive at shutdown", async () => {
    const s = await live();
    await s.say(status("running"), task("t1", "running"), status("idle"));
    await world.sessions.closeAll();
    build(db, home).sessions.markStaleOnBoot();
    expect(tasksLogged(s.id)).toEqual([{ toolUseId: "t1", status: "running" }, { toolUseId: "t1", status: "stopped", outcome: "stopped" }]);
  });

  it("is closed again when a conversation rewind cuts its stop off the end of the log", async () => {
    const s = newSession();
    const start = world.events.append(s.id, task("t1", "running", 1_000));
    world.events.append(s.id, sessionEvent("background_task", { toolUseId: "t1", status: "stopped", outcome: "completed" }, 2_000));
    world.sessions.rewindConversation({ sessionId: s.id, throughSeq: start.seq, fork: "{}" });
    expect(logged(s.id)).toEqual([
      { type: "background_task", ts: 1_000, payload: { toolUseId: "t1", status: "running" } },
      { type: "background_task", ts: 1_000, payload: { toolUseId: "t1", status: "stopped", outcome: "stopped" } },
    ]);
  });
});

describe("SessionService.stopTask", () => {
  it("refuses a session that does not exist", async () => {
    await expect(world.sessions.stopTask("01ARZ3NDEKTSV4RRFFQ69G5FAV", "t1")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("answers ok, with no process started, for a session that has no live handle", async () => {
    const s = newSession();
    await expect(world.sessions.stopTask(s.id, "t1")).resolves.toBeUndefined();
    expect(world.adapter.handles).toEqual([]);
  });

  it("hands the launching call's id to the live handle", async () => {
    const s = await live();
    await world.sessions.stopTask(s.id, "t1");
    expect(s.handle.stops).toEqual(["t1"]);
  });

  it("says the agent has no way to stop one run when its handle has no such call", async () => {
    world.adapter.stoppable = false;
    const s = await live();
    await expect(world.sessions.stopTask(s.id, "t1")).rejects.toMatchObject({ code: "STOP_TASK_UNSUPPORTED", message: "This agent has no way to stop one run." });
  });

  it("answers a refusal from the harness with Realm's own sentence", async () => {
    world.adapter.refuse = true;
    const s = await live();
    await expect(world.sessions.stopTask(s.id, "t1")).rejects.toMatchObject({ code: "STOP_TASK_FAILED", message: "Claude Code could not stop that run." });
  });
});
