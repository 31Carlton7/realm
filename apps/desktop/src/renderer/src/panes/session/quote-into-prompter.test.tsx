import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { StoreContext, createAppStore } from "../../state/store";
import { sessionEvent } from "@realm/contracts";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { SessionPane } from "./SessionPane";
import { reduceAll } from "./transcript-model";

/**
 * Quote, end to end through the pane: the bar reads a selection in the transcript, the pane carries
 * it across, and the prompter takes it.
 *
 * The three files either side of this one each prove their own half — `selection-bar.test.ts` the
 * placement, `draft-format.test.ts` the markdown, `selection-bar.test.tsx` the bar's behaviour — and
 * none of them can catch the seam breaking, which is the thing a pulse passed between two siblings
 * actually gets wrong.
 *
 * The named mutants:
 *
 *   - the quote prop passed as a bare string → "the same passage quoted twice"
 *   - the effect keyed on the text as well   → "the same passage quoted twice"
 *   - the draft written without the pending selection → "focuses the prompter and parks the caret"
 */

const TEXT = "a clean restart would probably be";

async function mount() {
  const api = fakeApi({
    sessions: [session("se1", "s1", { status: "idle", agentKind: "claude" })],
    items: { s1: [item("i9", "s1", { kind: "session", refId: "se1", title: "s" })] },
  });
  const store = createAppStore(api);
  await store.getState().boot();
  store.setState({
    sessionStatus: { se1: "idle" },
    transcripts: { se1: { lastSeq: 2, t: reduceAll([
      sessionEvent("user_message", { text: "hi", attachments: [] }),
      sessionEvent("assistant_text", { messageId: "m1", text: TEXT }),
    ]) } },
  });
  render(
    <StoreContext.Provider value={store}>
      <SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "s" })} visible />
    </StoreContext.Provider>,
  );
  await waitFor(() => expect(screen.getByText(TEXT)).toBeInTheDocument());
  await act(async () => { await new Promise((res) => setTimeout(res, 1)); });
  return { store };
}

/** Select the rendered passage for real and fire the event the browser would.
 *
 *  Scoped to the transcript rather than found by text: once the passage has been quoted it is ALSO
 *  in the prompter's mirror layer, and a document-wide lookup would find two of it. */
function selectPassage() {
  const node = document.querySelector(".msg-assistant p")!;
  const range = document.createRange();
  range.selectNodeContents(node);
  const sel = document.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  fireEvent(document, new Event("selectionchange"));
}

const draftBox = () => screen.getByRole("textbox", { name: /message|prompt/i }) as HTMLTextAreaElement;

describe("quoting a passage into the prompter", () => {
  it("puts the selection in the draft as a blockquote", async () => {
    const { store } = await mount();
    selectPassage();
    fireEvent.click(screen.getByRole("button", { name: /Quote/ }));
    await waitFor(() => expect(store.getState().drafts.se1).toBe(`> ${TEXT}\n\n`));
  });

  it("focuses the prompter and parks the caret under the quote", async () => {
    // THE MUTANT: write the draft straight to the store and stop. The quote would land in a
    // prompter the reader still has to click into before they can type the question it is for.
    await mount();
    selectPassage();
    fireEvent.click(screen.getByRole("button", { name: /Quote/ }));
    await waitFor(() => {
      const ta = draftBox();
      expect(document.activeElement).toBe(ta);
      expect(ta.selectionStart).toBe(ta.value.length);
    });
  });

  it("the same passage quoted twice arrives twice", async () => {
    // THE MUTANT: pass the quote as a bare string. The second request is value-equal to the first,
    // React re-renders with an unchanged prop, and the effect never fires — so re-quoting the
    // sentence you just quoted silently does nothing.
    const { store } = await mount();
    selectPassage();
    fireEvent.click(screen.getByRole("button", { name: /Quote/ }));
    await waitFor(() => expect(store.getState().drafts.se1).toBe(`> ${TEXT}\n\n`));
    selectPassage();
    fireEvent.click(screen.getByRole("button", { name: /Quote/ }));
    await waitFor(() => expect(store.getState().drafts.se1).toBe(`> ${TEXT}\n\n> ${TEXT}\n\n`));
  });

  it("keeps what the reader had already typed, with the quote after it", async () => {
    const { store } = await mount();
    act(() => { store.getState().setDraft("se1", "why this?"); });
    selectPassage();
    fireEvent.click(screen.getByRole("button", { name: /Quote/ }));
    await waitFor(() => expect(store.getState().drafts.se1).toBe(`why this?\n\n> ${TEXT}\n\n`));
  });
});
