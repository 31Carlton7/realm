import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { InstalledApp, LibraryEntry, Skill } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session, skillRow, type FakeData } from "../../state/store.test-fakes";
import { SessionPane } from "./SessionPane";
import { reduceAll } from "./transcript-model";
import { filterMentionSkills, mentionQueryAt } from "./MentionPicker";

/** Library: two mentionable skills, one disabled, one invalid — the last two must NEVER be offered. */
const LIBRARY = [
  skillRow("notes"),
  skillRow("notes-cli", { name: "Notes CLI" }),
  skillRow("web", { enabled: false }),
  skillRow("broken", { valid: false, reason: "no `name`" }),
];

const app = (name: string, bundleId: string, extra: Partial<InstalledApp> = {}): InstalledApp =>
  ({ name, bundleId, path: `/Applications/${name}.app`, aliases: [], dock: null, ...extra });
const entry = (name: string, path: string, extra: Partial<LibraryEntry> = {}): LibraryEntry =>
  ({ id: `se9:1:${path}`, sessionId: "se9", spaceId: "s1", kind: "output", path, name, ext: name.split(".").pop() ?? "", ts: 1, sessionTitle: "Weekly report", agentKind: "claude", ...extra });
const GRANTED: FakeData["computerAccess"] = {
  hostName: "Realm", packaged: true, helperAvailable: true,
  rows: [{ id: "accessibility", label: "Accessibility", state: "granted", detail: "", canPrompt: false, needsSettings: false, askExplanation: null }],
};

async function mount(agentKind: "claude" | "acp:cursor" = "claude", skills: Skill[] = LIBRARY, extra: FakeData = {}) {
  const api = fakeApi({
    sessions: [session("se1", "s1", { status: "idle", agentKind, cwd: "/repo" })],
    items: { s1: [item("i9", "s1", { kind: "session", refId: "se1", title: "s" })] },
    skills: { s1: skills },
    ...extra,
  });
  const store = createAppStore(api);
  await store.getState().boot();
  store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: 0, t: reduceAll([]) } } });
  const view = () => <StoreContext.Provider value={store}><SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "s" })} visible /></StoreContext.Provider>;
  const r = render(view());
  // The pane's openSession is what fetches the library for a skills-capable agent.
  if (agentKind === "claude") await waitFor(() => expect(store.getState().spaceSkills.s1).toBeTruthy());
  // The popover hook arms its Escape/outside listeners on a 0ms timeout; settle it once here.
  await act(async () => { await new Promise((res) => setTimeout(res, 1)); });
  return { api, store, view, ...r };
}

const box = () => screen.getByRole("textbox", { name: /message/i }) as HTMLTextAreaElement;
/** Type, then let the two answers that come over the wire (files, Library) land. */
const type = async (value: string) => {
  fireEvent.change(box(), { target: { value } });
  await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
};
const picker = () => screen.queryByRole("listbox", { name: "Mentions" });
const names = () => (picker() ? Array.from(picker()!.querySelectorAll("[role=option] .mention-row-name")).map((el) => el.textContent) : null);
const heads = () => Array.from(picker()?.querySelectorAll(".mention-head") ?? []).map((el) => el.textContent);
const row = (name: string) => Array.from(picker()!.querySelectorAll<HTMLElement>("[role=option]")).find((el) => el.querySelector(".mention-row-name")?.textContent === name)!;

