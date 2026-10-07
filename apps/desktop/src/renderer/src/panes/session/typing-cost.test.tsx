import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { sessionEvent } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { reduceAll } from "./transcript-model";

/* Counts the transcript's renders without changing what it draws. */
const renders = vi.hoisted(() => ({ transcript: 0 }));
vi.mock("./Transcript", async (importOriginal) => {
  const real = await importOriginal<typeof import("./Transcript")>();
  return { ...real, Transcript: (props: Parameters<typeof real.Transcript>[0]) => { renders.transcript++; return real.Transcript(props); } };
});
const { SessionPane } = await import("./SessionPane");

afterEach(cleanup);

async function mount() {
  const api = fakeApi({ sessions: [session("se1", "s1", { status: "idle" })] });
  const store = createAppStore(api); await store.getState().boot();
  store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: 2, t: reduceAll([
    sessionEvent("user_message", { text: "hi", attachments: [] }),
    sessionEvent("assistant_text", { messageId: "m", text: "hello" }),
  ]) } } });
  render(<StoreContext.Provider value={store}><SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "s" })} visible /></StoreContext.Provider>);
  return store;
}

describe("typing in the composer", () => {
  it("does not re-render the transcript", async () => {
    /* It did, on every keystroke: the pane read the draft (so it re-rendered), and the draft's chip
       lists came back as new arrays even when nothing in them changed. On a session a few thousand
       turns long that was a 176ms median per character. THE mutants: read `drafts[id]` in the pane
       again, or let `setDraft` hand back fresh arrays. */
    await mount();
    const box = screen.getByRole("textbox", { name: /message/i });
    fireEvent.change(box, { target: { value: "a" } });
    const before = renders.transcript;
    for (const text of ["ab", "abc", "abcd", "abcde"]) fireEvent.change(box, { target: { value: text } });
    expect((box as HTMLTextAreaElement).value).toBe("abcde");
    expect(renders.transcript).toBe(before);
  });

  it("keeps the draft's chip lists as the same lists while an edit leaves them unchanged", async () => {
    const store = await mount();
    store.getState().setDraft("se1", "a");
    const s1 = store.getState();
    store.getState().setDraft("se1", "ab");
    const s2 = store.getState();
    expect(s2.draftMentions.se1).toBe(s1.draftMentions.se1);
    expect(s2.draftLinks.se1).toBe(s1.draftLinks.se1);
    expect(s2.draftRefs.se1).toBe(s1.draftRefs.se1);
    expect(s2.draftElements.se1).toBe(s1.draftElements.se1);
    expect(s2.drafts.se1).toBe("ab");
  });
});
