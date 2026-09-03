import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ImportScan } from "@realm/contracts";
import { ImportPanel } from "./ImportPanel";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, profile, space, type FakeData } from "../../state/store.test-fakes";

const session = (over: Partial<ImportScan["sessions"][number]> = {}): ImportScan["sessions"][number] => ({
  key: "/c/a.jsonl", source: "claude", agentKind: "claude", providerSessionId: "p1", path: "/c/a.jsonl",
  cwd: "/Users/me/proj", cwdExists: true, title: "A session", messages: 4, startedAt: 1, updatedAt: 1_780_000_000_000,
  fromRealm: false, scratch: false, imported: false, duplicate: false,
  match: { spaceId: "s1", fallbackProfileId: null, reason: "project", evidence: "project \"proj\"" },
  ...over,
});

const scanWith = (over: Partial<ImportScan> = {}): ImportScan => ({
  sessions: [], memories: [], skills: [],
  sources: [{ source: "claude", root: "/Users/me/.claude", available: true, sessions: 0, unreadable: 0, note: null }],
  ...over,
});

async function mount(overrides: FakeData = {}) {
  const api = fakeApi({
    profiles: [profile("p1", "Work"), profile("p2", "School", { sortOrder: 1 })],
    spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Realm")],
    ...overrides,
  });
  const store = createAppStore(api);
  await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}><ImportPanel /></StoreContext.Provider>);
  await waitFor(() => expect(api.calls).toContain("importScan"));
  return { store, api, ...r };
}

