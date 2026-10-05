import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { Skill } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session, skillRow } from "../../state/store.test-fakes";
import { SessionPane } from "./SessionPane";
import { reduceAll } from "./transcript-model";
import { filterMentionSkills, mentionQueryAt } from "./MentionPicker";

/** Library: two mentionable skills, one disabled, one invalid — the last two must NEVER be offered. */
const LIBRARY = [
  skillRow("mac"),
  skillRow("mac-cli", { name: "Mac CLI" }),
  skillRow("web", { enabled: false }),
  skillRow("broken", { valid: false, reason: "no `name`" }),
];

async function mount(agentKind: "claude" | "acp:cursor" = "claude", skills: Skill[] = LIBRARY) {
  const api = fakeApi({
    sessions: [session("se1", "s1", { status: "idle", agentKind })],
    items: { s1: [item("i9", "s1", { kind: "session", refId: "se1", title: "s" })] },
    skills: { s1: skills },
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
const type = (value: string) => fireEvent.change(box(), { target: { value } });
const picker = () => screen.queryByRole("listbox", { name: "Skills" });
const optionIds = () => (picker() ? Array.from(picker()!.querySelectorAll("[role=option] .mention-row-id")).map((el) => el.textContent) : null);

describe("the prompter's @-mention picker (Plan 8 W4)", () => {
  it("typing @ opens the popover listing ONLY enabled, valid skills — name + description — and filters as you type", async () => {
    await mount();
    expect(picker()).toBeNull();
    type("@");
    expect(optionIds()).toEqual(["@mac", "@mac-cli"]); // never @web (disabled), never @broken (invalid)
    expect(screen.getByText("does mac")).toBeInTheDocument();
    expect(screen.getByText(/Mac CLI — does mac-cli/)).toBeInTheDocument(); // display name ≠ id gets both
    type("@mac-");
    expect(optionIds()).toEqual(["@mac-cli"]);
    type("@zzz");
    expect(picker()).toBeNull(); // nothing matches: no empty husk of a popover
  });

  it("↑↓ move the highlight; Enter inserts the highlighted token (with its trailing space) instead of newline-or-send", async () => {
    const { api, store } = await mount();
    type("@ma");
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(picker()!.querySelector("[data-active] .mention-row-id")!.textContent).toBe("@mac-cli");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(store.getState().drafts.se1).toBe("@mac-cli ");
    expect(store.getState().draftMentions.se1).toEqual(["mac-cli"]);
    expect(picker()).toBeNull(); // the completed token no longer has the caret mid-token
    expect(api.sent).toEqual([]); // Enter PICKED; it did not send
  });

  it("NEVER opens in a Cursor session — an affordance that would silently do nothing is not offered", async () => {
    const { store } = await mount("acp:cursor");
    // Belt and braces: even with the library loaded into the store, the agent gate holds.
    store.setState({ spaceSkills: { s1: LIBRARY } });
    type("@");
    expect(picker()).toBeNull();
    type("@mac");
    expect(picker()).toBeNull();
  });

  it("Escape dismisses THIS token and stays dismissed while it is typed on; a fresh @ reopens", async () => {
    await mount();
    type("@ma");
    expect(picker()).not.toBeNull();
    // The popover arms its Escape listener on a deferred tick after IT mounts; settle that first.
    await act(async () => { await new Promise((res) => setTimeout(res, 1)); });
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(picker()).toBeNull();
    type("@mac"); // same token, more characters: stays closed
    expect(picker()).toBeNull();
    type(""); // token gone: dismissal cleared
    type("@m");
    expect(picker()).not.toBeNull();
  });

  it("a mention-bearing draft survives a pane remount, recognition included (A-M9)", async () => {
    const { store, view, unmount } = await mount();
    type("@mac list my reminders");
    unmount();
    const r2 = render(view());
    expect((await r2.findByRole("textbox", { name: /message/i }) as HTMLTextAreaElement).value).toBe("@mac list my reminders");
    expect(store.getState().draftMentions.se1).toEqual(["mac"]);
  });

  it("a recognised mention whose skill was disabled after typing gets the warning note — and still degrades, never resolves", async () => {
    const { api, store } = await mount();
    type("use @mac now");
    expect(store.getState().draftMentions.se1).toEqual(["mac"]);
    api.data.skills.s1 = [skillRow("mac", { enabled: false })];
    await act(() => store.getState().refreshSkills("s1"));
    const note = await screen.findByText(/sent as plain text, without the @/i);
    expect(note.parentElement!.textContent).toContain("@mac");
    fireEvent.keyDown(box(), { key: "Enter", metaKey: true });
    await waitFor(() => expect(api.sent).toHaveLength(1));
    expect(api.sent[0]!.mentions).toEqual(["mac"]); // declared so the server strips the @; the server refuses the resolve
  });

  it("does not fight the attachment handlers: a paste with files still attaches while the picker is open", async () => {
    const { store } = await mount();
    type("@ma");
    expect(picker()).not.toBeNull();
    const file = new File([new Uint8Array([1])], "shot.png", { type: "image/png" });
    Object.defineProperty(file, "path", { value: "/x/shot.png" });
    fireEvent.paste(box(), { clipboardData: { files: [file] } });
    await waitFor(() => expect(store.getState().pendingAttachments.se1).toHaveLength(1));
    expect(store.getState().drafts.se1).toBe("@ma"); // the draft (and its open token) is untouched
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
    type("@");
    const surface = picker()!;
    const list = surface.querySelector<HTMLElement>(".mention-list")!;
    expect(list).not.toBeNull();
    expect(surface.hasAttribute("data-dissolve")).toBe(false);
    expect(list.hasAttribute("data-dissolve")).toBe(true);
    overflowing(list);
    expect(list.dataset.dissolve).toBe("end"); // more rows below, nothing above yet
    // The options are still the listbox's own, to assistive tech: the scroller is presentational.
    expect(list).toHaveAttribute("role", "presentation");
    expect(surface.querySelectorAll("[role=option]")).toHaveLength(12);
  });

  it("the keyboard brings the highlight into view; the pointer never scrolls the list under itself", async () => {
    // jsdom has no scrolling, so `scrollIntoView` is not on Element at all; the stub is the record.
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.id); };
    try {
      await mount("claude", LONG);
      type("@");
      fireEvent.keyDown(box(), { key: "ArrowDown" });
      expect(scrolled.at(-1)).toBe("mention-skill-01");
      // Hovering a row in the band highlights it where it stands — scrolling it clear would move the
      // row out from under the pointer, and the next pixel of movement would light a different one.
      const before = scrolled.length;
      fireEvent.mouseEnter(screen.getByRole("option", { name: /skill-07/ }));
      expect(picker()!.querySelector("[data-active] .mention-row-id")!.textContent).toBe("@skill-07");
      expect(scrolled.length).toBe(before);
      // …and the next arrow press is the keyboard again, so it does scroll.
      fireEvent.keyDown(box(), { key: "ArrowDown" });
      expect(scrolled.at(-1)).toBe("mention-skill-08");
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
});

describe("filterMentionSkills", () => {
  const skills = [skillRow("mac"), skillRow("mac-cli", { name: "Mac CLI" })];
  it("matches by id or display name, case-insensitively; empty query keeps everything", () => {
    expect(filterMentionSkills(skills, "").map((s) => s.id)).toEqual(["mac", "mac-cli"]);
    expect(filterMentionSkills(skills, "CLI").map((s) => s.id)).toEqual(["mac-cli"]);
    expect(filterMentionSkills(skills, "zzz")).toEqual([]);
  });
});
