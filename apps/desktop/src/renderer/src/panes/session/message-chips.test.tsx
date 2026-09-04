import { describe, expect, it } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import { sessionEvent, type Skill } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session, skillRow } from "../../state/store.test-fakes";
import { SessionPane } from "./SessionPane";

const LIBRARY = [skillRow("mac"), skillRow("web", { enabled: false })];
const paneItem = item("i9", "s1", { kind: "session", refId: "se1", title: "s" });

/** Mount a session whose transcript already holds one sent user message. */
async function mount(text: string, opts: { skills?: Skill[]; agentKind?: "claude" | "acp:cursor" } = {}) {
  const api = fakeApi({
    sessions: [session("se1", "s1", { status: "idle", agentKind: opts.agentKind ?? "claude" })],
    items: { s1: [paneItem] },
    skills: { s1: opts.skills ?? LIBRARY },
    sessionEvents: { se1: [{ seq: 1, sessionId: "se1", event: sessionEvent("user_message", { text, attachments: [] }) }] },
  });
  const store = createAppStore(api);
  await store.getState().boot();
  store.setState({ sessionStatus: { se1: "idle" } });
  render(<StoreContext.Provider value={store}><SessionPane item={paneItem} visible /></StoreContext.Provider>);
  await waitFor(() => expect(document.querySelector(".msg-user")).toBeTruthy());
  if ((opts.agentKind ?? "claude") === "claude") await waitFor(() => expect(store.getState().spaceSkills.s1).toBeTruthy());
  await act(async () => { await new Promise((res) => setTimeout(res, 1)); });
  return { store };
}

const bubble = () => document.querySelector(".msg-user")!;
const chips = () => Array.from(bubble().querySelectorAll(".msg-chip")).map((el) => [el.getAttribute("data-kind"), el.textContent]);

/**
 * Chips in a sent message: that they survive the send, that they are recognised by the same rules the
 * composer paints by, and that drawing them changes nothing about what the record says.
 */
describe("chips in the user message bubble", () => {
  it("draws a mentioned skill as a chip", async () => {
    await mount("use @mac to list reminders");
    expect(chips()).toEqual([["mention", "@mac"]]);
  });

  it("draws a picked element as a chip, labelled by what it is", async () => {
    await mount('make @[button "Sign in"] blue');
    expect(chips()).toEqual([["element", 'button "Sign in"']]);
  });

  it("draws both kinds in one message, in the order they were typed", async () => {
    await mount('@mac look at @[button "Go"]');
    expect(chips()).toEqual([["mention", "@mac"], ["element", 'button "Go"']]);
  });

  it("a mention chip shows the characters that were sent, sigil and all", async () => {
    await mount("use @mac on it");
    expect(bubble().textContent).toBe("use @mac on it");
  });

  it("an element chip drops only its delimiters, and keeps the whole token on the title", async () => {
    await mount('make @[button "Sign in"] blue');
    const chip = bubble().querySelector(".msg-chip")!;
    expect(chip.textContent).toBe('button "Sign in"');
    expect(chip.getAttribute("title")).toBe('@[button "Sign in"]');
    // The prose around it is untouched — a chip is drawn over the text, never in place of it.
    expect(bubble().textContent).toBe('make button "Sign in" blue');
  });

  it("an email is not a mention, here as in the composer", async () => {
    await mount("write to carlton@mac about it");
    expect(chips()).toEqual([]);
    expect(bubble().textContent).toBe("write to carlton@mac about it");
  });

  it("a skill switched off is not a chip — the composer does not paint it either", async () => {
    await mount("try @web instead");
    expect(chips()).toEqual([]);
    expect(bubble().textContent).toBe("try @web instead");
  });

  it("a skill that no longer exists goes back to being the text the user typed", async () => {
    await mount("use @mac now", { skills: [] });
    expect(chips()).toEqual([]);
    expect(bubble().textContent).toBe("use @mac now");
  });

  it("nothing chips in a session Realm cannot inject skills into — its @ never meant anything", async () => {
    await mount("use @mac now", { agentKind: "acp:cursor" });
    expect(chips()).toEqual([]);
  });

  it("an element chip still draws where a skill library never loads — it depends on no library", async () => {
    await mount('@[div#hero]', { agentKind: "acp:cursor" });
    expect(chips()).toEqual([["element", "div#hero"]]);
  });

  it("keeps the message's own newlines around the chips", async () => {
    await mount("first\n@mac\nlast");
    expect(bubble().textContent).toBe("first\n@mac\nlast");
  });
});
