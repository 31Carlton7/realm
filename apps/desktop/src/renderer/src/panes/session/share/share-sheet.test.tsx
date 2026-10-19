import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { sessionEvent, type DelegatedChild, type SessionEvent, type StoredSessionEvent } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../../state/store";
import { fakeApi, item, session } from "../../../state/store.test-fakes";
import { useSessionMenuItems } from "../SessionPane";
import { ShareSheet } from "./ShareSheet";

const PNG = `data:image/png;base64,${"A".repeat(40_000)}`;
const CHILD = "01JB0000000000000000000001";

/** A log with a prompt, an answer that names a relative picture, an allowed Bash, a question, and a
 *  delegation — long enough to need three pages from the server. */
function log(): StoredSessionEvent[] {
  const events: SessionEvent[] = [
    sessionEvent("user_message", { text: "Make it stream", attachments: [{ path: "/Users/bob/shot.png", mime: "image/png" }] }, 1),
    sessionEvent("thinking", { messageId: "t", text: "Hmm." }, 2),
    sessionEvent("assistant_text", { messageId: "a", text: "Here it is: ![chart](out/chart.png)" }, 3),
    sessionEvent("tool_call", { toolUseId: "b1", name: "Bash", input: { command: "pnpm test" }, parentToolUseId: null }, 4),
    sessionEvent("permission_request", { requestId: "r1", toolName: "Bash", input: { command: "pnpm test" }, title: "Allow Bash?", suggestions: [] }, 5),
    sessionEvent("permission_response", { requestId: "r1", decision: "allow_always" }, 6),
    sessionEvent("tool_result", { toolUseId: "b1", content: "ok", isError: false }, 7),
    sessionEvent("tool_call", { toolUseId: "q1", name: "AskUserQuestion", input: { questions: [{ question: "Which?", header: "x", multiSelect: false, options: [{ label: "A" }, { label: "B" }] }] }, parentToolUseId: null }, 8),
    sessionEvent("permission_request", { requestId: "r2", toolName: "AskUserQuestion", input: { questions: [{ question: "Which?", header: "x", multiSelect: false, options: [{ label: "A" }, { label: "B" }] }] }, title: "Question", suggestions: [] }, 9),
    sessionEvent("permission_response", { requestId: "r2", decision: "allow", answers: { "Which?": "A" } }, 10),
    sessionEvent("tool_call", { toolUseId: "d1", name: "mcp__realm__realm-agent__agent_start", input: { goal: "Update the README" }, parentToolUseId: null }, 11),
    sessionEvent("tool_result", { toolUseId: "d1", content: `Started ${CHILD}`, isError: false }, 12),
  ];
  // Padding, so the whole log is more than two of the store's pages.
  for (let i = 0; i < 2100; i++) events.push(sessionEvent("usage", { costUsd: 0, inputTokens: 1, outputTokens: 1, numTurns: 1 }, 100 + i));
  events.push(sessionEvent("assistant_text", { messageId: "z", text: "The last word." }, 9000));
  return events.map((event, i) => ({ seq: i + 1, sessionId: "se1", event }));
}

const child: DelegatedChild = {
  session: session(CHILD, "s1", { agentKind: "codex", model: "gpt-6-luna", title: "README pass", cwd: "/Users/bob/w2" }),
  goal: "Update the README", startedAt: 0, settledAt: 1, outcome: null, report: null, activity: null,
};

async function seed() {
  const api = fakeApi({
    items: { s1: [item("i1", "s1", { kind: "session", refId: "se1", title: "Stream it" })] },
    sessions: [session("se1", "s1", { cwd: "/Users/bob/w" }), child.session],
    sessionEvents: {
      se1: log(),
      [CHILD]: [{ seq: 1, sessionId: CHILD, event: sessionEvent("assistant_text", { messageId: "c", text: "README updated." }, 1) }],
    },
    delegatedChildren: { se1: [child] },
  });
  const store = createAppStore(api);
  await store.getState().boot();
  return { api, store };
}

