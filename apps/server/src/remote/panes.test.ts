import { afterEach, describe, expect, it, vi } from "vitest";
import type { MethodName, TerminalStatus } from "@realm/contracts";
import { MobileCalls, SCREEN_SIDE, TERMINAL_TEXT_MAX } from "@realm/remote";
import { MobileApi, MobileError } from "./api";
import { channel, fakeRpc, item, jpegHeader, session } from "./api.test-fakes";
import { BROWSER_FRAME_EVERY_MS, phoneFavicon, terminalOutput } from "./panes";
import type { RpcPort } from "./rpc-port";
import { FRAME_MAX_BYTES } from "./screens";

const api = () => new MobileApi({ macName: () => "Test Mac", reportsDir: "/nonexistent", realmHome: "/nonexistent", userHome: "/Users/me", dev: false });

async function attempt(a: MobileApi, rpc: RpcPort, method: string, params: unknown): Promise<{ ok: true; result: unknown } | { ok: false; code: string; message: string }> {
  try { return { ok: true, result: await a.handle(channel(rpc), method, params) }; }
  catch (e) { if (e instanceof MobileError) return { ok: false, code: e.code, message: e.message }; throw e; }
}

const PNG_ICON = "data:image/png;base64,iVBORw0KGgo=";
const status = (terminalId: string, spaceId: string, extra: Partial<TerminalStatus> = {}): TerminalStatus =>
  ({ terminalId, spaceId, cwd: "/Users/me/Code/realm", command: null, running: true, exitCode: null, signal: null, startedAt: 0, exitedAt: null, ...extra });

/** Space s1 holds two browsers (one loaded in a window, one given up for memory), a closed one, and three
 *  terminals: a shell, a command that ended, and one closed; s2 holds a browser of its own. */
function rig(o: { capture?: (p: { browserId: string; maxSide: number; quality: number }) => unknown; read?: (p: unknown) => unknown } = {}) {
  const items = [
    item("b-docs", "s1", "Docs", { kind: "browser", favicon: PNG_ICON }),
    item("b-asleep", "s1", "Admin", { kind: "browser", favicon: "data:image/svg+xml;base64,PHN2Zy8+" }),
    item("b-closed", "s1", "Old", { kind: "browser", archived: true }),
    item("t-shell", "s1", "realm", { kind: "terminal" }),
    item("t-build", "s1", "build", { kind: "terminal" }),
    item("t-gone", "s1", "gone", { kind: "terminal", archived: true }),
    item("b-other", "s2", "Elsewhere", { kind: "browser" }),
  ];
  const asked: [string, unknown][] = [];
  const more: Partial<Record<MethodName, (p: never) => unknown>> = {
    "items.list": (p: { spaceId: string }) => items.filter((it) => it.spaceId === p.spaceId),
    "terminals.list": (p: { spaceId: string }) => [
      status("t-shell", "s1"), status("t-build", "s1", { command: "pnpm build", running: false, exitCode: 0 }), status("t-x", "s2"),
    ].filter((t) => t.spaceId === p.spaceId),
    "browsers.views": () => ({ browserIds: ["b-docs", "b-other"] }),
    "browsers.get": (p: { browserId: string }) => ({ id: p.browserId, url: p.browserId === "b-docs" ? "http://localhost:4000/docs" : "", title: "", favicon: "" }),
    "browsers.capture": (p: { browserId: string; maxSide: number; quality: number }) =>
      o.capture?.(p) ?? (p.browserId === "b-docs" ? { data: jpegHeader(p.maxSide, Math.round(p.maxSide * 0.6)).toString("base64"), width: p.maxSide, height: Math.round(p.maxSide * 0.6) } : { data: null, width: 0, height: 0 }),
    "terminals.read": (p) => o.read?.(p) ?? { runId: "r1", seq: 3, live: "\u001b[32mok\u001b[0m\r\n", truncated: false, running: true, history: null },
  };
  const wrapped = Object.fromEntries(Object.entries(more).map(([m, fn]) => [m, (p: never) => { asked.push([m, p]); return fn(p); }]));
  return { rpc: fakeRpc({ sessions: [session("in-s1", "s1"), session("in-s2", "s2")], items: [] }, wrapped), asked };
}
const captures = (asked: [string, unknown][]) => asked.filter(([m]) => m === "browsers.capture");

afterEach(() => { vi.useRealTimers(); });

