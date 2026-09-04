import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session, skillRow } from "../../state/store.test-fakes";
import { SessionPane } from "./SessionPane";
import { reduceAll } from "./transcript-model";

/**
 * The prompter's rich-text layer, wired up: the mirror that paints the draft and the list keys that
 * rewrite it. `draft-format.test.ts` proves the functions; this proves they are actually ON the
 * textarea, that the mirror re-paints as the draft changes, and — the thing a highlight layer breaks
 * first — that colouring the draft never changes what is sent.
 */
async function mount(submitKey: "enter" | "cmdEnter" = "enter") {
  const api = fakeApi({
    sessions: [session("se1", "s1", { status: "idle", agentKind: "claude" })],
    items: { s1: [item("i9", "s1", { kind: "session", refId: "se1", title: "s" })] },
    skills: { s1: [skillRow("mac"), skillRow("web", { enabled: false })] },
  });
  const store = createAppStore(api);
  await store.getState().boot();
  store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: 0, t: reduceAll([]) } }, submitKey });
  render(
    <StoreContext.Provider value={store}>
      <SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "s" })} visible />
    </StoreContext.Provider>,
  );
  await waitFor(() => expect(store.getState().spaceSkills.s1).toBeTruthy());
  await act(async () => { await new Promise((res) => setTimeout(res, 1)); });
  return { api, store };
}

const box = () => screen.getByRole("textbox", { name: /message/i }) as HTMLTextAreaElement;
const mirror = () => document.querySelector(".composer-highlight")!;
/** The mirror's painted runs, as [class, text] — its plain text is untagged and not listed. */
const painted = () => Array.from(mirror().querySelectorAll("span")).map((el) => [el.className, el.textContent]);
const type = (value: string) => fireEvent.change(box(), { target: { value } });
/** Type, then put the caret where a user's would be: at the end, unless `at` says otherwise. */
const typeAt = (value: string, at = value.length) => {
  type(value);
  box().setSelectionRange(at, at);
  fireEvent.select(box());
};

describe("the prompter's rich-text mirror", () => {
  it("paints links and live mentions, and reproduces the draft exactly", async () => {
    await mount();
    type("https://piazza.com/usc\n\nyou can use @mac for this");
    expect(painted()).toEqual([
      ["ch-link", "https://piazza.com/usc"],
      ["ch-mention", "@mac"],
    ]);
    // Character-for-character, or every glyph past the divergence sits off the caret above it.
    expect(mirror().textContent).toBe("https://piazza.com/usc\n\nyou can use @mac for this");
  });

  it("re-paints on every edit, and drops a highlight the moment the token stops being one", async () => {
    await mount();
    type("@mac");
    expect(painted()).toEqual([["ch-mention", "@mac"]]);
    type("@macs"); // no longer an id that resolves
    expect(painted()).toEqual([]);
  });

  it("does not paint a skill this session cannot hand over", async () => {
    await mount();
    type("@web now"); // in the library, but disabled — it is going as plain text
    expect(painted()).toEqual([]);
  });

  /* The mirror is decoration over the real control. If it ever became the source of truth, this is
     the test that would notice: the sent text and the declared mentions come from the draft alone. */
  it("paints an element chip the picker dropped in, without touching what is sent", async () => {
    const { api, store } = await mount();
    store.getState().addElementChip("se1", {
      ref: 42, url: "https://example.com/login", title: "Sign in", rect: { x: 0, y: 0, w: 1, h: 1 },
      selector: "#submit", tag: "button", role: "button", name: "Sign in",
      text: "Sign in", html: '<button id="submit">Sign in</button>',
    });
    typeAt(`${store.getState().drafts.se1}make it blue`);
    expect(painted()).toEqual([["ch-element", '@[button "Sign in"]']]);
    fireEvent.keyDown(box(), { key: "Enter", metaKey: true });
    await waitFor(() => expect(api.sent).toHaveLength(1));
    // The chip is paint over a token; the token is what travels, byte for byte, and the element
    // rides beside it rather than being spliced into the text.
    expect(api.sent[0]!.text).toBe('@[button "Sign in"] make it blue');
  });

  it("Backspace behind an element chip takes the whole token, and one keystroke does it", async () => {
    const { store } = await mount();
    typeAt('make @[button "Sign in"] blue');
    const el = box();
    el.setSelectionRange(24, 24); // just past the closing bracket
    fireEvent.keyDown(el, { key: "Backspace" });
    expect(store.getState().drafts.se1).toBe("make  blue");
  });

  it("Backspace inside the chip's label is an ordinary Backspace — the browser handles it", async () => {
    const { store } = await mount();
    typeAt("@[abc]");
    const el = box();
    el.setSelectionRange(4, 4);
    fireEvent.keyDown(el, { key: "Backspace" });
    // Not consumed: the draft is untouched here because jsdom does not apply the default action.
    expect(store.getState().drafts.se1).toBe("@[abc]");
  });

  it("changes nothing about what is sent", async () => {
    const { api } = await mount();
    type("see https://x.dev and use @mac");
    fireEvent.keyDown(box(), { key: "Enter", metaKey: true });
    await waitFor(() => expect(api.sent).toHaveLength(1));
    expect(api.sent[0]).toEqual({ id: "se1", text: "see https://x.dev and use @mac", attachments: [], mentions: ["mac"] });
  });

  /* A block drops its final line break; a textarea keeps it. Without the compensating newline the
     mirror runs one line short of the textarea from the first blank line to the bottom of the draft. */
  it("keeps a draft's trailing newline, which a block would otherwise swallow", async () => {
    await mount();
    type("- one\n");
    expect(mirror().textContent).toBe("- one\n\n");
  });

  it("hides the mirror from assistive tech — the textarea already exposes this text", async () => {
    await mount();
    expect(mirror().getAttribute("aria-hidden")).toBe("true");
  });
});

