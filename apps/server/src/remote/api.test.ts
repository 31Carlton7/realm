import { describe, expect, it } from "vitest";
import type { Item, MethodName, MethodParams, MethodResult, Session, Space } from "@realm/contracts";
import { HomeSchema } from "@realm/remote";
import { needsYou } from "@realm/view";
import { MobileApi, needsYouInput, type ChannelContext } from "./api";
import type { RpcPort } from "./rpc-port";

/**
 * mobile.v1's `home.get` against a fake of the desktop's RPC. Needs you is `@realm/view`'s rule; what
 * is the server's own, and so what these hold, is the input it builds for that rule from its lists.
 */

const space = (id: string, profileId = "p1"): Space =>
  ({ id, profileId, name: `Space ${id}`, icon: "folder", color: "#7c6cff", sortOrder: 0, folderPath: "/tmp", groups: null, layout: null, activeItemId: null, createdAt: 0, updatedAt: 0 });
const item = (refId: string, spaceId: string, title: string, extra: Partial<Item> = {}): Item =>
  ({ id: `i-${refId}`, spaceId, kind: "session", title, sortOrder: 0, pinned: false, archived: false, refId, createdAt: 0, updatedAt: 0, ...extra });
const session = (id: string, spaceId: string, extra: Partial<Session> = {}): Session =>
  ({ id, spaceId, projectId: null, agentKind: "fake", model: null, effort: null, fastMode: false, permissionMode: "default", environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", cwd: "/tmp", status: "idle",
    providerSessionId: null, title: `${id} (session)`, lastEventSeq: 0, seenSeq: 0, terminalItemId: null, dispatchedBy: null, activityAt: 0, createdAt: 0, updatedAt: 0, ...extra });

type Home = { spaces?: Space[]; sessions: Session[]; items: Item[]; settings?: Record<string, unknown> };

/** The desktop's RPC as `home.get` reads it: `items.listAll` leaves archived rows out, as the store does. */
export function fakeRpc(h: Home, more: Partial<Record<MethodName, (p: never) => unknown>> = {}): RpcPort & { calls: string[] } {
  const calls: string[] = [];
  const answer = (method: MethodName, params: unknown): unknown => {
    const extra = more[method];
    if (extra) return extra(params as never);
    switch (method) {
      case "spaces.list": return h.spaces ?? [space("s1"), space("s2", "p2")];
      case "sessions.listAll": return h.sessions;
      case "items.listAll": return h.items.filter((i) => !i.archived);
      case "settings.get": return { value: h.settings?.[(params as { key: string }).key] ?? null };
      case "sessions.get": {
        const found = h.sessions.find((s) => s.id === (params as { id: string }).id);
        if (!found) throw new Error(`no session ${(params as { id: string }).id}`);
        return found;
      }
      case "sessions.events": return [];
      default: throw new Error(`the fake has no ${method}`);
    }
  };
  return {
    calls,
    call: async <M extends MethodName>(method: M, params: MethodParams<M>) => { calls.push(method); return answer(method, params) as MethodResult<M>; },
    onEvent: () => () => {},
    close: () => {},
  };
}

export const channel = (rpc: RpcPort): ChannelContext => ({ phoneId: "phone", rpc, sessions: new Map() });
const api = () => new MobileApi({ macName: () => "Test Mac", reportsDir: "/nonexistent", dev: false });
const home = async (h: Home) => HomeSchema.parse(await api().handle(channel(fakeRpc(h)), "home.get", {}));