describe("session.panes", () => {
  it("lists the space's open browsers and terminals by their panes' names, live first, and nothing of another space", async () => {
    const got = await attempt(api(), rig().rpc, "session.panes", { id: "in-s1" });
    if (!got.ok) throw new Error(got.message);
    const panes = MobileCalls["session.panes"].result.parse(got.result);
    // THE MUTANT: list closed panes, or every space's.
    expect(panes.browsers).toEqual([
      { id: "b-docs", name: "Docs", url: "http://localhost:4000/docs", favicon: { mime: "image/png", data: "iVBORw0KGgo=" }, live: true },
      // Given up for memory: listed, not live, and its SVG icon is one a phone does not draw.
      { id: "b-asleep", name: "Admin", url: "", live: false },
    ]);
    expect(panes.terminals).toEqual([
      { id: "t-shell", name: "realm", detail: "~/Code/realm", running: true },
      { id: "t-build", name: "build", detail: "pnpm build", running: false },
    ]);
  });

  it("lists a browser as not live when the Mac has no window to say otherwise", async () => {
    const { rpc } = rig();
    const silent = { ...rpc, call: (async (m: MethodName, p: never) => { if (m === "browsers.views") throw new Error("Realm stopped running"); return rpc.call(m, p); }) as RpcPort["call"] };
    const got = await attempt(api(), silent, "session.panes", { id: "in-s1" });
    expect(got.ok && (got.result as { browsers: { live: boolean }[] }).browsers.map((b) => b.live)).toEqual([false, false]);
  });

  it("draws a tab's icon only when it is a picture a phone reads", () => {
    expect(phoneFavicon(PNG_ICON)).toEqual({ mime: "image/png", data: "iVBORw0KGgo=" });
    expect(phoneFavicon("data:image/svg+xml;base64,PHN2Zy8+")).toBeUndefined();
    expect(phoneFavicon("https://example.com/favicon.ico")).toBeUndefined();
    expect(phoneFavicon(undefined)).toBeUndefined();
  });
});

