import { StrictMode, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QuickChat } from "../components/QuickChat";
import { StoreContext, createAppStore, useAppStore } from "../state/store";
import { appCommands } from "../keys/commands";
import { fakeApi } from "../state/store.test-fakes";
import type { LiveAnswerEvent, MeetingNotesProgress, SaveMeetingNotesResult } from "@realm/contracts";
import type { LiveAnswersApi } from "../voice/live-answers";
import type { TranscriptEvents } from "../voice/transcript";
import { MeetingAssistant } from "./assistant";
import { TELL_THE_ROOM, useAssistantPage } from "./MeetingAssistantView";

function QuickChatKey() {
  const store = useAppStore();
  return <button type="button" onClick={() => appCommands(store)["session.quickChat"]!()}>Open quick chat</button>;
}

/** What QuickChatPanelApp does with its assistant. */
function AssistantPage({ assistant, children }: { assistant: MeetingAssistant; children: ReactNode }) {
  useAssistantPage(assistant);
  return <>{children}</>;
}

async function mount(opts: { consented?: boolean; strict?: boolean } = {}) {
  const store = createAppStore(fakeApi());
  await store.getState().boot();
  let events: TranscriptEvents | null = null;
  const marks: boolean[] = [];
  const asked: Parameters<LiveAnswersApi["answer"]>[0][] = [];
  const opened: [string, string][] = [];
  const cancelled: string[] = [];
  let answerCb: ((e: LiveAnswerEvent) => void) | null = null;
  let progressCb: ((p: MeetingNotesProgress) => void) | null = null;
  let finishSave: ((r: SaveMeetingNotesResult) => void) | null = null;
  let consented = opts.consented ?? false;
  let answersStopped = 0;
  const assistant = new MeetingAssistant({
    listen: (e) => { events = e; return { start: async () => {}, stop: async () => { e.ended?.(); } }; },
    consent: { read: async () => consented, accept: async () => { consented = true; } },
    setListening: (on) => marks.push(on),
    answers: {
      answer: async (input) => { asked.push(input); return { answerId: "a1" }; },
      cancel: async () => {}, prepare: async () => {}, stop: async () => { answersStopped++; },
      onEvent: (cb) => { answerCb = cb; return () => { answerCb = null; }; },
    },
    notes: {
      save: () => new Promise((res) => { finishSave = res; }),
      cancel: async (id) => { cancelled.push(id); },
      onProgress: (cb) => { progressCb = cb; return () => { progressCb = null; }; },
    },
    spaceId: () => "space-1",
    openFile: (space, path) => opened.push([space, path]),
    now: () => 10_000,
    newId: () => "m1",
  });
  const page = (
    <StoreContext.Provider value={store}>
      <AssistantPage assistant={assistant}>
        <QuickChatKey />
        <QuickChat assistant={assistant} />
      </AssistantPage>
    </StoreContext.Provider>
  );
  render(opts.strict ? <StrictMode>{page}</StrictMode> : page);
  fireEvent.click(screen.getByRole("button", { name: "Open quick chat" }));
  const dialog = await screen.findByRole("dialog", { name: "Quick chat" });
  return {
    assistant, marks, dialog, asked, opened, cancelled, events: () => events!, consented: () => consented, answersStopped: () => answersStopped,
    answer: (e: LiveAnswerEvent) => act(() => answerCb!(e)),
    progress: (p: MeetingNotesProgress) => act(() => progressCb!(p)),
    finishSave: (r: SaveMeetingNotesResult) => finishSave!(r),
  };
}

const showAssistant = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole("button", { name: "Meeting assistant" }));

afterEach(() => cleanup());

