import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { sessionEvent, viewSettingKey, SETTING_ACTIVE_SPACE, type Item, type Session, type SessionEvent, type StoredSessionEvent, type StoredView } from "@realm/contracts";
import { createWorkspaceProvider, WORKSPACE_PROVIDER_NAME, type WorkspaceToolsDeps } from "./agent-tools";

/**
 * The provider over faked stores and a faked main. What matters here is the scope (this space and
 * nothing else), that `pane_show` asks the renderer for the caller's OWN side pane and waits for the
 * page to be drivable, and that every refusal says what to do instead.
 */

const SPACE = "space1", OTHER = "space2", PROFILE = "prof1";
const ME = "sess-me", PEER = "sess-peer", AWAY = "sess-away";

const item = (id: string, kind: Item["kind"], refId: string, extra: Partial<Item> = {}): Item =>
  ({ id, spaceId: SPACE, kind, title: id, sortOrder: 0, pinned: false, archived: false, refId, createdAt: 1, updatedAt: 1, ...extra });
/** `activityAt` is the third argument and `updatedAt` the same for every row: "most recently active"
 *  is when the conversation last moved, never the last write to the row. */
const session = (id: string, spaceId: string, activityAt: number, extra: Partial<Session> = {}): Session => ({
  id, spaceId, projectId: null, agentKind: "fake", model: null, effort: null, fastMode: false, permissionMode: "default",
  environmentId: "env1", cwd: "/work", status: "idle", providerSessionId: null, title: `title of ${id}`, lastEventSeq: 0, seenSeq: 0,
  terminalItemId: null, dispatchedBy: null, activityAt, createdAt: 1, updatedAt: 1, ...extra,
} as Session);

type Opts = {
  enabled?: boolean;
  view?: StoredView | null;
  /** What `describe` answers for each call, in order; the last one repeats. An Error is thrown. */
  describe?: ({ open: boolean; url?: string } | Error)[];
  docs?: { activePath: string | null; openPaths: string[] };
  openPathThrows?: Error;
  events?: Record<string, SessionEvent[]>;
};

