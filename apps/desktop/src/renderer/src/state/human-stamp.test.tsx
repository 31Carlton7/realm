import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { sessionEvent, type StoredSessionEvent } from "@realm/contracts";
import { QuickChat } from "../components/QuickChat";
import { SessionPane } from "../panes/session/SessionPane";
import { SessionPlanSheet } from "../panes/session/SessionSummary";
import { StoreContext, createAppStore } from "./store";
import { fakeApi, item, session } from "./store.test-fakes";

afterEach(() => cleanup());

/** The renderer's sources, found from wherever the suite was started. */
function rendererRoot(): string {
  const rel = "apps/desktop/src/renderer/src";
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) { const p = join(dir, rel); if (existsSync(p)) return p; dir = dirname(dir); }
  throw new Error(`cannot locate ${rel} from ${process.cwd()}`);
}

/** Every source file under `dir` that ships. It leaves the tests out and nothing else. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** The sources that hold `text` anywhere, a comment included, by their path under the renderer. */
function holding(text: string): string[] {
  const root = rendererRoot();
  return sourceFiles(root).filter((p) => readFileSync(p, "utf8").includes(text)).map((p) => relative(root, p)).sort();
}

const stored = (sessionId: string, seq: number, event: StoredSessionEvent["event"]): StoredSessionEvent => ({ seq, sessionId, event });
const sessionItem = item("i2", "s1", { kind: "session", refId: "se1", title: "Fake agent session" });

/** A booted store over one idle session, its transcript read from `rows`. */
async function booted(rows: StoredSessionEvent[] = []) {
  const api = fakeApi({ items: { s1: [sessionItem] }, sessions: [session("se1", "s1", { status: "idle" })], sessionEvents: { se1: rows } });
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().openSession("se1");
  return { api, store };
}

/**
 * The stamp (`sessions.send`'s `human`) says a person sent a message from a prompter as their own
 * input. Claude Code asks for it before it acts on a keyword in the text. The stamp is off unless a
 * call site says otherwise, so few places can set it. These tests count those places by reading the
 * sources. A later send that calls the stamped action, or writes the stamp out itself, fails here
 * until someone adds it to a list on purpose.
 */
describe("where the stamp can be written", () => {
  it("names the stamped send in the session prompter, in the quick chat and in the store that defines it, and in no other source", () => {
    expect(holding("sendTyped")).toEqual(["components/QuickChat.tsx", "panes/session/SessionPane.tsx", "state/store.ts"]);
  });

  it("writes the stamp out as a literal only where it enters a wire, in code review's question box and in the live API", () => {
    expect(holding("human: true")).toEqual(["panes/code-review/AskPrompter.tsx", "state/live-api.ts"]);
  });
});

/**
 * Every gesture that is a person sending their own words from a prompter. Code review's question box
 * is the one gesture these tests do not drive. It sends through the page's own call, and its test is
 * with the page's tests (`code-review-page.test.tsx`).
 */
