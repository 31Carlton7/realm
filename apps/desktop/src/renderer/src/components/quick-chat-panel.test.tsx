import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { sessionEvent } from "@realm/contracts";
import { reduceAll } from "../panes/session/transcript-model";
import { QuickChat } from "./QuickChat";
import { StoreContext, createAppStore, useAppStore } from "../state/store";
import { appCommands } from "../keys/commands";
import { fakeApi, space } from "../state/store.test-fakes";
import { MeetingAssistant } from "../meeting/assistant";
import { useAssistantPage } from "../meeting/MeetingAssistantView";
import { answerPill } from "./quick-chat-answer";

/** The quick chat as the panel's page draws it: `data-surface` and main's bridge are what make it
 *  the panel rather than a Realm window's card. */
function QuickChatKey() {
  const store = useAppStore();
  return <button type="button" onClick={() => appCommands(store)["session.quickChat"]!()}>Open quick chat</button>;
}

function assistantStub(): MeetingAssistant {
  return new MeetingAssistant({
    listen: () => ({ start: async () => {}, stop: async () => {} }),
    consent: { read: async () => true, accept: async () => {} },
    setListening: () => {},
    answers: { answer: async () => ({ answerId: "a1" }), cancel: async () => {}, prepare: async () => {}, stop: async () => {}, onEvent: () => () => {} },
    notes: { save: () => new Promise(() => {}), cancel: async () => {}, onProgress: () => () => {} },
    spaceId: () => "s1", openFile: () => {}, now: () => 0, newId: () => "m1", chords: { read: async () => null },
  });
}

function Page({ assistant, onNewChat }: { assistant: MeetingAssistant; onNewChat: () => void }) {
  useAssistantPage(assistant);
  return <><QuickChatKey /><QuickChat assistant={assistant} onNewChat={onNewChat} /></>;
}