describe("the prompter's @ list — skills (Plan 8 W4)", () => {
  it("typing @ lists ONLY enabled, valid skills — name and description — and filters as you type", async () => {
    await mount();
    expect(picker()).toBeNull();
    await type("@");
    expect(names()).toEqual(["notes", "notes-cli"]); // never web (disabled), never broken (invalid)
    expect(screen.getByText("does notes")).toBeInTheDocument();
    expect(screen.getByText(/Notes CLI — does notes-cli/)).toBeInTheDocument(); // display name ≠ id gets both
    await type("@notes-");
    expect(names()).toEqual(["notes-cli"]);
    await type("@zzz");
    expect(picker()).toBeNull(); // nothing matches: no empty husk of a popover
  });

  it("↑↓ move the highlight; Enter inserts the highlighted token (with its trailing space) instead of newline-or-send", async () => {
    const { api, store } = await mount();
    await type("@no");
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(picker()!.querySelector("[data-active] .mention-row-name")!.textContent).toBe("notes-cli");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(store.getState().drafts.se1).toBe("@notes-cli ");
    expect(store.getState().draftMentions.se1).toEqual(["notes-cli"]);
    expect(picker()).toBeNull(); // the completed token no longer has the caret mid-token
    expect(api.sent).toEqual([]); // Enter PICKED; it did not send
  });

  it("offers no skills in a Cursor session — and nothing at all where nothing else can be named", async () => {
    const { store } = await mount("acp:cursor");
    // Belt and braces: even with the library loaded into the store, the agent gate holds.
    store.setState({ spaceSkills: { s1: LIBRARY } });
    await type("@");
    expect(picker()).toBeNull(); // no files, no Library, no apps, no @Mac: an empty husk is not offered
    await type("@notes");
    expect(picker()).toBeNull();
  });

  it("Escape dismisses THIS token and stays dismissed while it is typed on; a fresh @ reopens", async () => {
    await mount();
    await type("@no");
    expect(picker()).not.toBeNull();
    // The popover arms its Escape listener on a deferred tick after IT mounts; settle that first.
    await act(async () => { await new Promise((res) => setTimeout(res, 1)); });
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(picker()).toBeNull();
    await type("@note"); // same token, more characters: stays closed
    expect(picker()).toBeNull();
    await type(""); // token gone: dismissal cleared
    await type("@n");
    expect(picker()).not.toBeNull();
  });

  it("a mention-bearing draft survives a pane remount, recognition included (A-M9)", async () => {
    const { store, view, unmount } = await mount();
    await type("@notes list my notes");
    unmount();
    const r2 = render(view());
    expect((await r2.findByRole("textbox", { name: /message/i }) as HTMLTextAreaElement).value).toBe("@notes list my notes");
    expect(store.getState().draftMentions.se1).toEqual(["notes"]);
  });

  it("a recognised mention whose skill was disabled after typing gets the warning note — and still degrades, never resolves", async () => {
    const { api, store } = await mount();
    await type("use @notes now");
    expect(store.getState().draftMentions.se1).toEqual(["notes"]);
    api.data.skills.s1 = [skillRow("notes", { enabled: false })];
    await act(() => store.getState().refreshSkills("s1"));
    const note = await screen.findByText(/sent as plain text, without the @/i);
    expect(note.parentElement!.textContent).toContain("@notes");
    fireEvent.keyDown(box(), { key: "Enter", metaKey: true });
    await waitFor(() => expect(api.sent).toHaveLength(1));
    expect(api.sent[0]!.mentions).toEqual(["notes"]); // declared so the server strips the @; the server refuses the resolve
  });

  it("does not fight the attachment handlers: a paste with files still attaches while the picker is open", async () => {
    const { store } = await mount();
    await type("@no");
    expect(picker()).not.toBeNull();
    const file = new File([new Uint8Array([1])], "shot.png", { type: "image/png" });
    Object.defineProperty(file, "path", { value: "/x/shot.png" });
    fireEvent.paste(box(), { clipboardData: { files: [file] } });
    await waitFor(() => expect(store.getState().pendingAttachments.se1).toHaveLength(1));
    expect(store.getState().drafts.se1).toBe("@no"); // the draft (and its open token) is untouched
  });
});