function bridge() {
  const realm = {
    saveText: vi.fn(async (_: { name: string; text: string }) => "/Users/bob/Downloads/Stream it 2026-10-19.html"),
    shareImage: vi.fn(async (path: string) => (path.endsWith(".png") ? PNG : null)),
    openAttachment: vi.fn(async () => {}),
    files: { resolve: vi.fn(async (path: string, base?: string) => `${base}/${path}`), reveal: vi.fn(async () => true) },
  };
  vi.stubGlobal("window", Object.assign(window, { realm: { ...(window as never as { realm?: object }).realm, ...realm } }));
  return realm;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("gathering a session to share", () => {
  it("reads the whole log, its decided prompts, its sub-agents and its pictures", async () => {
    const realm = bridge();
    const { api, store } = await seed();
    const shared = (await store.getState().gatherShare("se1"))!;
    // Three pages: the pane's paging never limits what is shared.
    expect(api.calls.filter((c) => c.startsWith("sessionEvents:se1:"))).toHaveLength(3);
    expect(shared.transcript.blocks.at(-1)).toMatchObject({ kind: "assistant", text: "The last word." });
    expect(shared.title).toBe("Stream it");
    expect(shared.space).toBe("Versed");
    expect(shared.agent).toBe("Fake agent · Fake");
    // The Bash prompt and its answer; the question is a card of its own, so it is not here twice.
    expect(shared.permissions).toEqual([expect.objectContaining({ requestId: "r1", toolName: "Bash", decision: "allow_always" })]);
    expect(shared.children.d1).toEqual([expect.objectContaining({ title: "README pass", agent: "Codex · gpt-6-luna" })]);
    expect(shared.children.d1![0]!.transcript.blocks).toEqual([expect.objectContaining({ kind: "assistant", text: "README updated." })]);
    // An attached picture by its path; a drawn one resolved against the session's folder first.
    expect(realm.files.resolve).toHaveBeenCalledWith("out/chart.png", "/Users/bob/w");
    expect(realm.shareImage.mock.calls.map((c) => c[0])).toEqual(["/Users/bob/shot.png", "/Users/bob/w/out/chart.png"]);
    expect(shared.images).toEqual({ "/Users/bob/shot.png": PNG, "out/chart.png": PNG });
  });
});

async function openSheet() {
  const realm = bridge();
  const { store } = await seed();
  store.getState().shareSession("se1");
  expect(store.getState().sheet).toEqual({ kind: "share-session", sessionId: "se1" });
  render(<StoreContext.Provider value={store}><ShareSheet sessionId="se1" /></StoreContext.Provider>);
  await screen.findByRole("switch", { name: "Tool details" });
  return { realm, store };
}

const size = () => document.querySelector(".share-sheet-status")?.textContent ?? "";

describe("the Share sheet", () => {
  it("offers a switch for each thing the session has, thinking off, and says how big the file is", async () => {
    await openSheet();
    expect(screen.getAllByRole("switch").map((s) => [s.getAttribute("aria-label"), (s as HTMLInputElement).checked])).toEqual([
      ["Tool details", true], ["Thinking", false], ["Pictures", true], ["Sub-agents", true], ["Hide file paths", true],
    ]);
    expect(size()).toMatch(/^\d+ KB$/);
  });

  it("rebuilds the page as a switch moves, so the size is the file's", async () => {
    await openSheet();
    const before = size();
    fireEvent.click(screen.getByRole("switch", { name: "Pictures" }));
    await waitFor(() => expect(size()).not.toBe(before));
  });

  it("saves one .html file through the save dialog, then offers to find it or open it", async () => {
    const { realm, store } = await openSheet();
    fireEvent.click(screen.getByRole("switch", { name: "Thinking" }));
    fireEvent.click(screen.getByRole("button", { name: "Save…" }));
    await screen.findByText(/^Saved /);
    const { name, text } = realm.saveText.mock.calls[0]![0];
    expect(name).toMatch(/^Stream it \d{4}-\d{2}-\d{2}\.html$/);
    expect(text).toMatch(/^<!doctype html>/);
    expect(text).toContain("Hmm.");
    expect(text).not.toContain("/Users/bob");
    fireEvent.click(screen.getByRole("button", { name: "Show in Finder" }));
    expect(realm.files.reveal).toHaveBeenCalledWith("/Users/bob/Downloads/Stream it 2026-10-19.html");
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(realm.openAttachment).toHaveBeenCalledWith("/Users/bob/Downloads/Stream it 2026-10-19.html");
    // A switch moved after saving puts Save back: the file on disk is not what the sheet now shows.
    fireEvent.click(screen.getByRole("switch", { name: "Tool details" }));
    expect(screen.getByRole("button", { name: "Save…" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(store.getState().sheet).toBeNull();
  });

  it("stays put when the save dialog is cancelled", async () => {
    const { realm } = await openSheet();
    realm.saveText.mockResolvedValueOnce(null as never);
    fireEvent.click(screen.getByRole("button", { name: "Save…" }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText(/^Saved /)).toBeNull();
    expect(screen.getByRole("button", { name: "Save…" })).toBeEnabled();
  });
});

describe("where Share lives", () => {
  it("is a row of the session's ⋯ menu, beside Rename", async () => {
    const { store } = await seed();
    const wrapper = ({ children }: { children: ReactNode }) => <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
    const { result } = renderHook(() => useSessionMenuItems(store.getState().items.find((i) => i.refId === "se1")!, 10), { wrapper });
    const row = result.current.find((r) => "label" in r && r.label === "Share as web page…");
    expect(row).toBeDefined();
    act(() => { (row as { onSelect: () => void }).onSelect(); });
    expect(store.getState().sheet).toEqual({ kind: "share-session", sessionId: "se1" });
  });
});
