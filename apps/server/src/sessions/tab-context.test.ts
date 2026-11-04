import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { AsyncQueue, type AgentAdapter, type AgentHandle, type UserMessage } from "@realm/adapters";
import { TAB_TEXT_CAPS, sessionEvent, type Item, type SessionEvent } from "@realm/contracts";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";
import { TabContextReader, type TabContextDeps } from "./tab-context";
import type { TerminalScreen } from "../terminals/screen";
import type { Simctl } from "../simulators/simctl";

/**
 * The panes a message hands over, read as it is sent. What must die: a kind read past its cap, a
 * terminal cut from its top (losing the latest output), a pane of another space read because its id
 * was named, a simulator whose picture never reaches the agent, a block the engine never receives,
 * and a sent message whose cards the log does not keep.
 */

const at = (id: string, kind: Item["kind"], extra: Partial<Item> = {}): Item =>
  ({ id, spaceId: "s1", kind, title: id, sortOrder: 0, pinned: false, archived: false, refId: `r-${id}`, createdAt: 0, updatedAt: 0, ...extra }) as Item;

function reader(over: Partial<TabContextDeps> = {}, items: Item[] = []) {
  const home = tempDir("realm-tab-context-");
  const calls: string[] = [];
  const deps: TabContextDeps = {
    items: { get: (id) => items.find((i) => i.id === id), list: () => items },
    browsers: { get: () => ({ url: "https://saved.example/" }) },
    bridge: { call: async (op, p) => { calls.push(`${op}:${String(p.browserId)}`); return op === "describe" ? { open: true, url: "https://a.example/", title: "A" } : { text: "page", fields: [] }; } },
    terminals: { screen: async () => null },
    documents: { get: () => ({ activePath: "notes.md" }), rootOfWorkspace: () => "/repo", read: async () => "doc" },
    simulators: { capture: async () => Buffer.from("png-bytes") },
    home,
    ...over,
  };
  return { r: new TabContextReader(deps), calls, home };
}

const screenOf = (lines: string[]): TerminalScreen => ({ screen: lines, scrollback: [], cursor: { row: 0, col: 0 }, altScreen: false } as unknown as TerminalScreen);