function setup(o: Opts = {}) {
  const items: Item[] = [
    item("i-me", "session", ME),
    item("i-peer", "session", PEER),
    item("i-b1", "browser", "b1", { title: "Example" }),
    item("i-t1", "terminal", "t1"),
    item("i-docs", "documents", "docs1"),
    item("i-old", "session", "sess-old", { archived: true }),
    item("i-bx", "browser", "bX", { spaceId: OTHER, title: "Secret bank" }),
    item("i-away", "session", AWAY, { spaceId: OTHER }),
  ];
  const sessions = [session(ME, SPACE, 30), session(PEER, SPACE, 50, { dispatchedBy: { kind: "agent_run", sessionId: ME } }), session("sess-old", SPACE, 10), session(AWAY, OTHER, 99)];
  let seq = 0;
  const stored: StoredSessionEvent[] = [];
  for (const [sid, evs] of Object.entries(o.events ?? {})) for (const event of evs) stored.push({ seq: ++seq, sessionId: sid, event });
  const settings = new Map<string, unknown>([[SETTING_ACTIVE_SPACE, SPACE]]);
  if (o.view !== null) settings.set(viewSettingKey(PROFILE), o.view ?? {
    v: 1, zoomedLeafId: null, focusedItemId: "i-me", sidePanes: { "i-peer": { tabs: ["i-t1"], itemId: "i-t1" } },
    layout: { type: "split", id: "s", dir: "row", sizes: [50, 50], children: [
      { type: "leaf", id: "l1", itemId: "i-me" },
      { type: "leaf", id: "l2", itemId: "i-b1", tabs: ["i-b1", "i-bx"], owners: { "i-b1": "i-me" } },
    ] },
  });
  const calls = {
    broadcasts: [] as { event: string; payload: Record<string, unknown> }[],
    bridge: [] as { op: string; params: Record<string, unknown> }[],
    openPath: [] as Record<string, unknown>[],
    sleeps: 0,
    reads: [] as { sessionId: string; types: readonly string[] }[],
  };
  const answers = [...(o.describe ?? [{ open: true, url: "https://example.com/" }])];
  const deps: WorkspaceToolsDeps = {
    mcp: { providerEnabled: () => o.enabled ?? true },
    sessions: { get: (id) => sessions.find((s) => s.id === id) ?? null, list: (spaceId) => sessions.filter((s) => s.spaceId === spaceId) },
    events: {
      listOfTypes: (sessionId, types, opts) => {
        calls.reads.push({ sessionId, types });
        const mine = stored.filter((e) => e.sessionId === sessionId && types.includes(e.event.type));
        return opts.afterSeq !== undefined ? mine.filter((e) => e.seq > opts.afterSeq!).slice(0, opts.limit) : mine.slice(-opts.limit);
      },
    },
    items: {
      list: (spaceId) => items.filter((i) => i.spaceId === spaceId),
      get: (id) => items.find((i) => i.id === id) ?? null,
      findByRefId: (refId) => items.find((i) => i.refId === refId) ?? null,
    },
    spaces: { get: (id) => (id === SPACE || id === OTHER ? { id, profileId: PROFILE, name: id === SPACE ? "Live" : "Elsewhere", icon: "", color: "#000000", sortOrder: 0, folderPath: "/spaces/" + id, groups: null, layout: null, activeItemId: null, createdAt: 1, updatedAt: 1 } : null) },
    profiles: { get: () => ({ id: PROFILE, name: "Personal", icon: "", color: "", sortOrder: 0, browserPartition: "persist:browser", createdAt: 1, updatedAt: 1 }) },
    settings: { get: (key) => settings.get(key) ?? null },
    documents: {
      get: () => ({ id: "docs1", spaceId: SPACE, environmentId: "env1", openPaths: o.docs?.openPaths ?? ["notes.md"], activePath: o.docs ? o.docs.activePath : "notes.md", createdAt: 1, updatedAt: 1 }),
      openPath: async (p) => { calls.openPath.push(p); if (o.openPathThrows) throw o.openPathThrows; return { path: p.path }; },
    },
    bridge: {
      call: async (op, params) => {
        calls.bridge.push({ op, params });
        const next = answers.length > 1 ? answers.shift()! : answers[0]!;
        if (next instanceof Error) throw next;
        return { title: "", element: null, url: "", ...next };
      },
    },
    rpc: { broadcast: (event: string, payload: Record<string, unknown>) => { calls.broadcasts.push({ event, payload }); } } as unknown as WorkspaceToolsDeps["rpc"],
    clock: { sleep: async () => { calls.sleeps++; } },
  };
  const provider = createWorkspaceProvider(deps);
  const call = (tool: string, args: unknown = {}, sessionId = ME) => provider.call({ sessionId, spaceId: SPACE }, tool, args);
  return { provider, call, calls, settings };
}

const text = (r: CallToolResult) => r.content.map((c) => (c as { text: string }).text).join("\n");

describe("the provider's surface", () => {
  it("lists its four tools by default, and refuses with the switch's name when the space turned it off", async () => {
    const on = setup();
    expect((await on.provider.tools({ sessionId: ME, spaceId: SPACE })).map((t) => t.name)).toEqual(["workspace_state", "pane_show", "sessions_list", "session_read"]);
    const off = setup({ enabled: false });
    expect(await off.provider.tools({ sessionId: ME, spaceId: SPACE })).toEqual([]);
    const r = await off.call("workspace_state");
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(`${WORKSPACE_PROVIDER_NAME} tools are disabled for this space — mcp.setProviderEnabled`);
  });
});

