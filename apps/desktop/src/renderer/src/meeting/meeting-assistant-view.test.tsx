import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QuickChat } from "../components/QuickChat";
import { StoreContext, createAppStore, useAppStore } from "../state/store";
import { appCommands } from "../keys/commands";
import { fakeApi } from "../state/store.test-fakes";
import type { TranscriptEvents } from "../voice/transcript";
import { MeetingAssistant } from "./assistant";
import { TELL_THE_ROOM } from "./MeetingAssistantView";

function QuickChatKey() {
  const store = useAppStore();
  return <button type="button" onClick={() => appCommands(store)["session.quickChat"]!()}>Open quick chat</button>;
}

async function mount(opts: { consented?: boolean } = {}) {
  const store = createAppStore(fakeApi());
  await store.getState().boot();
  let events: TranscriptEvents | null = null;
  const marks: boolean[] = [];
  let consented = opts.consented ?? false;
  const assistant = new MeetingAssistant({
    listen: (e) => { events = e; return { start: async () => {}, stop: async () => { e.ended?.(); } }; },
    consent: { read: async () => consented, accept: async () => { consented = true; } },
    setListening: (on) => marks.push(on),
    summary: () => {},
    answers: null,
    now: () => 10_000,
  });
  render(
    <StoreContext.Provider value={store}>
      <QuickChatKey />
      <QuickChat assistant={assistant} />
    </StoreContext.Provider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open quick chat" }));
  const dialog = await screen.findByRole("dialog", { name: "Quick chat" });
  return { assistant, marks, dialog, events: () => events!, consented: () => consented };
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

  it("asks for the first-run sheet before it listens, with the four things it says", async () => {
    const r = await mount();
    showAssistant(r.dialog);
    await act(() => { fireEvent.click(within(r.dialog).getByRole("button", { name: "Start listening" })); });
    const sheet = await screen.findByRole("dialog", { name: "Before you start listening" });
    const text = sheet.textContent!;
    expect(text).toContain("Telling the people on the call is your job.");
    expect(text).toContain("California");
    expect(text).toContain("No audio is saved.");
    expect(text).toContain("only when you ask for an answer");
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
    expect(r.assistant.getState().questions.map((q) => q.question)).toEqual(["Who is the buyer?"]);
    fireEvent.click(within(r.dialog).getByLabelText("Context"));
    expect(box.placeholder).toBe("Tell the assistant what to keep in mind");
    fireEvent.change(box, { target: { value: "They want a pilot." } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(r.assistant.getState().customInfo).toEqual(["They want a pilot."]);
    expect(within(r.dialog).getByText("They want a pilot.")).toBeTruthy();
    expect(within(r.dialog).getByText("Live answers are not built yet.")).toBeTruthy();
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