describe("the @ list — files, the Library, apps and @Mac", () => {
  const WIDE: FakeData = {
    workspaceFiles: { se1: ["src/server/auth.ts", "src/auth.test.ts", "README.md", ".env"] },
    artifacts: [entry("report.pdf", "/home/out/report.pdf"), entry("auth.ts", "/repo/src/server/auth.ts"), entry(".env.local", "/home/out/.env.local")],
    installedApps: [app("Calendar", "com.apple.iCal"), app("Messages", "com.apple.MobileSMS", { dock: 0 }), app("Sketchpad", "com.example.sketchpad", { aliases: ["Sketch Pad"] })],
    appIcons: { "/Applications/Messages.app": "data:image/png;base64,TUVTUw==" },
  };

  it("a bare @ is a short tour: @Mac on its own, then each kind under its head", async () => {
    await mount("claude", [skillRow("mac"), ...LIBRARY], WIDE);
    await type("@");
    await waitFor(() => expect(heads()).toEqual(["Files", "Library", "Skills", "Apps"]));
    // @Mac is the `mac` skill and is listed ONCE, as itself — never again under Skills.
    expect(names()).toEqual(["mac", "auth.ts", "auth.test.ts", "README.md", "report.pdf", "notes", "notes-cli", "Messages", "Calendar", "Sketchpad"]);
    // The checkout's `.env` and the Library's `.env.local` are never offered, and the Library's
    // copy of a file that is in this checkout is the same file, listed once, as the file.
    expect(names()).not.toContain(".env");
    expect(row("mac").querySelector("[data-brand=apple]")).not.toBeNull();
  });

  it("a typed word is ONE ranked list across kinds, each row saying what it is", async () => {
    await mount("claude", LIBRARY, { ...WIDE, computerAccess: GRANTED });
    await type("@mes");
    await waitFor(() => expect(names()?.[0]).toBe("Messages"));
    expect(heads()).toEqual([]);
    expect(row("Messages").querySelector(".mention-row-desc")!.textContent).toBe("Computer use");
    await type("@auth");
    await waitFor(() => expect(names()).toEqual(["auth.ts", "auth.test.ts"]));
    expect(row("auth.ts").querySelector(".mention-row-desc")!.textContent).toBe("File · src/server");
    await type("@sketchp"); // an app is found by the other names it answers to as well
    await waitFor(() => expect(names()).toEqual(["Sketchpad"]));
  });

  it("picking a file writes its chip and remembers what the chip stands for — and the send carries it", async () => {
    const { store, api } = await mount("claude", LIBRARY, WIDE);
    await type("explain @auth");
    await waitFor(() => expect(names()?.[0]).toBe("auth.ts"));
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(store.getState().drafts.se1).toBe("explain @[auth.ts] ");
    expect(store.getState().draftRefs.se1).toEqual([{ kind: "file", label: "auth.ts", path: "/repo/src/server/auth.ts" }]);
    fireEvent.keyDown(box(), { key: "Enter", metaKey: true });
    await waitFor(() => expect(api.sent).toHaveLength(1));
    expect(api.sent[0]).toMatchObject({ text: "explain @[auth.ts]", attachments: [], mentionRefs: [{ kind: "file", label: "auth.ts", path: "/repo/src/server/auth.ts" }] });
  });

  it("picking an app writes its chip under its own icon, and deleting the chip forgets it", async () => {
    const { store, container } = await mount("claude", LIBRARY, { ...WIDE, computerAccess: GRANTED });
    await type("text mom on @messages");
    await waitFor(() => expect(row("Messages").querySelector("img")).not.toBeNull());
    // An agent driving Realm's own window may not click the row that grants it computer use.
    expect(row("Messages")).toHaveAttribute("data-no-agent", "computer use grant");
    fireEvent.click(row("Messages"));
    expect(store.getState().drafts.se1).toBe("text mom on @[Messages] ");
    expect(store.getState().draftRefs.se1).toEqual([{ kind: "app", label: "Messages", name: "Messages", bundleId: "com.apple.MobileSMS", path: "/Applications/Messages.app" }]);
    const chip = container.querySelector<HTMLElement>(".composer-highlight .ch-element[data-ref=app]")!;
    expect(chip.querySelector("img.chip-app")).toHaveAttribute("src", "data:image/png;base64,TUVTUw==");
    expect(chip.hasAttribute("data-warn")).toBe(false);
    await type("text mom on ");
    expect(store.getState().draftRefs.se1).toEqual([]);
  });

  it("says plainly when macOS has not let Realm drive apps: on the row, on the chip, and under the card", async () => {
    const { container } = await mount("claude", LIBRARY, WIDE); // the fake's Accessibility is denied
    await type("@messag");
    await waitFor(() => expect(row("Messages").querySelector(".mention-row-desc")!.textContent).toBe("Computer use · needs Accessibility"));
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(container.querySelector(".composer-highlight .ch-element[data-ref=app]")).toHaveAttribute("data-warn");
    expect(screen.getByText(/Computer use needs Accessibility, which macOS has not given Realm/)).toBeInTheDocument();
  });

  it("@Mac inserts the mac skill's token and wears the Apple mark — in a Cursor session too", async () => {
    const { store, container } = await mount("acp:cursor", [skillRow("mac", { enabled: false })]);
    await act(() => store.getState().refreshSkills("s1"));
    await type("@ma");
    await waitFor(() => expect(names()).toEqual(["mac"]));
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(store.getState().drafts.se1).toBe("@mac ");
    // Recognised (and so declared at send) even with the skill off and an agent that takes no skills:
    // the server hands it over by its instructions where it cannot invoke it.
    expect(store.getState().draftMentions.se1).toEqual(["mac"]);
    expect(container.querySelector(".composer-highlight .ch-mention [data-brand=apple]")).not.toBeNull();
    expect(screen.queryByText(/sent as plain text/i)).toBeNull();
  });
});