describe("session.browserFrame", () => {
  it("pictures a pane of the session's own space at the side asked for, inside SCREEN_SIDE", async () => {
    const { rpc, asked } = rig();
    const got = await attempt(api(), rpc, "session.browserFrame", { id: "in-s1", browserId: "b-docs", maxSide: 5000 });
    if (!got.ok) throw new Error(got.message);
    const frame = MobileCalls["session.browserFrame"].result.parse(got.result);
    // THE MUTANT: hand main the side the phone asked for — a 5000 px page over cellular.
    expect(captures(asked)).toEqual([["browsers.capture", { browserId: "b-docs", maxSide: SCREEN_SIDE.max, quality: 65 }]]);
    expect([frame.width, frame.height]).toEqual([SCREEN_SIDE.max, Math.round(SCREEN_SIDE.max * 0.6)]);
  });

  it("refuses a pane of another space as one it does not have, and a closed one, taking no picture", async () => {
    const { rpc, asked } = rig();
    // THE MUTANT: capture by the id the phone names, whatever space it is in.
    expect(await attempt(api(), rpc, "session.browserFrame", { id: "in-s1", browserId: "b-other" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await attempt(api(), rpc, "session.browserFrame", { id: "in-s1", browserId: "b-closed" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(captures(asked)).toEqual([]);
  });

  it("says a pane whose page is not loaded is not open, which a phone stops asking about", async () => {
    expect(await attempt(api(), rig().rpc, "session.browserFrame", { id: "in-s1", browserId: "b-asleep" }))
      .toEqual({ ok: false, code: "FORBIDDEN", message: "Admin isn't open in a window on your Mac." });
  });

  it("sends no picture of a page main withheld for a field it could not cover, and says why as worth asking again", async () => {
    const withheld = rig({ capture: () => ({ data: null, width: 0, height: 0, withheld: "Hidden on your phone while this page shows a password or card field inside a frame." }) });
    // THE MUTANT: FORBIDDEN, which a phone takes as gone, and never looks again once the form has gone.
    expect(await attempt(api(), withheld.rpc, "session.browserFrame", { id: "in-s1", browserId: "b-docs" }))
      .toEqual({ ok: false, code: "INTERNAL", message: "Hidden on your phone while this page shows a password or card field inside a frame." });
  });

  it("makes a heavy page again smaller and plainer, twice, and sends none heavier than FRAME_MAX_BYTES", async () => {
    const heavy = (p: { maxSide: number }) => ({ data: Buffer.concat([jpegHeader(p.maxSide, p.maxSide), Buffer.alloc(FRAME_MAX_BYTES)]).toString("base64"), width: p.maxSide, height: p.maxSide });
    const always = rig({ capture: heavy });
    expect(await attempt(api(), always.rpc, "session.browserFrame", { id: "in-s1", browserId: "b-docs", maxSide: 1000 }))
      .toEqual({ ok: false, code: "INTERNAL", message: "That page is too detailed to send to a phone, even made small." });
    expect(captures(always.asked).map(([, p]) => p)).toEqual([
      { browserId: "b-docs", maxSide: 1000, quality: 65 }, { browserId: "b-docs", maxSide: 700, quality: 50 }, { browserId: "b-docs", maxSide: 500, quality: 40 },
    ]);
    const once = rig({ capture: (p) => (p.maxSide === 1000 ? heavy(p) : { data: jpegHeader(p.maxSide, p.maxSide).toString("base64"), width: p.maxSide, height: p.maxSide }) });
    expect(await attempt(api(), once.rpc, "session.browserFrame", { id: "in-s1", browserId: "b-docs", maxSide: 1000 })).toMatchObject({ ok: true, result: { width: 700 } });
  });

  it("pictures a pane at most once a second, whoever asks, and again once a second has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { rpc, asked } = rig();
    const a = api();
    const ask = () => attempt(a, rpc, "session.browserFrame", { id: "in-s1", browserId: "b-docs", maxSide: 1000 });
    const [first, second] = await Promise.all([ask(), ask()]);
    vi.advanceTimersByTime(BROWSER_FRAME_EVERY_MS - 1);
    const third = await ask();
    // THE MUTANT: no floor — a viewer and the session card on two phones each take a picture a second.
    expect(captures(asked)).toHaveLength(1);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    vi.advanceTimersByTime(1);
    await ask();
    expect(captures(asked)).toHaveLength(2);
  });

  it("takes no picture of anything until a phone asks for one: listing panes captures nothing", async () => {
    const { rpc, asked } = rig();
    await attempt(api(), rpc, "session.panes", { id: "in-s1" });
    // THE MUTANT: a thumbnail of every live pane made as the list is.
    expect(captures(asked)).toEqual([]);
    expect(asked.filter(([m]) => m === "terminals.read")).toEqual([]);
  });
});

describe("session.terminal", () => {
  it("reads a terminal of the session's own space as a peek, from the phone's cursor", async () => {
    const { rpc, asked } = rig();
    const got = await attempt(api(), rpc, "session.terminal", { id: "in-s1", terminalId: "t-shell", cursor: { runId: "r1", seq: 2 } });
    if (!got.ok) throw new Error(got.message);
    expect(MobileCalls["session.terminal"].result.parse(got.result)).toEqual({ runId: "r1", seq: 3, text: "\u001b[32mok\u001b[0m\r\n", reset: false, running: true });
    // THE MUTANT: a read that starts a restored terminal's shell because a phone looked at it.
    expect(asked.filter(([m]) => m === "terminals.read")).toEqual([["terminals.read", { terminalId: "t-shell", cursor: { runId: "r1", seq: 2 }, peek: true }]]);
  });

  it("refuses a terminal of another space, or a closed one, reading neither", async () => {
    const { rpc, asked } = rig();
    expect(await attempt(api(), rpc, "session.terminal", { id: "in-s2", terminalId: "t-shell" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await attempt(api(), rpc, "session.terminal", { id: "in-s1", terminalId: "t-gone" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(asked.filter(([m]) => m === "terminals.read")).toEqual([]);
  });
});

describe("terminalOutput", () => {
  const read = (live: string, extra: Partial<Parameters<typeof terminalOutput>[0]> = {}) =>
    ({ runId: "r1", seq: 9, live, truncated: false, running: true, history: null, ...extra });

  it("is what came after the cursor while the phone follows the same run", () => {
    expect(terminalOutput(read("more\r\n"), { runId: "r1", seq: 8 })).toEqual({ runId: "r1", seq: 9, text: "more\r\n", reset: false, running: true });
  });

  it("starts from the top, the last shell's screen first, on a first read or a new run", () => {
    const fresh = read("$ ls\r\n", { history: { data: "old screen" } });
    expect(terminalOutput(fresh, null)).toMatchObject({ text: "old screen\r\n$ ls\r\n", reset: true });
    // THE MUTANT: follow on whatever run the cursor names — a respawned shell's output glued to the last one's.
    expect(terminalOutput(fresh, { runId: "r0", seq: 40 })).toMatchObject({ reset: true });
    expect(terminalOutput(read("x", { truncated: true }), { runId: "r1", seq: 1 })).toMatchObject({ reset: true });
  });

  it("carries at most TERMINAL_TEXT_MAX, cut to its end at a line's start", () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `\u001b[3${i % 8}mline ${i}\u001b[0m`).join("\r\n");
    const out = terminalOutput(read(lines), { runId: "r1", seq: 1 });
    // THE MUTANT: send the whole ring — megabytes a second over cellular.
    expect(out.text.length).toBeLessThanOrEqual(TERMINAL_TEXT_MAX);
    expect(out.reset).toBe(true);
    expect(out.text.startsWith("\u001b[3")).toBe(true);
    expect(out.text.endsWith("line 19999\u001b[0m")).toBe(true);
  });
});
