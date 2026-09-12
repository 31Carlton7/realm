import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { scriptCommandId, type Keybinding, type Script } from "@realm/contracts";

/** The panel's writes go through the store's `Api` (`saveScript`/`removeScript`/`reorderScripts`),
 *  so the FAKE API is the seam, not the socket — `api.savedScripts` carries what a form actually sent
 *  and `api.calls` carries the rest. The rpc mock below survives only so the module resolves. */
const calls: { method: string; params: any }[] = [];
vi.mock("../../rpc/client", () => ({
  rpc: () => ({
    on: () => () => {},
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "scripts.save") return { id: params.script.id ?? NEW_ID, ...params.script };
      if (method === "scripts.remove") return { ok: true };
      if (method === "scripts.reorder") return { scripts: [] };
      throw new Error(`unexpected ${method}`);
    },
  }),
}));

import { ScriptsPanel } from "./ScriptsPanel";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi } from "../../state/store.test-fakes";

const ID_A = `01HQ${"0".repeat(21)}A`;
const ID_B = `01HQ${"0".repeat(21)}B`;
const NEW_ID = `01HQ${"0".repeat(21)}C`;

const script = (id: string, over: Partial<Script> = {}): Script =>
  ({ id, name: id === ID_A ? "Tests" : "Dev server", command: id === ID_A ? "pnpm test" : "pnpm dev", cwd: null, ...over });

async function mount(opts: { scripts?: Record<string, Script[]>; rules?: Keybinding[]; spaceId?: string } = {}) {
  calls.length = 0;
  const api = fakeApi({ scripts: opts.scripts ?? { s1: [script(ID_A), script(ID_B)] } });
  const store = createAppStore(api);
  await store.getState().boot();
  if (opts.rules) store.getState().setKeybindings(opts.rules);
  render(<StoreContext.Provider value={store}><ScriptsPanel spaceId={opts.spaceId ?? "s1"} /></StoreContext.Provider>);
  return { api, store };
}

const rowFor = (name: string) => screen.getByText(name).closest(".settings-row") as HTMLElement;