describe("each kind of pane, read for a message", () => {
  it("a page: its address and title from main, its text and fields, kept from its start to the cap", async () => {
    const long = "x".repeat(TAB_TEXT_CAPS.browser + 50);
    const { r } = reader({ bridge: { call: async (op) => (op === "describe" ? { open: true, url: "https://a.example/p", title: "Page A" } : { text: long, fields: [] }) } }, [at("b", "browser")]);
    const out = await r.gather("s1", [{ itemId: "b", kind: "browser", title: "b" }]);
    // THE MUTANT: the whole page sent, past the cap.
    expect(out.cards[0]).toMatchObject({ kind: "browser", title: "Page A", url: "https://a.example/p", bytes: TAB_TEXT_CAPS.browser, truncated: true });
    expect(out.context).toContain('<tab kind="browser" title="Page A" url="https://a.example/p" truncated="the page\'s start, 24000 characters">');
  });

  it("a page asks main for its fields, and says which are hidden without their values", async () => {
    const seen: Record<string, unknown>[] = [];
    const { r } = reader({ bridge: { call: async (op, p) => { seen.push({ op, ...p }); return op === "describe" ? { open: true, url: "u", title: "T" }
      : { text: "Sign in", fields: [{ label: "Email", value: "a@b.co", hidden: false }, { label: "Password", value: null, hidden: true }] }; } } }, [at("b", "browser")]);
    const out = await r.gather("s1", [{ itemId: "b", kind: "browser", title: "b" }]);
    expect(seen).toContainEqual({ op: "read", browserId: "r-b", kind: "text", fields: true });
    expect(out.context).toContain("Form fields on the page:\n  Email: a@b.co\n  Password: (hidden by Realm)");
  });

  it("a closed browser pane is sent as closed, with nothing of it", async () => {
    const { r } = reader({ bridge: { call: async () => ({ open: false, url: "", title: "" }) } }, [at("b", "browser")]);
    const out = await r.gather("s1", [{ itemId: "b", kind: "browser", title: "b" }]);
    expect(out.cards[0]).toMatchObject({ closed: true, bytes: 0, url: "https://saved.example/" });
    expect(out.context).toContain("This pane was closed before the message was sent");
  });

  it("a document: its open file's path and text, a secret file withheld", async () => {
    const { r } = reader({}, [at("d", "documents")]);
    const out = await r.gather("s1", [{ itemId: "d", kind: "documents", title: "d" }]);
    expect(out.cards[0]).toMatchObject({ path: "/repo/notes.md", bytes: 3, truncated: false });
    const secret = reader({ documents: { get: () => ({ activePath: ".env" }), rootOfWorkspace: () => "/repo", read: async () => "API_KEY=sk-live" } }, [at("d", "documents")]);
    const withheld = await secret.r.gather("s1", [{ itemId: "d", kind: "documents", title: "d" }]);
    expect(withheld.context).not.toContain("sk-live");
    expect(withheld.context).toContain("does not hand over files that hold secrets");
  });

  it("a terminal: its latest output, cut from the top when long", async () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
    const { r } = reader({ terminals: { screen: async () => screenOf(lines) } }, [at("t", "terminal")]);
    const out = await r.gather("s1", [{ itemId: "t", kind: "terminal", title: "zsh" }]);
    expect(out.cards[0]).toMatchObject({ bytes: TAB_TEXT_CAPS.terminal, truncated: true });
    // THE MUTANT: a terminal kept from its start — the oldest output, and the command that just ran gone.
    expect(out.context).toContain("line 2999");
    expect(out.context).not.toContain("line 0\n");
  });

  it("a simulator: a screenshot attached as an image, its block saying so", async () => {
    const { r, home } = reader({}, [at("m", "simulator", { title: "iPhone 17" })]);
    const out = await r.gather("s1", [{ itemId: "m", kind: "simulator", title: "iPhone 17" }]);
    expect(out.cards[0]).toMatchObject({ kind: "simulator", bytes: 9, truncated: false });
    expect(out.images).toHaveLength(1);
    expect(out.images[0]!.mime).toBe("image/png");
    expect(out.images[0]!.path.startsWith(join(home, "tmp", "attachments"))).toBe(true);
    expect(readFileSync(out.images[0]!.path, "utf8")).toBe("png-bytes");
    expect(out.context).toContain("A screenshot of this device's screen is attached as an image.");
    // A preview reads the size and keeps no file.
    const before = out.images[0]!.path;
    expect((await r.preview("s1", { itemId: "m", kind: "simulator", title: "x" })).bytes).toBe(9);
    expect(existsSync(before)).toBe(true);
  });

  it("will not read another space's pane, or a pane whose kind is not the one named", async () => {
    const { r, calls } = reader({}, [at("b", "browser", { spaceId: "other" }), at("t", "terminal")]);
    const out = await r.gather("s1", [{ itemId: "b", kind: "browser", title: "b" }, { itemId: "t", kind: "browser", title: "t" }]);
    expect(out.cards.map((c) => c.closed)).toEqual([true, true]);
    expect(calls).toEqual([]);
  });

  it("sends a pane that fails to read as closed, and still sends the message", async () => {
    const { r } = reader({ simulators: { capture: async () => { throw new Error("no device"); } } }, [at("m", "simulator")]);
    const out = await r.gather("s1", [{ itemId: "m", kind: "simulator", title: "m" }]);
    expect(out.cards[0]!.closed).toBe(true);
    expect(out.images).toEqual([]);
  });
});

// ── end to end, over RPC ────────────────────────────────────────────────────────────────────────

