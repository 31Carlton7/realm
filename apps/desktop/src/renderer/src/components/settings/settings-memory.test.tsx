import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MEMORY_DOC_MAX, memorySupportNote, type MemorySources } from "@realm/contracts";
import { MemoryPanel } from "./MemoryPanel";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, agentsFileState, session, type FakeData } from "../../state/store.test-fakes";

async function mount(overrides: FakeData = {}) {
  const api = fakeApi({ memoryDocs: { s1: "remember the port map" }, ...overrides });
  const store = createAppStore(api);
  await store.getState().boot();
  render(<StoreContext.Provider value={store}><MemoryPanel spaceId="s1" /></StoreContext.Provider>);
  await screen.findByRole("textbox", { name: "Space memory document" });
  return { api, store };
}

describe("the memory document", () => {
  it("loads the space's document, shows where it lives, and saves an edit", async () => {
    const { api } = await mount();
    const doc = screen.getByRole("textbox", { name: "Space memory document" });
    expect(doc).toHaveValue("remember the port map");
    expect(screen.getByText("/realm-home/memory/s1.md")).toBeInTheDocument();
    fireEvent.change(doc, { target: { value: "new working agreement" } });
    fireEvent.click(screen.getByRole("button", { name: "Save memory" }));
    await waitFor(() => expect(api.data.memoryDocs.s1).toBe("new working agreement"));
  });

  it("surfaces the cap and refuses to send past it — no truncation, no silent trim", async () => {
    // The named mutant: an editor that sends (or trims to) the cap. Over it, the save is refused with
    // the overage named, and the text stays exactly as typed.
    const { api } = await mount();
    const doc = screen.getByRole("textbox", { name: "Space memory document" });
    expect(screen.getByText(new RegExp(`/ ${MEMORY_DOC_MAX.toLocaleString("en-US").replace(/,/g, ",")}`))).toBeInTheDocument();
    const over = "x".repeat(MEMORY_DOC_MAX + 7);
    fireEvent.change(doc, { target: { value: over } });
    expect(screen.getByText(/over the cap by 7 characters/)).toBeInTheDocument();
    expect(screen.getByText(/will not truncate/)).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save memory" });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(api.calls.some((c) => c.startsWith("setMemory"))).toBe(false);
    expect(doc).toHaveValue(over); // exactly as typed, all MEMORY_DOC_MAX + 7 characters
  });

  it("save stays disabled until the text actually changes", async () => {
    await mount();
    expect(screen.getByRole("button", { name: "Save memory" })).toBeDisabled();
  });
});

describe("the AGENTS.md opt-in", () => {
  it("offers the toggle where the space folder is Realm's, and writes through it", async () => {
    const { api } = await mount(); // fake default: a writable primary-folder state
    const sw = screen.getByRole("switch", { name: "Write AGENTS.md into the space folder" });
    expect(sw).not.toBeChecked();
    fireEvent.click(sw);
    await waitFor(() => expect(api.calls).toContain("setAgentsFile:s1=true"));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Write AGENTS.md into the space folder" })).toBeChecked());
  });

  it("never offers the toggle where the server would refuse — the reason shows instead", async () => {
    // The named mutant: offering the switch for a checkout/worktree-primary space. The server refuses
    // (AGENTS_FILE_NOT_REALM_FOLDER); the UI must not offer what will be refused.
    await mount({
      agentsFiles: { s1: agentsFileState({ writable: false, reason: "Realm did not create this directory, so it will not write an AGENTS.md into it" }) },
    });
    expect(screen.queryByRole("switch", { name: "Write AGENTS.md into the space folder" })).toBeNull();
    expect(screen.getByText(/Realm did not create this directory/)).toBeInTheDocument();
  });

  it("still offers the way OUT when a previously-managed file's folder turned foreign", async () => {
    // enabled + not writable (e.g. the user replaced the file): turning OFF is always safe, so the
    // toggle stays available rather than stranding the setting on.
    await mount({ agentsFiles: { s1: agentsFileState({ enabled: true, exists: true, managedByRealm: true, writable: false, reason: "an AGENTS.md Realm did not write is already in this folder; Realm will not overwrite it" }) } });
    expect(screen.getByRole("switch", { name: "Write AGENTS.md into the space folder" })).toBeChecked();
  });
});

const codexSources: MemorySources = {
  agent: "codex", channel: "developerInstructions", basis: "reported",
  note: memorySupportNote("codex"), realmMemoryInjected: true,
  sources: [
    { path: "/Users/x/repo/AGENTS.md", origin: "reported", exists: true, via: "cli" },
    { path: "/Users/x/gone/AGENTS.md", origin: "reported", exists: false, via: "cli" },
  ],
};
const cursorSources: MemorySources = {
  agent: "acp:cursor", channel: "none", basis: "none",
  note: memorySupportNote("acp:cursor"), realmMemoryInjected: false, sources: [],
};

describe("what each agent actually loads", () => {
  it("shows a Codex session's reported files, on the reported basis", async () => {
    await mount({
      sessions: [session("se1", "s1", { agentKind: "codex", title: "Codex session" })],
      memorySources: { se1: codexSources },
    });
    expect(await screen.findByText(/reports the exact instruction files it loaded/)).toBeInTheDocument();
    expect(screen.getByText("reported by the agent")).toBeInTheDocument();
    expect(screen.getByText("/Users/x/repo/AGENTS.md")).toBeInTheDocument();
    expect(screen.getByText(/This space's Realm memory travels into this session/)).toBeInTheDocument();
    // A reported file that no longer exists says so instead of claiming it loaded.
    const gone = screen.getByText("/Users/x/gone/AGENTS.md").closest(".settings-source-row") as HTMLElement;
    expect(gone.textContent).toContain("missing");
  });

  it("is honest about Cursor: nothing reaches this agent, stated, no fake rows", async () => {
    await mount({
      sessions: [session("se2", "s1", { agentKind: "acp:cursor", title: "Cursor session" })],
      memorySources: { se2: cursorSources },
    });
    expect(await screen.findByText(/Cursor takes no per-session context parameter, so neither Realm's memory nor any managed file reaches it/)).toBeInTheDocument();
  });

  it("falls back to the three per-agent honesty lines when the space has no sessions", async () => {
    await mount();
    expect(screen.getByText(memorySupportNote("acp:cursor"))).toBeInTheDocument();
    expect(screen.getByText(memorySupportNote("claude"))).toBeInTheDocument();
    expect(screen.getByText(memorySupportNote("codex"))).toBeInTheDocument();
    expect(screen.getByText(/Start a session to see the exact files/)).toBeInTheDocument();
  });

  it("switching the session picker fetches that session's own report", async () => {
    const { api } = await mount({
      sessions: [
        session("se1", "s1", { agentKind: "codex", title: "Codex session" }),
        session("se2", "s1", { agentKind: "acp:cursor", title: "Cursor session" }),
      ],
      memorySources: { se1: codexSources, se2: cursorSources },
    });
    await screen.findByText(/reports the exact instruction files/);
    fireEvent.change(screen.getByRole("combobox", { name: "Session" }), { target: { value: "se2" } });
    await waitFor(() => expect(api.calls).toContain("memorySources:se2"));
    expect(await screen.findByText(/Cursor takes no per-session context/)).toBeInTheDocument();
  });
});
