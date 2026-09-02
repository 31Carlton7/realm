import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor, renderHook, act } from "@testing-library/react";
import { CommandPalette, matchScore, relTime, usePaletteHotkey } from "./CommandPalette";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi, item, session } from "../state/store.test-fakes";

async function mount(over: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi(over); const store = createAppStore(api); await store.getState().boot(); act(() => store.setState({ paletteOpen: true }));
  render(<StoreContext.Provider value={store}><CommandPalette /></StoreContext.Provider>);
  await waitFor(() => expect(api.calls).toContain("listAllItems")); // palette refreshes cross-space items on open
  return { store, api };
}

const options = () => screen.getAllByRole("option").map((o) => o.textContent);

describe("no-overlay centering (W2)", () => {
  it("with a browser view open, the palette centers over the widest non-browser column", async () => {
    const { store } = await mount();
    // View on the right half of the 1024×768 jsdom window; complement column is 0–512.
    act(() => store.getState().setBrowserRect("b1", { x: 512, y: 40, width: 512, height: 728 }));
    const palette = screen.getByRole("dialog", { name: "Command palette" });
    expect(palette.style.position).toBe("absolute");
    expect(palette.style.width).toBe("488px"); // 512 - 2*12: capped into the column
    expect(palette.style.left).toBe("12px"); // centered in it
    expect(parseFloat(palette.style.left) + 488).toBeLessThanOrEqual(512); // clear of the view
  });

  it("without browser rects nothing is overridden — CSS centering as before", async () => {
    await mount();
    expect(screen.getByRole("dialog", { name: "Command palette" }).style.position).toBe("");
  });
});


const input = () => screen.getByRole("combobox");

describe("matchScore (subsequence + boosts)", () => {
  it("is a subsequence matcher: scattered letters match, missing or out-of-order letters do not", () => {
    expect(matchScore("ntl", "New terminal")).not.toBeNull();
    expect(matchScore("nz", "New terminal")).toBeNull();
    expect(matchScore("tn", "not")).toBeNull(); // order matters — not a bag of chars ("nt" would match)
    expect(matchScore("", "anything")).toBe(0);
    expect(matchScore("TERM", "New terminal")).not.toBeNull(); // case-insensitive
  });
  it("ranks word-start hits above buried ones: 'nt' prefers New terminal to Open Terminal", () => {
    expect(matchScore("nt", "New terminal")!).toBeGreaterThan(matchScore("nt", "Open Terminal…")!);
  });
  it("boosts a whole-query prefix", () => {
    expect(matchScore("new", "New terminal")!).toBeGreaterThan(matchScore("new", "Renew things")!);
  });
});

describe("relTime", () => {
  it("formats compact ages", () => {
    const now = 1_000_000_000_000;
    expect(relTime(now - 30_000, now)).toBe("now");
    expect(relTime(now - 5 * 60_000, now)).toBe("5m");
    expect(relTime(now - 2 * 3_600_000, now)).toBe("2h");
    expect(relTime(now - 3 * 86_400_000, now)).toBe("3d");
  });
});