/**
 * The popover's rows run out into its edges rather than being cut by them — the app's scroll
 * dissolve, on a scroller INSIDE the surface. A mask applies to everything an element paints, so on
 * the surface itself it would fade the card's own fill and corner out along with the rows.
 */
describe("the @ and / popovers dissolve their rows, never their surface", () => {
  const LONG = Array.from({ length: 12 }, (_, i) => skillRow(`skill-${String(i).padStart(2, "0")}`));
  /** jsdom lays nothing out, so the scroller's metrics are stated — 12 rows in a box of 4. */
  const overflowing = (el: HTMLElement) => act(() => {
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 400 });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 120 });
    el.dispatchEvent(new Event("scroll"));
  });

  it("marks the rows' own scroller with the dissolve — THE mutant is the mask on the card", async () => {
    await mount("claude", LONG);
    await type("@skill");
    const surface = picker()!;
    const list = surface.querySelector<HTMLElement>(".mention-list")!;
    expect(list).not.toBeNull();
    expect(surface.hasAttribute("data-dissolve")).toBe(false);
    expect(list.hasAttribute("data-dissolve")).toBe(true);
    overflowing(list);
    expect(list.dataset.dissolve).toBe("end"); // more rows below, nothing above yet
    // The options are still the listbox's own, to assistive tech: the scroller is presentational.
    expect(list).toHaveAttribute("role", "presentation");
    expect(surface.querySelectorAll("[role=option]")).toHaveLength(4); // a typed answer holds four skills at most
  });

  it("the keyboard brings the highlight into view; the pointer never scrolls the list under itself", async () => {
    // jsdom has no scrolling, so `scrollIntoView` is not on Element at all; the stub is the record.
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.id); };
    try {
      await mount("claude", LONG);
      await type("@");
      fireEvent.keyDown(box(), { key: "ArrowDown" });
      expect(scrolled.at(-1)).toBe("mention-skill:skill-01");
      // Hovering a row in the band highlights it where it stands — scrolling it clear would move the
      // row out from under the pointer, and the next pixel of movement would light a different one.
      const before = scrolled.length;
      fireEvent.mouseEnter(screen.getByRole("option", { name: /skill-03/ }));
      expect(picker()!.querySelector("[data-active] .mention-row-name")!.textContent).toBe("skill-03");
      expect(scrolled.length).toBe(before);
      // …and the next arrow press is the keyboard again, so it does scroll.
      fireEvent.keyDown(box(), { key: "ArrowDown" });
      expect(scrolled.at(-1)).toBe("mention-skill:skill-04");
    } finally { delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView; }
  });
});

describe("mentionQueryAt", () => {
  it("finds the token governing the caret, token-initial only", () => {
    expect(mentionQueryAt("@ma", 3)).toEqual({ start: 0, end: 3, query: "ma" });
    expect(mentionQueryAt("hi @m", 5)).toEqual({ start: 3, end: 5, query: "m" });
    expect(mentionQueryAt("hi @", 4)).toEqual({ start: 3, end: 4, query: "" });
    expect(mentionQueryAt("carlton@mac", 11)).toBeNull(); // email: @ not token-initial
    expect(mentionQueryAt("no at here", 5)).toBeNull();
    expect(mentionQueryAt("@mac go", 7)).toBeNull(); // caret outside the token
  });
  it("extends `end` past the caret so completion replaces the whole token, never splitting it", () => {
    expect(mentionQueryAt("@mac", 2)).toEqual({ start: 0, end: 4, query: "m" });
  });
  it("lets a path's slash into the query, so `@src/au` searches files", () => {
    expect(mentionQueryAt("see @src/au", 11)).toEqual({ start: 4, end: 11, query: "src/au" });
  });
});

describe("filterMentionSkills", () => {
  const skills = [skillRow("mac"), skillRow("mac-cli", { name: "Mac CLI" })];
  it("matches by id or display name, case-insensitively; empty query keeps everything", () => {
    expect(filterMentionSkills(skills, "").map((s) => s.id)).toEqual(["mac", "mac-cli"]);
    expect(filterMentionSkills(skills, "CLI").map((s) => s.id)).toEqual(["mac-cli"]);
    expect(filterMentionSkills(skills, "zzz")).toEqual([]);
  });
});