async function mount() {
  const store = createAppStore(fakeApi({ spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Homework")] }));
  await store.getState().boot();
  const onNewChat = vi.fn();
  render(<StoreContext.Provider value={store}><Page assistant={assistantStub()} onNewChat={onNewChat} /></StoreContext.Provider>);
  fireEvent.click(screen.getByRole("button", { name: "Open quick chat" }));
  const dialog = await screen.findByRole("dialog", { name: "Quick chat" });
  const sessionId = store.getState().quickChat!.sessionId;
  const say = (events: ReturnType<typeof sessionEvent>[], status: "idle" | "running" | "waiting_permission" = "idle") =>
    store.setState({ transcripts: { [sessionId]: { lastSeq: events.length, t: reduceAll(events) } }, sessionStatus: { [sessionId]: status } });
  return { store, dialog, sessionId, onNewChat, say };
}

const asked = sessionEvent("user_message", { text: "how do I run the **suite**?", attachments: [] });
const answered = sessionEvent("assistant_text", { messageId: "m1", text: "Run `pnpm vitest run` from the root." });

beforeEach(() => {
  document.documentElement.dataset.surface = "quick-chat";
  (window as any).realm = { quickChatPanel: { fit: vi.fn(), shapes: vi.fn(), hide: vi.fn(), chatChanged: () => {} } };
});
afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.surface;
  delete (window as any).realm;
});

describe("the quick chat panel's one capsule", () => {
  it("holds the meeting assistant inside the bar, beside send, with no round button of its own", async () => {
    const { dialog } = await mount();
    const foot = dialog.querySelector(".quick-chat-foot")!;
    const bar = foot.querySelector(".composer")!;
    const mic = within(dialog).getByRole("button", { name: "Meeting assistant" });
    expect(bar.contains(mic)).toBe(true);
    expect(mic.nextElementSibling?.classList.contains("composer-send")).toBe(true);
    // Nothing in the foot stands beside the bar.
    expect([...foot.querySelectorAll("button")].every((b) => bar.contains(b))).toBe(true);
    expect(dialog.querySelector(".quick-chat-tools, .quick-chat-answer")).toBeNull();
  });
});

describe("the quick chat panel's grown state", () => {
  it("shows the answer as a pill over a toolbar: a done mark, the question as its title, the answer under it", async () => {
    const { dialog, say } = await mount();
    say([asked, answered]);
    const pill = await within(dialog).findByRole("button", { name: /how do I run the suite\?/ });
    expect(pill.dataset.state).toBe("done");
    expect(pill.querySelector(".quick-chat-answer-title")!.textContent).toBe("how do I run the suite?");
    expect(pill.querySelector(".quick-chat-answer-text")!.textContent).toBe("Run pnpm vitest run from the root.");
    expect(pill.querySelector(".quick-chat-answer-mark")).not.toBeNull();
    // The bar has turned into the toolbar, and the card is not drawn.
    const tools = within(dialog).getByRole("toolbar", { name: "Quick chat" });
    expect(within(tools).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["New chat", "Meeting assistant", "Show the whole chat"]);
    expect(dialog.querySelector(".quick-chat-foot .composer")).toBeNull();
    expect(dialog.dataset.expanded).toBeUndefined();
  });

  it("says Working while the turn runs", async () => {
    const { dialog, say } = await mount();
    say([asked], "running");
    await waitFor(() => expect(dialog.querySelector(".quick-chat-answer")).not.toBeNull());
    const pill = dialog.querySelector<HTMLElement>(".quick-chat-answer")!;
    expect(pill.dataset.state).toBe("working");
    expect(pill.querySelector(".quick-chat-answer-text")!.textContent).toBe("Working");
  });

  it("opens the whole chat on expand, with the prompter and Save to one click away, and folds back", async () => {
    const { dialog, say } = await mount();
    say([asked, answered]);
    fireEvent.click(await within(dialog).findByRole("button", { name: "Show the whole chat" }));
    expect(dialog.dataset.expanded).toBe("");
    expect(within(dialog).getByRole("button", { name: "Save to Versed" })).toBeInTheDocument();
    expect(dialog.querySelector(".quick-chat-foot .composer")).not.toBeNull();
    expect(dialog.querySelector(".quick-chat-answer, .quick-chat-tools")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Show the answer only" }));
    expect(dialog.dataset.expanded).toBeUndefined();
    expect(dialog.querySelector(".quick-chat-answer")).not.toBeNull();
  });

  it("also expands from a click on the answer itself", async () => {
    const { dialog, say } = await mount();
    say([asked, answered]);
    await waitFor(() => expect(dialog.querySelector(".quick-chat-answer")).not.toBeNull());
    fireEvent.click(dialog.querySelector<HTMLElement>(".quick-chat-answer")!);
    expect(dialog.dataset.expanded).toBe("");
  });

  it("takes a typed key as the start of the next question, in the prompter", async () => {
    const { dialog, say, store, sessionId } = await mount();
    say([asked, answered]);
    await waitFor(() => expect(dialog.querySelector(".quick-chat-answer")).not.toBeNull());
    fireEvent.keyDown(window, { key: "a" });
    expect(dialog.dataset.expanded).toBe("");
    expect(store.getState().drafts[sessionId]).toBe("a");
  });

  it("opens the card when the agent is waiting on an answer, which a pill cannot hold", async () => {
    const { dialog, say } = await mount();
    say([asked], "waiting_permission");
    await waitFor(() => expect(dialog.dataset.expanded).toBe(""));
    expect(dialog.querySelector(".quick-chat-answer")).toBeNull();
  });

  it("asks before New chat deletes an unsaved conversation, and offers to save it instead", async () => {
    const { dialog, say, onNewChat, store } = await mount();
    say([asked, answered]);
    fireEvent.click(await within(dialog).findByRole("button", { name: "New chat" }));
    expect(onNewChat).not.toHaveBeenCalled();
    const tools = within(dialog).getByRole("toolbar", { name: "Quick chat" });
    expect(within(tools).getByRole("button", { name: "Delete chat" })).toBeInTheDocument();
    fireEvent.click(within(tools).getByRole("button", { name: "Save to Versed" }));
    await waitFor(() => expect(onNewChat).toHaveBeenCalledTimes(1));
    expect(store.getState().quickChat?.keptIn).toBe("s1");
  });
});

describe("what the answer pill says", () => {
  it("is the last question and every reply after it, as plain words", () => {
    const pill = answerPill(reduceAll([asked, answered, sessionEvent("assistant_text", { messageId: "m2", text: "## Then\n- check CI" })]).blocks, false);
    expect(pill).toEqual({ title: "how do I run the suite?", answer: "Run pnpm vitest run from the root. Then check CI", state: "done" });
  });

  it("says what went wrong when the turn failed", () => {
    const pill = answerPill(reduceAll([asked, sessionEvent("error", { message: "The agent's CLI exited before it answered." })]).blocks, false);
    expect(pill).toMatchObject({ state: "failed", answer: "The agent's CLI exited before it answered." });
  });

  it("is nothing before a question", () => {
    expect(answerPill([], false)).toBeNull();
  });
});