let app: App | null = null;
afterEach(async () => { await app?.close(); app = null; vi.unstubAllEnvs(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

class RecordingAdapter implements AgentAdapter {
  readonly sent: UserMessage[] = [];
  readonly kind = "claude" as const;
  async probe() { return { kind: this.kind, available: true, version: "0", loggedIn: true, reason: null }; }
  start(opts: { cwd: string }): AgentHandle {
    const events = new AsyncQueue<SessionEvent>();
    events.push(sessionEvent("init", { providerSessionId: "prov_1", model: "m", tools: [], cwd: opts.cwd }));
    events.push(sessionEvent("status", { status: "idle" }));
    return {
      events,
      send: async (m) => { this.sent.push(m); events.push(sessionEvent("status", { status: "idle" })); },
      respondPermission: () => {}, interrupt: async () => {}, setOptions: async () => {}, dispose: async () => { events.close(); },
    };
  }
}

async function client(port: number, onEvent?: (event: string, payload: Any, call: (m: string, p: unknown) => Promise<Any>) => void) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>();
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} timed out`)); }, 5000);
    pending.set(id, (v) => { clearTimeout(timer); res(v); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); else onEvent?.(m.event, m.payload, call); });
  return { call };
}

describe("a message with tab cards, end to end", () => {
  it("lists the panes, previews a card, hands the engine the blocks, and the log keeps the cards", async () => {
    const home = tempDir("realm-tab-cards-");
    vi.stubEnv("REALM_BUNDLED_SKILLS", join(home, "no-bundle"));
    const agent = new RecordingAdapter();
    // A device whose screenshot is a few known bytes, through the simulator CLI's seam.
    const simctl = { available: async () => true, devices: async () => [{ udid: "UDID-UP", platform: "ios", name: "iPhone Air", runtime: "iOS 27.0", state: "Booted", serial: null, physical: false }],
      screenshot: async (_udid: string, path: string) => { writeFileSync(path, "fake-png"); return { ok: true, detail: "" }; } } as unknown as Simctl;
    app = await createApp({ home, port: 0, adapters: { claude: agent }, simulator: { simctl } });
    // Main's page read, scripted: a sign-in page whose password field main reported as hidden.
    const c = await client(app.port, (event, payload, call) => {
      if (event !== "browserHost.op") return;
      const { callId, op } = payload as { callId: string; op: string };
      if (op === "describe") void call("browserHost.result", { callId, ok: true, result: { open: true, url: "http://127.0.0.1:4100/login", title: "Sign in" } });
      else if (op === "read") void call("browserHost.result", { callId, ok: true, result: { text: "Welcome back", fields: [{ label: "Email", value: "c@example.com", hidden: false }, { label: "Password", value: null, hidden: true }] } });
      else void call("browserHost.result", { callId, ok: false, error: "not in this test" });
    });
    await c.call("browserHost.register", {});
    const profile = (await c.call("profiles.create", { name: "W" })).result;
    const space = (await c.call("spaces.create", { profileId: profile.id, name: "S" })).result;
    const browser = (await c.call("browsers.create", { spaceId: space.id, url: "http://127.0.0.1:4100/login" })).result;
    const docs = (await c.call("documents.create", { spaceId: space.id })).result;
    writeFileSync(join(space.folderPath, "notes.md"), "# Notes\nship it");
    await c.call("documents.setTabs", { documentsId: docs.documentsId, openPaths: ["notes.md"], activePath: "notes.md" });
    const sim = (await c.call("simulators.create", { spaceId: space.id, name: "iPhone Air", udid: "UDID-UP" })).result;
    const { session } = (await c.call("sessions.create", { spaceId: space.id, agentKind: "claude" })).result;

    const listed = (await c.call("tabs.list", { sessionId: session.id })).result.tabs;
    expect(listed.map((t: Any) => [t.itemId, t.kind])).toEqual(expect.arrayContaining([[browser.itemId, "browser"], [docs.itemId, "documents"]]));
    expect(listed.find((t: Any) => t.kind === "documents").path).toBe("notes.md");
    const preview = (await c.call("tabs.preview", { sessionId: session.id, tab: { itemId: docs.itemId, kind: "documents", title: "Documents" } })).result;
    expect(preview).toMatchObject({ bytes: 15, truncated: false });

    await c.call("sessions.send", { id: session.id, text: "what does this say", tabs: [
      { itemId: browser.itemId, kind: "browser", title: "Sign in" }, { itemId: docs.itemId, kind: "documents", title: "Documents" },
      { itemId: sim.itemId, kind: "simulator", title: "iPhone Air" }] });
    await waitFor(() => agent.sent.length > 0);
    const wire = agent.sent[0]!.text;
    // THE MUTANT: the cards stored and never handed over — the engine gets the user's words alone.
    expect(wire.startsWith("what does this say\n\nPanes the user attached")).toBe(true);
    expect(wire).toContain('<tab kind="browser" title="Sign in" url="http://127.0.0.1:4100/login">');
    expect(wire).toContain("Welcome back");
    expect(wire).toContain("Password: (hidden by Realm)");
    const docTitle = listed.find((t: Any) => t.kind === "documents").title;
    expect(wire).toContain(`<tab kind="documents" title="${docTitle}" path="${join(space.folderPath, "notes.md")}">`);
    expect(wire).toContain("ship it");
    // THE MUTANT: the screenshot read and saved, and never attached for the engine.
    const shot = agent.sent[0]!.attachments.find((a) => a.mime === "image/png");
    expect(shot && readFileSync(shot.path, "utf8")).toBe("fake-png");

    const users = (await c.call("sessions.events", { id: session.id })).result.filter((e: Any) => e.event.type === "user_message").map((e: Any) => e.event.payload);
    // The log keeps the user's words and the cards — never the blocks.
    expect(users[0].text).toBe("what does this say");
    expect(users[0].tabs.map((t: Any) => [t.kind, t.title, t.bytes > 0])).toEqual([["browser", "Sign in", true], ["documents", docTitle, true], ["simulator", "iPhone Air", true]]);
  });
});