describe("the Import panel", () => {
  it("scans on mount and imports nothing until asked", async () => {
    const { api } = await mount({ importScan: scanWith({ sessions: [session()] }) });
    await screen.findByText("A session");
    expect(api.importApplied).toHaveLength(0);
  });

  it("says which sources it read and never claims to write to them", async () => {
    await mount({ importScan: scanWith() });
    expect(await screen.findByText("/Users/me/.claude")).toBeInTheDocument();
    expect(screen.getByText(/never writes to them/)).toBeInTheDocument();
  });

  it("hides Realm's own, scratch and already-imported rows BY DEFAULT but says how many it hid", async () => {
    await mount({
      importScan: scanWith({
        sessions: [
          session({ key: "/keep.jsonl", title: "Keep me" }),
          session({ key: "/realm.jsonl", title: "Realm's own", fromRealm: true }),
          session({ key: "/tmp.jsonl", title: "Scratch", scratch: true }),
          session({ key: "/done.jsonl", title: "Already there", imported: true }),
        ],
      }),
    });
    await screen.findByText("Keep me");
    expect(screen.queryByText("Realm's own")).not.toBeInTheDocument();
    expect(screen.queryByText("Scratch")).not.toBeInTheDocument();
    // The count is the honesty: a preview that dropped three of four rows in silence would be the
    // same lie as an import that did.
    expect(screen.getByText(/3 rows are hidden/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show them anyway" }));
    expect(screen.getByText("Realm's own")).toBeInTheDocument();
    expect(screen.getByText("Already there")).toBeInTheDocument();
  });

  it("sends the scan's proposed destination when the user changes nothing", async () => {
    const { api } = await mount({ importScan: scanWith({ sessions: [session()] }) });
    await screen.findByText("A session");
    fireEvent.click(screen.getByRole("button", { name: /^Import / }));
    await waitFor(() => expect(api.importApplied).toHaveLength(1));
    expect(api.importApplied[0]!.sessions).toEqual([{ key: "/c/a.jsonl", spaceId: "s1", profileId: null }]);
  });

  it("re-targeting a GROUP moves every session in it — the bulk correction the grouping exists for", async () => {
    const { api } = await mount({
      importScan: scanWith({
        sessions: [
          session({ key: "/a.jsonl", title: "One", match: { spaceId: null, fallbackProfileId: "p1", reason: "fallback", evidence: null } }),
          session({ key: "/b.jsonl", title: "Two", match: { spaceId: null, fallbackProfileId: "p1", reason: "fallback", evidence: null } }),
        ],
      }),
    });
    await screen.findByText("One");
    const group = screen.getByText("Work › Imported").closest("summary")!;
    fireEvent.change(within(group).getByRole("combobox"), { target: { value: "s:s2" } });

    fireEvent.click(screen.getByRole("button", { name: /^Import / }));
    await waitFor(() => expect(api.importApplied).toHaveLength(1));
    expect(api.importApplied[0]!.sessions).toEqual([
      { key: "/a.jsonl", spaceId: "s2", profileId: null },
      { key: "/b.jsonl", spaceId: "s2", profileId: null },
    ]);
  });

  it("a deselected row never reaches the wire", async () => {
    const { api } = await mount({
      importScan: scanWith({ sessions: [session({ key: "/a.jsonl", title: "One" }), session({ key: "/b.jsonl", title: "Two" })] }),
    });
    await screen.findByText("One");
    const row = screen.getByText("One").closest("li")!;
    fireEvent.click(within(row).getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /^Import / }));
    await waitFor(() => expect(api.importApplied).toHaveLength(1));
    expect(api.importApplied[0]!.sessions).toEqual([{ key: "/b.jsonl", spaceId: "s1", profileId: null }]);
  });

  it("names each session's fate: resumable, or an archive whose folder is gone", async () => {
    await mount({
      importScan: scanWith({
        sessions: [session({ key: "/a.jsonl", title: "Live one" }), session({ key: "/b.jsonl", title: "Dead one", cwdExists: false })],
      }),
    });
    const live = (await screen.findByText("Live one")).closest("li")!;
    const dead = screen.getByText("Dead one").closest("li")!;
    expect(within(live).getByText(/resumable/)).toBeInTheDocument();
    expect(within(dead).getByText(/archive \(folder is gone\)/)).toBeInTheDocument();
  });

  it("offers each profile's catch-all space explicitly, so choosing it is a decision", async () => {
    await mount({ importScan: scanWith({ sessions: [session()] }) });
    await screen.findByText("A session");
    const select = screen.getAllByRole("combobox")[0]!;
    expect(within(select).getAllByText("Imported (new)")).toHaveLength(2); // one per profile
    expect(within(select).getByText("No destination — skip")).toBeInTheDocument();
  });

  it("an already-imported skill is listed as such and cannot be selected", async () => {
    await mount({
      importScan: scanWith({
        skills: [
          { key: "helper", origins: ["claude"], path: "/c/skills/helper/SKILL.md", name: "helper", description: "helps", imported: false },
          { key: "done", origins: ["agents"], path: "/a/skills/done/SKILL.md", name: "done", description: "already here", imported: true },
        ],
      }),
    });
    await screen.findByText("helper");
    fireEvent.click(screen.getByRole("button", { name: "Show them anyway" }));
    const row = screen.getByText("done").closest("li")!;
    expect(within(row).getByRole("checkbox")).toBeDisabled();
    expect(within(row).getByText(/already in the library/)).toBeInTheDocument();
  });

  it("reports what actually happened, skips and failures included", async () => {
    const { api } = await mount({
      importScan: scanWith({ sessions: [session()] }),
      importResult: {
        sessions: [
          { key: "/a.jsonl", state: "imported", refId: "sess1", detail: "4 messages, resumable" },
          { key: "/b.jsonl", state: "failed", refId: null, detail: "space no longer exists" },
        ],
        memories: [], skills: [],
        spacesCreated: [{ id: "s3", profileId: "p1", name: "Imported" }],
      },
    });
    await screen.findByText("A session");
    fireEvent.click(screen.getByRole("button", { name: /^Import / }));
    await waitFor(() => expect(api.importApplied).toHaveLength(1));
    expect(await screen.findByText(/1 sessions imported, 1 failed/)).toBeInTheDocument();
    expect(screen.getByText("space no longer exists", { exact: false })).toBeInTheDocument();
  });

  it("disables Import when nothing is selected rather than sending an empty apply", async () => {
    await mount({ importScan: scanWith() });
    await waitFor(() => expect(screen.getByRole("button", { name: "Nothing selected" })).toBeDisabled());
  });
});