describe("pane_show", () => {
  it("asks for the browser in the CALLER's side pane and answers once its page can be driven", async () => {
    const s = setup({ describe: [{ open: false }, { open: false }, { open: true, url: "http://127.0.0.1:9/" }] });
    const r = await s.call("pane_show", { browserId: "b1" });
    expect(r.isError).toBe(false);
    // THE MUTANT: `openedBy` left out, or set to the item. The renderer then has no session to put the
    // tab beside, and the pane lands as a column of its own beside whatever the user is typing in.
    expect(s.calls.broadcasts).toEqual([{ event: "browser.agentOpened", payload: { spaceId: SPACE, browserId: "b1", itemId: "i-b1", openedBy: ME } }]);
    expect(text(r)).toContain("back in your side pane, at http://127.0.0.1:9/");
    // It waited for the mount rather than answering "shown" while the tools would still refuse.
    expect(s.calls.sleeps).toBe(2);
  });

  it("says so, and what to do, when the page never mounts", async () => {
    const s = setup({ describe: [{ open: false }] });
    const r = await s.call("pane_show", { browserId: "b1" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("has not mounted after 5s");
    expect(text(r)).toContain("Check with browser_list in a moment");
  });

  it("passes on the bridge's own words when there is no window to show it in", async () => {
    const s = setup({ describe: [new Error("Realm is not running — open Realm on this Mac, then try again")] });
    const r = await s.call("pane_show", { browserId: "b1" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("open Realm on this Mac");
  });

  it("refuses another space's pane as one that does not exist, and broadcasts nothing", async () => {
    const s = setup();
    for (const args of [{ browserId: "bX" }, { itemId: "i-bx" }, { browserId: "nope" }]) {
      const r = await s.call("pane_show", args);
      expect(r.isError).toBe(true);
      // THE MUTANT: check the space after showing. Another space's bank tab arrives in this session's
      // side pane, and the agent can drive it.
      expect(text(r)).toContain("in this space. workspace_state lists the panes you can show.");
    }
    expect(s.calls.broadcasts).toEqual([]);
  });

  it("brings back a terminal into the caller's side pane", async () => {
    const s = setup();
    const r = await s.call("pane_show", { terminalId: "t1" });
    expect(r.isError).toBe(false);
    expect(s.calls.broadcasts).toEqual([{ event: "terminal.agentOpened", payload: { spaceId: SPACE, terminalId: "t1", itemId: "i-t1", openedBy: ME } }]);
  });

  it("shows a Documents pane on the file it had showing, through the same open docs_open uses", async () => {
    const s = setup({ docs: { activePath: "guide.md", openPaths: ["notes.md", "guide.md"] } });
    expect((await s.call("pane_show", { itemId: "i-docs" })).isError).toBe(false);
    expect(s.calls.openPath).toEqual([{ spaceId: SPACE, environmentId: "env1", path: "guide.md", openedBy: ME }]);
    const empty = setup({ docs: { activePath: null, openPaths: [] } });
    const r = await empty.call("pane_show", { kind: "documents" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("call pane_show with a `path` instead");
  });

  it("opens a path in the Documents pane, and points at docs_list when there is no such file", async () => {
    const s = setup({ openPathThrows: new Error("no such file: missing.md") });
    const r = await s.call("pane_show", { path: "missing.md" });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("no such file: missing.md — docs_list shows the files in this space's folder.");
    expect(s.calls.openPath[0]).toMatchObject({ spaceId: SPACE, path: "missing.md", openedBy: ME });
  });

  it("finds a pane by kind only when there is exactly one", async () => {
    const one = setup();
    expect((await one.call("pane_show", { kind: "terminal" })).isError).toBe(false);
    const none = await one.call("pane_show", { kind: "simulator" });
    expect(text(none)).toBe("this space has no simulator pane to show — simulator_open makes one.");
  });

  it("refuses what it does not bring back, and says what to use instead", async () => {
    const s = setup();
    const r = await s.call("pane_show", { itemId: "i-peer" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("a session pane is the user's to open. session_read reads a session");
    const archived = await s.call("pane_show", { itemId: "i-old" });
    expect(text(archived)).toContain("the user can unarchive it from the sidebar's Archived section");
    expect(s.calls.broadcasts).toEqual([]);
  });

  it("takes exactly one way of naming the pane", async () => {
    const s = setup();
    expect(text(await s.call("pane_show", {}))).toContain("give exactly one of itemId, browserId, terminalId, simulatorId, path or kind");
    expect(text(await s.call("pane_show", { browserId: "b1", kind: "browser" }))).toContain("give exactly one of");
  });
});

describe("workspace_state", () => {
  it("says who the caller is, where each pane of this space stands, and never names another space's pane", async () => {
    const s = setup({ describe: [{ open: true, url: "https://example.com/" }] });
    const t = text(await s.call("workspace_state"));
    expect(t).toContain(`You are session ${ME} "title of ${ME}" — fake agent, model default, permission mode default, idle.`);
    expect(t).toContain("Working directory: /work (environment env1).");
    expect(t).toContain('Space: "Live" (space1), folder /spaces/space1, in profile "Personal".');
    expect(t).toContain("The window is in this space.");
    expect(t).toContain("Your session is on screen.");
    expect(t).toContain('side by side: (session "i-me" (you) | side panel [browser "Example" (showing), a pane from another space])');
    expect(t).toContain('- browser "Example" — itemId i-b1, browserId b1 — on screen, the tab showing in the side panel; page mounted at https://example.com/');
    expect(t).toContain("- terminal \"i-t1\" — itemId i-t1, terminalId t1 — kept in a session's side pane, shown when that session is on screen");
    // A pane that is gone says how to bring it back, right where the agent reads that it is gone.
    expect(t).toContain('- documents "i-docs" — itemId i-docs, documentsId docs1 — not open (pane_show brings it back)');
    expect(t).toContain("(1 archived pane not listed.)");
    // THE MUTANT: list `items.listAll()`, or draw the layout with every title. Another space's tab — a
    // bank, here — is named to an agent that has no business in it.
    expect(t).not.toContain("Secret bank");
    expect(s.calls.bridge.map((b) => b.params.browserId)).toEqual(["b1"]);
  });

  it("says what it cannot know rather than guessing", async () => {
    const s = setup({ view: null });
    s.settings.set(SETTING_ACTIVE_SPACE, "space2");
    const t = text(await s.call("workspace_state"));
    expect(t).toContain("The window has not saved a layout yet, so what is on screen is unknown.");
    expect(t).toContain('The window is in another space, "Elsewhere".');
    expect(t).toContain("— unknown");
  });
});

describe("sessions_list", () => {
  it("lists this space's sessions, newest first, marking the caller and leaving the archived out unless asked", async () => {
    const s = setup();
    const t = text(await s.call("sessions_list"));
    const ids = [...t.matchAll(/^- (\S+)/gm)].map((m) => m[1]);
    // THE MUTANT: `sessions.listAll` — the other space's session is listed, and so readable by id.
    expect(ids).toEqual([PEER, ME]);
    expect(t).toContain(`started by agent_run from ${ME}`);
    expect(t).toContain("[you]");
    const all = text(await s.call("sessions_list", { includeArchived: true }));
    expect(all).toContain("sess-old");
    expect(all).toContain("[archived]");
  });

  it("pages, and says how to get the next page", async () => {
    const s = setup();
    const first = text(await s.call("sessions_list", { limit: 1 }));
    expect(first).toContain("1–1 of 2");
    expect(first).toContain("More: call sessions_list with offset 1.");
    expect(text(await s.call("sessions_list", { limit: 1, offset: 1 }))).not.toContain("More:");
  });
});

describe("session_read", () => {
  const said = (who: "user" | "assistant", t: string): SessionEvent =>
    who === "user" ? sessionEvent("user_message", { text: t, attachments: [] }) : sessionEvent("assistant_text", { messageId: t, text: t });
  const ran = (name: string): SessionEvent => sessionEvent("tool_call", { toolUseId: name, name, input: {}, parentToolUseId: null });

  it("refuses a session in another space, says why and where to look, and reads nothing", async () => {
    const s = setup({ events: { [AWAY]: [said("user", "private")] } });
    const r = await s.call("session_read", { sessionId: AWAY });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(`session ${AWAY} belongs to another space, and session_read only reads sessions in this one ("Live"). sessions_list lists those.`);
    // THE MUTANT: read first, check after. The transcript is already in the store's hands.
    expect(s.calls.reads).toEqual([]);
    expect(text(await s.call("session_read", { sessionId: "nope" }))).toContain("there is no session nope. sessions_list lists");
  });

  it("fences a peer's transcript as another agent's words, and leaves the caller's own unfenced", async () => {
    const s = setup({ events: { [PEER]: [said("user", "hello peer"), said("assistant", "echo: hello peer")], [ME]: [said("user", "mine")] } });
    const peer = text(await s.call("session_read", { sessionId: PEER }));
    expect(peer).toMatch(/Everything between the agent-output-[0-9a-f]+ markers is ANOTHER SESSION'S TRANSCRIPT/);
    expect(peer).toContain("] user: hello peer");
    expect(peer).toContain("] assistant: echo: hello peer");
    const own = text(await s.call("session_read", { sessionId: ME }));
    expect(own).toContain("Your own transcript");
    expect(own).not.toContain("agent-output-");
  });

  it("reads the latest page by default and forward from a seq, saying where the next page starts", async () => {
    const lines = Array.from({ length: 5 }, (_, i) => said("assistant", `line ${i + 1}`));
    const s = setup({ events: { [PEER]: lines } });
    const tail = text(await s.call("session_read", { sessionId: PEER, limit: 2 }));
    expect(tail).toContain("assistant: line 4");
    expect(tail).toContain("assistant: line 5");
    expect(tail).not.toContain("line 3");
    expect(tail).toContain("Earlier entries exist: sinceSeq 0 reads from the start. sinceSeq 5 reads what comes next.");
    const page = text(await s.call("session_read", { sessionId: PEER, sinceSeq: 0, limit: 2 }));
    expect(page).toContain("line 1");
    expect(page).not.toContain("line 3");
    expect(page).toContain("More: call session_read with sinceSeq 2.");
    expect(text(await s.call("session_read", { sessionId: PEER, sinceSeq: 4 }))).toContain("That is everything up to now; sinceSeq 5 reads what comes next.");
  });

  it("names the tools that ran — folded into one line — and asks only for the kinds requested", async () => {
    const s = setup({ events: { [PEER]: [said("user", "go"), ran("Read"), ran("Edit"), said("assistant", "done")] } });
    const t = text(await s.call("session_read", { sessionId: PEER }));
    expect(t).toContain("] tools: Read, Edit");
    await s.call("session_read", { sessionId: PEER, kinds: ["assistant"] });
    // Tool OUTPUT is never asked for: it is what a page or a command said, and the reader asked what
    // the session did.
    expect(s.calls.reads.map((r) => r.types)).toEqual([["user_message", "assistant_text", "tool_call"], ["assistant_text"]]);
  });

  it("clips a long message and caps the page, and says the page was cut", async () => {
    const huge = "x".repeat(5_000);
    const s = setup({ events: { [PEER]: Array.from({ length: 20 }, () => said("assistant", huge)) } });
    const t = text(await s.call("session_read", { sessionId: PEER, sinceSeq: 0 }));
    // THE MUTANT: no cap. Twenty five-thousand-character messages are a hundred thousand characters
    // poured into the reader's context for one call.
    expect(t.length).toBeLessThan(26_000);
    expect(t).toContain("x…");
    expect(t).toMatch(/More: call session_read with sinceSeq \d+\./);
  });
});