describe("the meeting assistant in the quick chat panel", () => {
  it("is not in a Realm window's card, which carries no assistant", async () => {
    const store = createAppStore(fakeApi());
    await store.getState().boot();
    render(<StoreContext.Provider value={store}><QuickChatKey /><QuickChat /></StoreContext.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Open quick chat" }));
    const dialog = await screen.findByRole("dialog", { name: "Quick chat" });
    expect(within(dialog).queryByRole("button", { name: "Meeting assistant" })).toBeNull();
  });

  it("asks for the first-run sheet before it listens, with the six things it says", async () => {
    const r = await mount();
    showAssistant(r.dialog);
    await act(() => { fireEvent.click(within(r.dialog).getByRole("button", { name: "Start listening" })); });
    const sheet = await screen.findByRole("dialog", { name: "Before you start listening" });
    const text = sheet.textContent!;
    expect(text).toContain("Telling the people on the call is your job.");
    expect(text).toContain("California");
    expect(text).toContain("No audio is saved.");
    expect([...sheet.querySelectorAll(".meeting-consent li")].map((li) => li.textContent)).toEqual([
      "Telling the people on the call is your job. Tell the room puts a notice on your clipboard.",
      "In California, everyone on the call has to agree before it is recorded.",
      "Realm keeps the words only. No audio is saved.",
      "While it listens, each live answer sends the last three minutes of transcript and your custom info to Anthropic, through the Claude CLI on your own Claude account.",
      "When you stop, the summary sends the transcript, your questions and your custom info to the model chosen for quick chat. If that model runs through an agent other than Claude or Codex, that agent's app keeps its usual copy on the Mac.",
      "Nothing else leaves the Mac.",
    ]);
    expect(r.marks).toEqual([]);
    await act(() => { fireEvent.click(within(sheet).getByRole("button", { name: "Start listening" })); });
    expect(r.consented()).toBe(true);
    expect(r.marks).toEqual([true]);
    expect(screen.queryByRole("dialog", { name: "Before you start listening" })).toBeNull();
  });

  it("does not listen when the sheet is put away", async () => {
    const r = await mount();
    showAssistant(r.dialog);
    await act(() => { fireEvent.click(within(r.dialog).getByRole("button", { name: "Start listening" })); });
    const sheet = await screen.findByRole("dialog", { name: "Before you start listening" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Not now" }));
    expect(r.marks).toEqual([]);
    expect(r.consented()).toBe(false);
  });

  it("draws Me and Them lines, and the red mark in the bar in both views while it listens", async () => {
    const r = await mount({ consented: true });
    showAssistant(r.dialog);
    await act(() => r.assistant.start());
    act(() => {
      r.events().line({ source: "them", text: "What does it cost?", start: 0, end: 900, at: 12_000 });
      r.events().line({ source: "me", text: "It is free.", start: 1_000, end: 1_800, at: 14_000 });
    });
    const lines = within(r.dialog).getByRole("list", { name: "Transcript" });
    expect([...lines.querySelectorAll(".meeting-line")].map((l) => l.textContent)).toEqual(["ThemWhat does it cost?0:02", "MeIt is free.0:04"]);
    const bar = r.dialog.querySelector(".quick-chat-bar")!;
    expect(within(bar as HTMLElement).getByRole("status").textContent).toBe("Listening");
    // Back to the chat: the run goes on, and so does the mark.
    showAssistant(r.dialog);
    expect(within(bar as HTMLElement).getByRole("status").textContent).toBe("Listening");
  });

  it("stops by hand, takes the mark down and keeps the words on screen", async () => {
    const r = await mount({ consented: true });
    showAssistant(r.dialog);
    await act(() => r.assistant.start());
    act(() => r.events().line({ source: "them", text: "Thanks.", start: 0, end: 500, at: 11_000 }));
    await act(() => { fireEvent.click(within(r.dialog).getByRole("button", { name: "Stop" })); });
    expect(r.marks).toEqual([true, false]);
    expect(r.dialog.querySelector(".meeting-mark")).toBeNull();
    expect(within(r.dialog).getByText("Thanks.")).toBeTruthy();
    expect(within(r.dialog).getByRole("button", { name: "Start again" })).toBeTruthy();
  });

  it("sends the prompter's words as a question or as context, by the switch over it", async () => {
    const r = await mount({ consented: true });
    showAssistant(r.dialog);
    const box = within(r.dialog).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    expect(box.placeholder).toBe("Ask about the call");
    fireEvent.change(box, { target: { value: "Who is the buyer?" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(r.asked.map((a) => a.trigger)).toEqual(["key"]);
    expect(within(r.dialog).getByText("Who is the buyer?").className).toBe("meeting-asked");
    fireEvent.click(within(r.dialog).getByLabelText("Context"));
    expect(box.placeholder).toBe("Tell the assistant what to keep in mind");
    fireEvent.change(box, { target: { value: "They want a pilot." } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(r.assistant.getState().customInfo).toEqual(["They want a pilot."]);
    expect(within(r.dialog).getByText("They want a pilot.")).toBeTruthy();
  });

  it("draws the live answer as it streams, and the × dismisses it", async () => {
    const r = await mount({ consented: true });
    showAssistant(r.dialog);
    await act(() => r.assistant.start());
    r.answer({ answerId: "a1", t: "start", trigger: "key", model: null });
    const card = within(r.dialog).getByRole("region", { name: "Live answer" });
    expect(card.textContent).toBe("Answering…");
    r.answer({ answerId: "a1", t: "delta", text: "Scripted answer: " });
    r.answer({ answerId: "a1", t: "delta", text: "twelve seats" });
    expect(card.querySelector(".meeting-answer-text")!.textContent).toBe("Scripted answer: twelve seats");
    expect(card.querySelector("[aria-busy='true']")).not.toBeNull();
    r.answer({ answerId: "a1", t: "done", text: "Scripted answer: twelve seats to start." });
    expect(card.querySelector(".meeting-answer-text")!.textContent).toBe("Scripted answer: twelve seats to start.");
    expect(card.querySelector("[aria-busy='true']")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Dismiss the answer" }));
    expect(within(r.dialog).queryByRole("region", { name: "Live answer" })).toBeNull();
  });

  it("says the sentence a failed answer came back with", async () => {
    const r = await mount({ consented: true });
    showAssistant(r.dialog);
    await act(() => r.assistant.start());
    r.answer({ answerId: "a9", t: "error", message: "Live answers run on Claude only." });
    expect(within(r.dialog).getByRole("alert").textContent).toBe("Live answers run on Claude only.");
  });

  it("names the notes file as soon as it is on disk, offers the summary's cancel, and opens the file", async () => {
    const r = await mount({ consented: true });
    showAssistant(r.dialog);
    await act(() => r.assistant.start());
    act(() => r.events().line({ source: "them", text: "Thanks.", start: 0, end: 500, at: 11_000 }));
    act(() => { fireEvent.click(within(r.dialog).getByRole("button", { name: "Stop" })); });
    await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
    expect(r.dialog.querySelector(".meeting-notes")!.textContent).toBe("Saving the notes…");
    const path = "meetings/2026-11-20 1405 Meeting.md";
    r.progress({ meetingId: "m1", spaceId: "space-1", path, stage: "summarising" });
    expect(r.dialog.querySelector(".meeting-notes > span")!.textContent).toBe("Writing the summary…");
    expect(within(r.dialog).getByRole("button", { name: path })).toBeTruthy();
    fireEvent.click(within(r.dialog).getByRole("button", { name: "Cancel summary" }));
    expect(r.cancelled).toEqual(["m1"]);
    await act(async () => { r.finishSave({ path, summary: "cancelled" }); await Promise.resolve(); });
    expect(r.dialog.querySelector(".meeting-notes > span")!.textContent).toBe("Saved without a summary.");
    expect(within(r.dialog).queryByRole("button", { name: "Cancel summary" })).toBeNull();
    fireEvent.click(within(r.dialog).getByRole("button", { name: path }));
    expect(r.opened).toEqual([["space-1", path]]);
  });

  it("still hears the notes' progress after StrictMode's rehearsal, and ends nothing at mount", async () => {
    const r = await mount({ consented: true, strict: true });
    expect(r.answersStopped()).toBe(0);
    showAssistant(r.dialog);
    await act(() => r.assistant.start());
    act(() => r.events().line({ source: "them", text: "Thanks.", start: 0, end: 500, at: 11_000 }));
    act(() => { fireEvent.click(within(r.dialog).getByRole("button", { name: "Stop" })); });
    await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
    const path = "meetings/2026-11-20 1405 Meeting.md";
    r.progress({ meetingId: "m1", spaceId: "space-1", path, stage: "summarising" });
    expect(r.dialog.querySelector(".meeting-notes > span")!.textContent).toBe("Writing the summary…");
    expect(within(r.dialog).getByRole("button", { name: path })).toBeTruthy();
    expect(within(r.dialog).getByRole("button", { name: "Cancel summary" })).toBeTruthy();
  });

  it("ends the run when the page goes", async () => {
    const r = await mount({ consented: true });
    await act(() => r.assistant.start());
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    expect(r.marks).toEqual([true, false]);
    expect(r.answersStopped()).toBeGreaterThan(0);
  });

  it("says once the custom info passes 20,000 characters that every answer sends it, and still sends", async () => {
    const r = await mount({ consented: true });
    showAssistant(r.dialog);
    fireEvent.click(within(r.dialog).getByLabelText("Context"));
    const box = within(r.dialog).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "x".repeat(20_000) } });
    expect(r.dialog.querySelector(".meeting-long")).toBeNull();
    fireEvent.change(box, { target: { value: "x".repeat(20_001) } });
    expect(r.dialog.querySelector(".meeting-long")!.textContent).toBe("Every answer sends all 20,001 characters of custom info.");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(r.assistant.getState().customInfo).toEqual(["x".repeat(20_001)]);
    expect(r.dialog.querySelector(".meeting-long")!.textContent).toBe("Every answer sends all 20,001 characters of custom info.");
  });

  it("carries no + and no model picker under the assistant", async () => {
    const r = await mount({ consented: true });
    showAssistant(r.dialog);
    expect(r.dialog.querySelector(".composer-plus, [aria-label='Add files']")).toBeNull();
    expect(r.dialog.querySelector(".model-picker-chip, [aria-label^='Model']")).toBeNull();
  });

  it("puts the notice on the clipboard on Tell the room", async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    const r = await mount({ consented: true });
    showAssistant(r.dialog);
    await act(() => { fireEvent.click(within(r.dialog).getByRole("button", { name: "Tell the room" })); });
    expect(writeText).toHaveBeenCalledWith(TELL_THE_ROOM);
  });
});