describe("list authoring in the prompter", () => {
  it("Shift+Enter carries a bullet list on, and ⌘↵ still sends", async () => {
    const { api, store } = await mount();
    typeAt("- one");
    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
    expect(store.getState().drafts.se1).toBe("- one\n- ");
    typeAt("- one\n- two");
    fireEvent.keyDown(box(), { key: "Enter", metaKey: true });
    await waitFor(() => expect(api.sent).toHaveLength(1));
    expect(api.sent[0]!.text).toBe("- one\n- two");
  });

  it("numbers an ordered list as it goes", async () => {
    const { store } = await mount();
    typeAt("1. first");
    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
    expect(store.getState().drafts.se1).toBe("1. first\n2. ");
  });

  it("ends the list on an empty item instead of bulleting forever", async () => {
    const { store } = await mount();
    typeAt("- one\n- ");
    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
    expect(store.getState().drafts.se1).toBe("- one\n");
  });

  /* Plain Enter is the send key by default, and list continuation must never quietly take it. */
  it("leaves plain Enter as send in the default mode, even inside a list", async () => {
    const { api, store } = await mount("enter");
    typeAt("- one");
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(api.sent).toHaveLength(1));
    expect(api.sent[0]!.text).toBe("- one");
    expect(store.getState().drafts.se1).toBe("");
  });

  it("continues the list on plain Enter when Enter is not the send key", async () => {
    const { api, store } = await mount("cmdEnter");
    typeAt("- one");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(store.getState().drafts.se1).toBe("- one\n- ");
    expect(api.sent).toEqual([]);
  });

  it("Tab indents inside a list and stays the Tab key outside one", async () => {
    const { store } = await mount();
    typeAt("- one");
    const inList = fireEvent.keyDown(box(), { key: "Tab" });
    expect(store.getState().drafts.se1).toBe("  - one");
    expect(inList).toBe(false); // preventDefault'd: the key was consumed
    fireEvent.keyDown(box(), { key: "Tab", shiftKey: true });
    await waitFor(() => expect(store.getState().drafts.se1).toBe("- one"));

    typeAt("just prose");
    // Not a list: Tab must reach the browser, or the textarea becomes a keyboard trap.
    expect(fireEvent.keyDown(box(), { key: "Tab" })).toBe(true);
    expect(store.getState().drafts.se1).toBe("just prose");
  });

  it("⌘⇧8 / ⌘⇧7 toggle the selected lines, and leave them selected", async () => {
    const { store } = await mount();
    type("a\nb");
    box().setSelectionRange(0, 3);
    fireEvent.keyDown(box(), { key: "*", code: "Digit8", metaKey: true, shiftKey: true });
    await waitFor(() => expect(store.getState().drafts.se1).toBe("- a\n- b"));
    expect([box().selectionStart, box().selectionEnd]).toEqual([0, 7]);
    fireEvent.keyDown(box(), { key: "&", code: "Digit7", metaKey: true, shiftKey: true });
    await waitFor(() => expect(store.getState().drafts.se1).toBe("1. a\n2. b"));
    // The markers are painted as structure, not left as plain punctuation.
    expect(painted()).toEqual([["ch-marker", "1."], ["ch-marker", "2."]]);
  });
});