describe("home.get's Needs you is the sidebar's", () => {
  /** Every case the rule decides, as the desktop's lists would carry it. */
  const lists: Home = {
    sessions: [
      session("asks", "s1", { status: "waiting_permission", updatedAt: 300, createdAt: 900, activityAt: 900 }),
      session("permits", "s2", { status: "waiting_permission", updatedAt: 100, createdAt: 800, activityAt: 950 }),
      session("lead", "s1", { updatedAt: 5 }),
      session("child-of-listed", "s1", { status: "waiting_permission", updatedAt: 50, dispatchedBy: { kind: "agent_run", sessionId: "lead" } }),
      session("put-away-lead", "s1", { updatedAt: 6 }),
      session("child-of-put-away", "s1", { status: "waiting_permission", updatedAt: 200, dispatchedBy: { kind: "agent_run", sessionId: "put-away-lead" } }),
      session("quick", "s1", { status: "waiting_permission", updatedAt: 10 }),
      session("failed-unread", "s1", { status: "error", lastEventSeq: 9, seenSeq: 4, updatedAt: 700 }),
      session("failed-read", "s1", { status: "error", lastEventSeq: 9, seenSeq: 9, updatedAt: 600 }),
      session("failed-archived", "s2", { status: "error", lastEventSeq: 9, updatedAt: 500 }),
      session("failed-never-opened", "s2", { status: "error", lastEventSeq: 3, updatedAt: 400 }),
      session("running", "s1", { status: "running", updatedAt: 1 }),
    ],
    items: [
      item("asks", "s1", "Asks a question"), item("permits", "s2", "Wants to run a command"), item("lead", "s1", "Lead"),
      item("child-of-listed", "s1", "Child of a listed lead"), item("put-away-lead", "s1", "Put away", { archived: true }),
      item("child-of-put-away", "s1", "Child of a put-away lead"),
      item("failed-unread", "s1", "Failed, unread"), item("failed-read", "s1", "Failed, read"), item("failed-archived", "s2", "Failed, archived", { archived: true }),
      item("failed-never-opened", "s2", "Failed, never opened"), item("running", "s1", "Running"),
    ],
    settings: { "ui.quickChat": { sessionId: "quick", pos: null } },
  };

  it("lists the waiting by how long each has waited, then the failures nobody has read, and nothing else", async () => {
    const h = await home(lists);
    // THE MUTANTS, each a one-line change to the input `needsYouInput` builds:
    //  - `quickChatId: null`              → the quick chat's question is listed;
    //  - `sessionUpdatedAt: …createdAt`   → the order is the order they were made;
    //  - `allItems: []`                   → no failure has a row to be listed by, and every lead is unlisted.
    expect(h.needsYou.map((r) => r.id)).toEqual(["permits", "child-of-put-away", "asks", "failed-never-opened", "failed-unread"]);
    expect(h.needsYou.map((r) => [r.title, r.spaceName, r.status])).toEqual([
      ["Wants to run a command", "Space s2", "waiting"], ["Child of a put-away lead", "Space s1", "waiting"], ["Asks a question", "Space s1", "waiting"],
      ["Failed, never opened", "Space s2", "error"], ["Failed, unread", "Space s1", "error"],
    ]);
  });

  it("is exactly what the sidebar's rule makes of the same lists", async () => {
    const h = await home(lists);
    const all = lists.sessions;
    const expected = needsYou(needsYouInput({ spaces: [space("s1"), space("s2", "p2")], sessions: all, items: lists.items.filter((i) => !i.archived), quickChatId: "quick" }));
    expect(h.needsYou.map((r) => r.id)).toEqual(expected.map((r) => r.session.id));
  });

  it("marks a row as needing you exactly when Needs you lists it", async () => {
    const h = await home(lists);
    const listed = new Set(h.needsYou.map((r) => r.id));
    const rows = h.spaces.flatMap((sp) => sp.sessions);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of [...rows, ...h.needsYou]) expect(r.needsYou, r.id).toBe(listed.has(r.id));
    // The quick chat waits, yet it is no row of Needs you, so it does not say it needs you either.
    expect(rows.find((r) => r.id === "quick")).toBeUndefined();
  });

  it("reads the quick chat's session from its window's setting, and leaves the rest when there is none", async () => {
    const none = await home({ ...lists, settings: {} });
    expect(none.needsYou.map((r) => r.id)).toContain("quick");
    const gone = await home({ ...lists, settings: { "ui.quickChat": { sessionId: null, pos: { x: 1, y: 1 } } } });
    expect(gone.needsYou.map((r) => r.id)).toContain("quick");
  });
});