describe("CommandPalette", () => {
  it("lists items from ALL spaces, other-space rows hinted with their space name, and opening one switches space", async () => {
    const { store } = await mount({ items: {
      s1: [item("i1", "s1", { title: "Terminal" })],
      s2: [item("i2", "s2", { title: "Homework notes", kind: "session", refId: "se2" })],
    } });
    expect(store.getState().activeSpaceId).toBe("s1");
    const row = screen.getByRole("option", { name: /Homework notes/ });
    expect(row.textContent).toContain("Homework ·"); // space-name hint disambiguates (V-F4)
    fireEvent.click(row);
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
    await waitFor(() => {
      const l = store.getState().layout!;
      expect(l.type === "leaf" && l.itemId).toBe("i2"); // opened into the fresh space's layout
    });
    expect(store.getState().paletteOpen).toBe(false);
  });

  it("archived rows are absent from the jump list, in this space and in every other", async () => {
    // Both halves of the list are covered: the active space's rows come from `items` (which carries
    // archived rows, for the sidebar's shelf) and the rest from `allItems` (which does not).
    await mount({ items: {
      s1: [item("i1", "s1", { title: "Terminal" }),
           item("i3", "s1", { title: "Shelved here", kind: "session", refId: "se3", archived: true })],
      s2: [item("i2", "s2", { title: "Shelved elsewhere", kind: "session", refId: "se2", archived: true })],
    } });
    expect(screen.queryByRole("option", { name: /Shelved here/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Shelved elsewhere/ })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Terminal/ })).toBeInTheDocument();
  });

  it("sorts a space's items by updatedAt desc (recency), open items of the active space first with a quadrant glyph", async () => {
    // Insertion order deliberately disagrees with recency (Middle before Newest) so a sort that
    // ignores updatedAt dies here instead of passing by accident.
    const { store } = await mount({ items: { s1: [
      item("old", "s1", { title: "Oldest", updatedAt: 100 }),
      item("mid", "s1", { title: "Middle", updatedAt: 200 }),
      item("new", "s1", { title: "Newest", updatedAt: 300 }),
    ] } });
    act(() => store.setState({ layout: { type: "split", id: "r", dir: "row", sizes: [50, 50], children: [
      { type: "leaf", id: "L1", itemId: "old" }, { type: "leaf", id: "L2", itemId: null },
    ] }, focusedLeafId: "L1" }));
    const labels = options();
    const at = (t: string) => labels.findIndex((x) => x?.startsWith(t));
    expect(at("Oldest")).toBe(0);                       // open section leads despite lowest updatedAt
    expect(at("Newest")).toBeLessThan(at("Middle"));    // recency inside the space group
    expect(at("Middle")).toBeLessThan(at("New terminal"));
    const byLabel = (t: string) => screen.getAllByRole("option").find((o) => o.querySelector(".palette-label")?.textContent === t)!;
    expect(byLabel("Oldest").querySelector(".item-glyph")).toBeInTheDocument();
    expect(byLabel("Newest").querySelector(".item-glyph")).toBeNull();
  });

  it("renders faint section headers — Open / space names / Actions / Theme — only while the query is empty", async () => {
    const { store } = await mount({ items: {
      s1: [item("i1", "s1", { title: "Terminal" }), item("i2", "s1", { title: "Notes" })],
      s2: [item("i3", "s2", { title: "Elsewhere" })],
    } });
    act(() => store.setState({ layout: { type: "leaf", id: "L1", itemId: "i1" }, focusedLeafId: "L1" }));
    const secs = () => Array.from(document.querySelectorAll(".palette-sec")).map((el) => el.textContent);
    expect(secs()).toEqual(["Open", "Versed", "Homework", "Actions", "Theme"]);
    fireEvent.change(input(), { target: { value: "e" } });
    expect(secs()).toEqual([]); // filtered view is a flat ranked list
  });

  it("query ranking is score-ordered: 'nt' puts New terminal above an item titled Open Terminal…", async () => {
    await mount({ items: { s1: [item("i1", "s1", { title: "Open Terminal…" })] } });
    fireEvent.change(input(), { target: { value: "nt" } });
    const labels = options();
    const newTerm = labels.findIndex((x) => x?.startsWith("New terminal"));
    const openTerm = labels.findIndex((x) => x?.startsWith("Open Terminal…"));
    expect(newTerm).toBeGreaterThanOrEqual(0);
    expect(openTerm).toBeGreaterThanOrEqual(0);
    expect(newTerm).toBeLessThan(openTerm);
  });

  it("'New session' creates instantly with the last-used agent — no sheet anywhere in the path (W3)", async () => {
    const { store, api } = await mount();
    fireEvent.change(input(), { target: { value: "new session" } });
    fireEvent.click(screen.getByRole("option", { name: /^New session ⌘N$/ }));
    await waitFor(() => expect(Object.keys(store.getState().sessions)).toHaveLength(1));
    expect(api.calls).toContain("createSession:claude");
    expect(store.getState().sheet).toBeNull();
    expect(store.getState().paletteOpen).toBe(false);
  });

  it("'New session in a worktree' pins the session to a worktree it makes first (W2)", async () => {
    const { store, api } = await mount();
    fireEvent.change(input(), { target: { value: "worktree" } });
    fireEvent.click(screen.getByRole("option", { name: /New session in a worktree/ }));
    await waitFor(() => expect(Object.keys(store.getState().sessions)).toHaveLength(1));
    // The worktree is made BEFORE the session: a session that landed in the space folder because the
    // worktree failed would be the collision this action exists to avoid.
    expect(api.calls.indexOf("createWorktree:s1")).toBeGreaterThanOrEqual(0);
    expect(api.calls.indexOf("createWorktree:s1")).toBeLessThan(api.calls.indexOf("createSession:claude"));
    const env = api.data.environments.s1![0]!;
    expect(env.kind).toBe("worktree");
    expect(store.getState().environments[env.id]).toMatchObject({ kind: "worktree", branch: "realm/session" });
    expect(store.getState().sheet).toBeNull();
  });

  it("a per-agent one-shot names its agent and routes through the very same newSession path", async () => {
    const { store, api } = await mount();
    fireEvent.change(input(), { target: { value: "new codex" } });
    fireEvent.click(screen.getByRole("option", { name: /New Codex session/ }));
    await waitFor(() => expect(api.calls).toContain("createSession:codex"));
    const created = Object.values(store.getState().sessions)[0]!;
    // Same adoption as "+" and ⌘N: item created, opened into a pane, transcript opened.
    await waitFor(() => expect(store.getState().transcripts[created.id]).toBeDefined());
    expect(store.getState().items.some((i) => i.kind === "session" && i.refId === created.id)).toBe(true);
    expect(store.getState().sheet).toBeNull();
    // Naming an agent is also a use of it: the next unnamed create follows.
    expect(store.getState().lastAgentKind).toBe("codex");
  });

  it("Close pane / Rename entries exist only with a focused non-empty leaf; Rename arms renamingItemId", async () => {
    const { store } = await mount();
    expect(screen.queryByRole("option", { name: /Close pane/ })).toBeNull(); // layout is empty
    act(() => store.setState({ layout: { type: "leaf", id: "L1", itemId: "i1" }, focusedLeafId: "L1" }));
    fireEvent.click(screen.getByRole("option", { name: /Rename/ }));
    expect(store.getState().renamingItemId).toBe("i1");
    act(() => store.setState({ paletteOpen: true }));
    fireEvent.click(screen.getByRole("option", { name: /Close pane/ }));
    await waitFor(() => { const l = store.getState().layout!; expect(l.type === "leaf" && l.itemId).toBeNull(); });
  });

  it("Interrupt running session appears only while the focused pane's session is running", async () => {
    const it9 = item("i9", "s1", { kind: "session", refId: "se1" });
    const { store, api } = await mount({ items: { s1: [it9] }, sessions: [session("se1", "s1")] });
    act(() => store.setState({ layout: { type: "leaf", id: "L1", itemId: "i9" }, focusedLeafId: "L1", sessionStatus: { se1: "idle" } }));
    expect(screen.queryByRole("option", { name: /Interrupt running session/ })).toBeNull();
    act(() => store.setState({ sessionStatus: { se1: "running" } }));
    fireEvent.click(screen.getByRole("option", { name: /Interrupt running session/ }));
    await waitFor(() => expect(api.calls).toContain("interrupt:se1"));
  });

  it("'Respond to pending permission' appears only with a waiting session and jumps across spaces to it", async () => {
    const it2 = item("i2", "s2", { kind: "session", refId: "se2", title: "Waiting there" });
    const { store } = await mount({ items: { s2: [it2] }, sessions: [session("se2", "s2", { status: "idle" })] });
    expect(store.getState().activeSpaceId).toBe("s1");
    expect(screen.queryByRole("option", { name: /Respond to pending permission/ })).toBeNull();
    act(() => store.getState().applySessionStatus("se2", "waiting_permission"));
    fireEvent.click(screen.getByRole("option", { name: /Respond to pending permission/ }));
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
    await waitFor(() => {
      const l = store.getState().layout!;
      expect(l.type === "leaf" && l.itemId).toBe("i2"); // the waiting session's item, opened + focused
    });
  });

  it("honest placeholder: the input says Search…, and actions still run from the keyboard", async () => {
    const { store } = await mount();
    expect(screen.getByPlaceholderText("Search…")).toBeInTheDocument();
    fireEvent.change(input(), { target: { value: "theme: dark" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(store.getState().themePref).toBe("dark"));
  });

  it("space switching and layout presets still work", async () => {
    const { store } = await mount();
    fireEvent.change(input(), { target: { value: "switch to home" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
    act(() => store.setState({ paletteOpen: true }));
    fireEvent.change(input(), { target: { value: "layout: 3 col" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => {
      const l = store.getState().layout;
      expect(l?.type === "split" && l.dir === "row" && l.children.length).toBe(3);
    });
  });

  it("⌘K toggles the palette (still guarded by sheets)", () => {
    const store = createAppStore(fakeApi());
    renderHook(() => usePaletteHotkey(store));
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(store.getState().paletteOpen).toBe(true);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(store.getState().paletteOpen).toBe(false);
    store.getState().openSheet({ kind: "new-space" });
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(store.getState().paletteOpen).toBe(false); // ignored while a sheet is open
  });
});

/** Plan 12 W3: the palette's settings entry survived the sheet's retirement — it opens the space PAGE.
 *  (An entry point silently dead is the failure mode; this one had no coverage in the sheet era.) */
describe("Open space (Plan 12 W3)", () => {
  it("runs openSpacePage for the active space — a pane, not a sheet", async () => {
    const { store } = await mount();
    fireEvent.change(input(), { target: { value: "open space" } });
    fireEvent.click(screen.getByRole("option", { name: /Open space/ }));
    await waitFor(() => expect(store.getState().items.some((i) => i.kind === "space-page" && i.refId === "s1")).toBe(true));
    expect(store.getState().sheet).toBeNull();
  });
});

/** Plan 12 W4: the destination pages get palette routes of their own. */
describe("Open library / Open connections (Plan 12 W4)", () => {
  it("Open library runs openDestinationPage — one library-page item in the active space", async () => {
    const { store } = await mount();
    fireEvent.change(input(), { target: { value: "open library" } });
    fireEvent.click(screen.getByRole("option", { name: /Open library/ }));
    await waitFor(() => expect(store.getState().items.some((i) => i.kind === "library-page")).toBe(true));
    expect(store.getState().items.filter((i) => i.kind === "library-page")).toHaveLength(1);
  });

  it("Open connections opens the connections-page item", async () => {
    const { store } = await mount();
    fireEvent.change(input(), { target: { value: "open connections" } });
    fireEvent.click(screen.getByRole("option", { name: /Open connections/ }));
    await waitFor(() => expect(store.getState().items.some((i) => i.kind === "connections-page")).toBe(true));
  });

  it("Open profile opens the profile-page item (Plan 14 W2) — the PROFILE page, not the space page", async () => {
    const { store } = await mount();
    fireEvent.change(input(), { target: { value: "open profile" } });
    fireEvent.click(screen.getByRole("option", { name: /Open profile/ }));
    await waitFor(() => expect(store.getState().items.some((i) => i.kind === "profile-page")).toBe(true));
    expect(store.getState().items.some((i) => i.kind === "space-page")).toBe(false);
  });

  it("Open settings opens the settings-page item (W6) — the SETTINGS page, not the space page", async () => {
    const { store } = await mount();
    fireEvent.change(input(), { target: { value: "open settings" } });
    fireEvent.click(screen.getByRole("option", { name: /Open settings/ }));
    await waitFor(() => expect(store.getState().items.some((i) => i.kind === "settings-page")).toBe(true));
    expect(store.getState().items.some((i) => i.kind === "space-page")).toBe(false);
  });
});

/** Plan 13 W2: the palette's dispatch entry — the honest shape: it dispatches the focused session's
 *  draft, and with nothing to dispatch it is disabled and says why. */
describe("Dispatch task (Plan 13 W2)", () => {
  const focusedSessionMount = async (draft: string) => {
    const it9 = item("i9", "s1", { kind: "session", refId: "se1" });
    const r = await mount({ items: { s1: [it9] }, sessions: [session("se1", "s1")] });
    act(() => r.store.setState({ layout: { type: "leaf", id: "L1", itemId: "i9" }, focusedLeafId: "L1" }));
    if (draft) act(() => r.store.getState().setDraft("se1", draft));
    return r;
  };

  it("with a draft: picking the entry dispatches it — session created with the user-dispatch origin, draft cleared", async () => {
    const { api, store } = await focusedSessionMount("build the thing");
    fireEvent.change(input(), { target: { value: "dispatch" } });
    fireEvent.click(screen.getByRole("option", { name: /Dispatch task/ }));
    await waitFor(() => expect(api.sent).toHaveLength(1));
    expect(api.sent[0]!.text).toBe("build the thing");
    expect(api.data.sessions.some((s) => s.dispatchedBy?.kind === "user-dispatch")).toBe(true);
    await waitFor(() => expect(store.getState().drafts["se1"]).toBe(""));
    expect(store.getState().paletteOpen).toBe(false);
  });

  it("with no draft: the entry is disabled and names what would arm it — picking it does nothing", async () => {
    const { api } = await focusedSessionMount("");
    fireEvent.change(input(), { target: { value: "dispatch" } });
    const opt = screen.getByRole("option", { name: /Dispatch task/ });
    expect(opt).toHaveAttribute("aria-disabled", "true");
    expect(opt.textContent).toContain("type a draft first");
    fireEvent.click(opt);
    expect(api.sent).toHaveLength(0);
    expect(api.data.sessions.some((s) => s.dispatchedBy !== null)).toBe(false);
  });

  it("with no focused session there is no entry at all", async () => {
    await mount();
    fireEvent.change(input(), { target: { value: "dispatch" } });
    expect(screen.queryByRole("option", { name: /Dispatch task/ })).toBeNull();
  });
});

describe("deep search (Plan 16 W2)", () => {
  const snip = (pre: string, hit: string, post = "") =>
    [{ text: pre, match: false }, { text: hit, match: true }, { text: post, match: false }];
  const empty = { sessions: [], items: [], skills: [], memory: [] };

  it("instant rows render synchronously while the deep query is still in flight — the no-await mutant", async () => {
    const { api } = await mount({ items: { s1: [item("i1", "s1", { title: "Terminal" })] } });
    api.delays["search"] = 60_000; // deep search effectively never answers inside this test
    fireEvent.change(input(), { target: { value: "term" } });
    // Deliberately NO waitFor: the instant path must not have awaited anything search-shaped.
    expect(options().some((x) => x?.startsWith("Terminal"))).toBe(true);
    expect(options().some((x) => x?.startsWith("New terminal"))).toBe(true);
  });

  it("appends grouped deep rows below the instant rows, and asks with the ACTIVE space's profile id", async () => {
    const { api } = await mount({ searchResults: {
      sessions: [{ sessionId: "sedeep", spaceId: "s1", title: "Login fix", seq: 5, snippet: snip("fix the ", "login", " flow") }],
      items: [{ itemId: "ideep", spaceId: "s1", itemKind: "browser" as const, title: "Auth docs", snippet: snip("", "login", " docs") }],
      skills: [{ id: "auth", name: "Auth helper", description: "does login things", snippet: snip("does ", "login", " things") }],
      memory: [{ scope: "space" as const, profileId: null, spaceId: "s1", title: "Versed memory", snippet: snip("the ", "login", " rules") }],
    } });
    fireEvent.change(input(), { target: { value: "login" } });
    await waitFor(() => expect(screen.getByRole("option", { name: /Login fix/ })).toBeInTheDocument());
    expect(api.calls).toContain("search:p1:login"); // the profile travels; the server enforces the fence
    // The four groups render their headers even mid-query (instant rows go flat; deep rows stay grouped).
    const secs = Array.from(document.querySelectorAll(".palette-sec")).map((el) => el.textContent);
    expect(secs).toEqual(["Sessions", "Skills", "Memory", "Items"]);
    // Every deep row sits below every instant row.
    const labels = options();
    const firstDeep = labels.findIndex((x) => x?.includes("Login fix"));
    for (const l of labels.slice(firstDeep)) expect(["Login fix", "Auth helper", "Versed memory", "Auth docs"].some((d) => l?.includes(d))).toBe(true);
    // Snippets render with their matches emphasised.
    expect(document.querySelectorAll(".palette-snippet mark").length).toBeGreaterThan(0);
  });

  it("a session hit opens that session's pane, selecting its space first", async () => {
    const { store } = await mount({
      items: { s1: [item("i1", "s1", { title: "Terminal" })], s2: [item("is2", "s2", { kind: "session", refId: "se2", title: "Elsewhere" })] },
      sessions: [session("se2", "s2")],
      searchResults: { ...empty, sessions: [{ sessionId: "se2", spaceId: "s2", title: "Elsewhere", seq: 3, snippet: snip("about ", "gadgets") }] },
    });
    fireEvent.change(input(), { target: { value: "gadgets" } });
    fireEvent.click(await screen.findByRole("option", { name: /Elsewhere/ }));
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
    await waitFor(() => { const l = store.getState().layout!; expect(l.type === "leaf" && l.itemId).toBe("is2"); });
    expect(store.getState().paletteOpen).toBe(false);
  });

  it("a skill hit routes to the Library page; a memory hit to the space page's Memory tab", async () => {
    const { store, api } = await mount({ searchResults: { ...empty,
      skills: [{ id: "auth", name: "Auth helper", description: "does login", snippet: snip("does ", "login") }],
      memory: [{ scope: "space" as const, profileId: null, spaceId: "s1", title: "Versed memory", snippet: snip("the ", "login") }],
    } });
    act(() => store.setState({ layout: { type: "leaf", id: "L1", itemId: null }, focusedLeafId: "L1" }));
    fireEvent.change(input(), { target: { value: "login" } });
    fireEvent.click(await screen.findByRole("option", { name: /Auth helper/ }));
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("createItem:s1|library-page"))).toBe(true));
    act(() => store.setState({ paletteOpen: true }));
    fireEvent.change(input(), { target: { value: "login" } });
    fireEvent.click(await screen.findByRole("option", { name: /Versed memory/ }));
    await waitFor(() => expect(store.getState().spacePageTab["s1"]).toBe("memory"));
  });

  it("deep item hits already shown as instant rows are not repeated", async () => {
    await mount({
      items: { s1: [item("i1", "s1", { title: "Login docs" })] },
      searchResults: { ...empty, items: [{ itemId: "i1", spaceId: "s1", itemKind: "terminal" as const, title: "Login docs", snippet: snip("", "Login", " docs") }] },
    });
    fireEvent.change(input(), { target: { value: "login" } });
    // Give the deep answer time to land, then count: one row, not two.
    await waitFor(() => expect(screen.getAllByRole("option").filter((o) => o.textContent?.includes("Login docs"))).toHaveLength(1));
    expect(Array.from(document.querySelectorAll(".palette-sec")).map((el) => el.textContent)).toEqual([]);
  });

  it("quiet states are honest: 'Searching…' while in flight, 'No matches' only once settled empty", async () => {
    const { api } = await mount({ searchResults: empty });
    api.delays["search"] = 250;
    fireEvent.change(input(), { target: { value: "zzzz" } });
    await waitFor(() => expect(screen.getByText("Searching…")).toBeInTheDocument());
    expect(screen.queryByText("No matches")).toBeNull(); // not settled yet — do not claim emptiness
    await waitFor(() => expect(screen.getByText("No matches")).toBeInTheDocument());
    expect(screen.queryByText("Searching…")).toBeNull();
  });

  it("below two characters no deep query is sent at all", async () => {
    const { api } = await mount();
    fireEvent.change(input(), { target: { value: "t" } });
    await new Promise((r) => setTimeout(r, 250)); // well past the debounce
    expect(api.calls.some((c) => c.startsWith("search:"))).toBe(false);
  });
});