describe("a person's own send", () => {
  it("goes from a session's prompter as their own input", async () => {
    const { api, store } = await booted();
    render(<StoreContext.Provider value={store}><SessionPane item={sessionItem} visible /></StoreContext.Provider>);
    const box = screen.getByRole("textbox", { name: /message/i });
    fireEvent.change(box, { target: { value: "ultracode review this" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(api.sent).toEqual([{ id: "se1", text: "ultracode review this", attachments: [], human: true }]));
  });

  it("goes from the quick chat as their own input", async () => {
    const api = fakeApi();
    const store = createAppStore(api);
    await store.getState().boot();
    render(<StoreContext.Provider value={store}><QuickChat /></StoreContext.Provider>);
    await act(async () => { await store.getState().openQuickChat(); });
    const box = within(await screen.findByRole("dialog", { name: "Quick chat" })).getByRole("textbox", { name: "Message" });
    fireEvent.change(box, { target: { value: "ultracode what changed today" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(api.sent).toHaveLength(1));
    expect(api.sent[0]).toEqual({ id: store.getState().quickChat!.sessionId, text: "ultracode what changed today", attachments: [], human: true });
  });

  it("goes to the session a dispatch starts as their own input", async () => {
    const { api, store } = await booted();
    store.getState().setDraft("se1", "ultracode fix the parser");
    await store.getState().dispatchDraft("se1");
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]!.id).not.toBe("se1");
    expect(api.sent[0]).toEqual({ id: api.sent[0]!.id, text: "ultracode fix the parser", attachments: [], human: true });
  });

  it("goes from the prompter under a viewed file as their own input", async () => {
    const { api, store } = await booted();
    store.getState().openViewer({ files: [{ path: "/work/hero.png" }], sessionId: "se1" });
    await store.getState().sendFromViewer("ultracode redraw this");
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]).toMatchObject({ id: "se1", text: "ultracode redraw this", human: true });
  });

  it("goes again as their own input when Retry sends a message that first went that way", async () => {
    const { api, store } = await booted([
      stored("se1", 1, sessionEvent("user_message", { text: "ultracode review this", attachments: [], human: true })),
      stored("se1", 2, sessionEvent("assistant_text", { messageId: "m1", text: "The workflow is running." })),
    ]);
    await store.getState().retryLastTurn("se1");
    expect(api.sent).toEqual([{ id: "se1", text: "ultracode review this", attachments: [], human: true }]);
  });

  it("carries through the stamped send everything the unstamped one carries, and the stamp is the only difference", async () => {
    const png = { path: "/x/a.png", mime: "image/png", name: "a.png", size: 1 };
    const sentBy = async (action: "sendMessage" | "sendTyped") => {
      const { api, store } = await booted();
      store.setState({ pendingAttachments: { se1: [png] } });
      await store.getState()[action]("se1", "look at this");
      return { sent: api.sent, left: store.getState().pendingAttachments.se1 };
    };
    const plain = await sentBy("sendMessage");
    const typed = await sentBy("sendTyped");
    expect(plain.sent).toEqual([{ id: "se1", text: "look at this", attachments: [{ path: "/x/a.png", mime: "image/png" }] }]);
    expect(typed.sent).toEqual([{ id: "se1", text: "look at this", attachments: [{ path: "/x/a.png", mime: "image/png" }], human: true }]);
    expect(plain.left).toEqual([]);
    expect(typed.left).toEqual([]);
  });
});

/**
 * What goes through the same wire unstamped. Each of these is text Realm wrote round an agent's
 * words or a person's, and each test puts the keyword in that text. If Realm stamped it, a plan's
 * title or a lecture's name could start a workflow of sub-agents in the person's name.
 */
describe("a send Realm writes", () => {
  it("is not the person's own input when the plan sheet's Implement sends it, whatever the plan is called", async () => {
    const { api, store } = await booted([stored("se1", 1, sessionEvent("plan", { planId: "p1", text: "# Ultracode rollout\n\nShip it in two steps." }))]);
    render(<StoreContext.Provider value={store}><SessionPlanSheet sessionId="se1" planId="p1" /></StoreContext.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Implement this plan" }));
    await waitFor(() => expect(api.sent).toEqual([{ id: "se1", text: "Implement this plan: Ultracode rollout", attachments: [] }]));
  });

  it("is not the person's own input when it is a lecture's wrap-up", async () => {
    const { api, store } = await booted();
    await store.getState().selectSpace("s1");
    await store.getState().openItem("i2");
    await store.getState().wrapUpLecture({ path: "lectures/2026-09-02-ultracode.md", title: "Ultracode", date: "2026-09-02", hasTranscript: true, sizeBytes: 10 });
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]!.text).toContain("`lectures/2026-09-02-ultracode.md`");
    expect(api.sent[0]).not.toHaveProperty("human");
  });

  it("is not the person's own input when it is the Agents tab's brief", async () => {
    const { api, store } = await booted();
    await store.getState().delegateWork("se1", "ultracode: build the dark-mode toggle with GPT-6 Luna.");
    expect(api.sent).toEqual([{ id: "se1", text: "ultracode: build the dark-mode toggle with GPT-6 Luna.", attachments: [] }]);
  });

  it("is not the person's own input when Retry sends a message that first went unstamped, whoever wrote it", async () => {
    const unstamped = [
      { text: "Implement this plan: Ultracode rollout", attachments: [] },
      { text: "Keep going on ultracode.", attachments: [], goal: "continuation" as const },
      { text: "ultracode triage the issues.", attachments: [], scheduled: { task: "Triage", note: "" } },
    ];
    for (const payload of unstamped) {
      const { api, store } = await booted([
        stored("se1", 1, sessionEvent("user_message", payload)),
        stored("se1", 2, sessionEvent("assistant_text", { messageId: "m1", text: "Done." })),
      ]);
      await store.getState().retryLastTurn("se1");
      expect(api.sent, payload.text).toEqual([{ id: "se1", text: payload.text, attachments: [] }]);
    }
  });
});