describe("the scripts panel", () => {
  it("lists a space's scripts with the command each one runs", async () => {
    await mount();
    expect(await screen.findByText("Tests")).toBeInTheDocument();
    expect(within(rowFor("Tests")).getByText("pnpm test")).toBeInTheDocument();
    expect(within(rowFor("Dev server")).getByText("pnpm dev")).toBeInTheDocument();
  });

  it("shows the key currently bound to a script, and nothing at all for one nobody bound", async () => {
    /* THE MUTANT: render a placeholder — a dimmed "no key", a "Set a key…" — on the unbound row. Both
       are the same lie in different clothes: this panel cannot write keybindings.json, so the second
       is a door onto a wall and the first is a column of nothing pretending to be information. */
    await mount({ rules: [{ key: "mod+shift+t", command: scriptCommandId(ID_A) }] });
    await screen.findByText("Tests");
    expect(within(rowFor("Tests")).getByText("⌘⇧T")).toBeInTheDocument();
    expect(within(rowFor("Dev server")).queryByText(/key/i)).toBeNull();
    expect(screen.queryByText("⌘⇧D")).toBeNull();
  });

  it("does NOT advertise a chord a later rule has already taken", async () => {
    /* The reason the chord comes from `chordsForCommand` and not from a scan of the file for this
       command's name. THE MUTANT: `rules.filter(r => r.command === id).map(r => r.key)`. The row then
       prints ⌘⇧T for a script that keystroke does not run — a shortcut taught by the app, which is
       worse than no shortcut at all. */
    await mount({
      rules: [
        { key: "mod+shift+t", command: scriptCommandId(ID_A) },
        { key: "mod+shift+t", command: "terminal.new" },
      ],
    });
    await screen.findByText("Tests");
    expect(screen.queryByText("⌘⇧T")).toBeNull();
  });

  it("adds a script: the form's fields go out as one scripts.save, and the list is re-read", async () => {
    const { api } = await mount({ scripts: { s1: [] } });
    await screen.findByText(/No scripts yet/);
    fireEvent.click(screen.getByRole("button", { name: /Add script/ }));
    const sheet = screen.getByRole("dialog");
    fireEvent.change(within(sheet).getByLabelText("Script name"), { target: { value: "Tests" } });
    fireEvent.change(within(sheet).getByLabelText("Script command"), { target: { value: "pnpm test" } });
    fireEvent.change(within(sheet).getByLabelText("Script folder"), { target: { value: " apps/server " } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Add script" }));

    await waitFor(() => expect(api.savedScripts.length).toBe(1));
    expect(api.savedScripts[0]).toEqual({
      spaceId: "s1",
      script: { id: null, name: "Tests", command: "pnpm test", cwd: "apps/server" },
    });
    /* THE MUTANT: skip the refresh after the write. `spaceScripts` is what `ownsScriptCommand` reads
       SYNCHRONOUSLY when a keystroke arrives, so a script created and not folded back into the store
       is one whose key reaches the browser instead of running it. Nothing subscribes to
       `scripts.changed` in the renderer yet, so the panel cannot assume someone else will. */
    await waitFor(() => expect(api.calls.filter((c) => c === "listScripts:s1").length).toBe(2));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("refuses an invalid edit with the reason on screen, and sends nothing", async () => {
    /* THE MUTANT: let the RPC refuse it. The rejection surfaces as the app's generic error banner,
       which says a write failed and not which of three fields was wrong. */
    await mount({ scripts: { s1: [] } });
    await screen.findByText(/No scripts yet/);
    fireEvent.click(screen.getByRole("button", { name: /Add script/ }));
    const sheet = screen.getByRole("dialog");
    fireEvent.change(within(sheet).getByLabelText("Script command"), { target: { value: "pnpm test" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Add script" }));

    expect(await within(sheet).findByText("Give the script a name.")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "scripts.save")).toBe(false);
    expect(screen.getByRole("dialog")).toBeInTheDocument(); // still open, on the field that was wrong
  });

  it("editing sends the script's own id, so a rename cannot orphan the key bound to it", async () => {
    /* THE MUTANT: send `id: null` on an edit. The server creates a SECOND script, and the
       `script.<id>.run` rule someone wrote stays pointed at the original — a rename that silently
       breaks a shortcut, which is the exact failure `scriptCommandId` is built on a ULID to prevent. */
    const { api } = await mount({ rules: [{ key: "mod+shift+t", command: scriptCommandId(ID_A) }] });
    await screen.findByText("Tests");
    fireEvent.click(within(rowFor("Tests")).getByRole("button", { name: "More for Tests" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit…" }));
    const sheet = screen.getByRole("dialog");
    fireEvent.change(within(sheet).getByLabelText("Script name"), { target: { value: "Unit tests" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.savedScripts.length).toBe(1));
    expect(api.savedScripts[0]!.script).toEqual({
      id: ID_A, name: "Unit tests", command: "pnpm test", cwd: null,
    });
  });

  it("the editor shows the command id in full — the string a keybinding rule has to name", async () => {
    await mount();
    await screen.findByText("Tests");
    fireEvent.click(within(rowFor("Tests")).getByRole("button", { name: "More for Tests" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit…" }));
    expect(within(screen.getByRole("dialog")).getByText(scriptCommandId(ID_A))).toBeInTheDocument();
  });

  it("removing a BOUND script warns that the rule stays and the key stops doing anything", async () => {
    /* The whole reason this confirm exists. Realm does not edit keybindings.json — a rule naming a
       script id is indistinguishable from a rule naming ANOTHER space's script, which the keyboard
       layer deliberately supports — so the consequence is said instead, with the chord named, because
       "a keybinding" is not a thing a person can go and find and "⌘⇧T" is.
       THE MUTANT: remove silently. The rule survives, nothing says so, and the key quietly stops
       working with no event the user could attribute it to. */
    const { api } = await mount({ rules: [{ key: "mod+shift+t", command: scriptCommandId(ID_A) }] });
    await screen.findByText("Tests");
    fireEvent.click(within(rowFor("Tests")).getByRole("button", { name: "More for Tests" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove…" }));

    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByRole("alert")).toHaveTextContent(/⌘⇧T/);
    expect(within(sheet).getByRole("alert")).toHaveTextContent(/Realm will not edit that file, so the rule stays/);
    expect(calls.some((c) => c.method === "scripts.remove")).toBe(false);

    fireEvent.click(within(sheet).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(api.calls).toContain(`removeScript:s1:${ID_A}`));
  });

  it("removing an UNBOUND script says so rather than inventing a warning", async () => {
    await mount();
    await screen.findByText("Tests");
    fireEvent.click(within(rowFor("Tests")).getByRole("button", { name: "More for Tests" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove…" }));
    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByText("No key is bound to this script.")).toBeInTheDocument();
    expect(within(sheet).queryByRole("alert")).toBeNull();
  });

  it("reordering sends the whole order, and the ends refuse to move", async () => {
    const { api } = await mount();
    await screen.findByText("Tests");
    fireEvent.click(within(rowFor("Tests")).getByRole("button", { name: "More for Tests" }));
    // First row: up is dead, down is live. A clamp here would send a write that changes nothing and
    // read, from the user's side, as the control being broken.
    expect(screen.getByRole("menuitem", { name: "Move up" })).toBeDisabled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Move down" }));
    await waitFor(() => expect(api.calls).toContain(`reorderScripts:s1:${ID_B},${ID_A}`));
  });

  it("Run runs it, through the store, so the terminal it opens lands in the layout", async () => {
    const { api } = await mount();
    await screen.findByText("Tests");
    fireEvent.click(within(rowFor("Tests")).getByRole("button", { name: "Run Tests" }));
    await waitFor(() => expect(api.calls).toContain(`runScript:s1:${scriptCommandId(ID_A)}`));
    expect(screen.queryByRole("status")).toBeNull(); // the ordinary case says nothing
  });

  it("Run from a space you are not in says what happened instead of doing nothing", async () => {
    /* `runScriptCommand` runs in the ACTIVE space and answers false for anything else. THE MUTANT:
       ignore the answer. The button then reports success by saying nothing, and the user waits for a
       terminal that is never coming. Disabling the button instead would be the other wrong answer —
       the control is offered where its owner says it exists, and the owner only knows on press. */
    const { api } = await mount({ scripts: { s1: [], s2: [script(ID_A)] }, spaceId: "s2" });
    await screen.findByText("Tests");
    fireEvent.click(within(rowFor("Tests")).getByRole("button", { name: "Run Tests" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/Open Homework first/);
    expect(api.calls.some((c) => c.startsWith("runScript:"))).toBe(false);
  });

  it("with no scripts at all, says what a script is rather than showing an empty list", async () => {
    await mount({ scripts: { s1: [] } });
    expect(await screen.findByText(/A script is a command you run here often/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add script/ })).toBeInTheDocument();
  });
});
