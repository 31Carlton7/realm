import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DEFAULT_KEYBINDINGS, scriptCommandId, type Keybinding, type KeybindingsFile } from "@realm/contracts";

/** The page reads `keybindings.get` and writes `keybindings.reset`, and holds no store state of its
 *  own for either — so the socket is the seam. */
const calls: { method: string; params: any }[] = [];
let file: KeybindingsFile = { path: "/realm-home/keybindings.json", rules: [], error: null };
let resetReply: KeybindingsFile | null = null;
vi.mock("../../rpc/client", () => ({
  rpc: () => ({
    on: () => () => {},
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "keybindings.get") return file;
      if (method === "keybindings.reset") return resetReply ?? file;
      throw new Error(`unexpected ${method}`);
    },
  }),
}));

import { KeybindingsPanel } from "./KeybindingsPanel";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi } from "../../state/store.test-fakes";

const SCRIPT_ID = `01HQ${"0".repeat(22)}`;

async function mount(over: Partial<KeybindingsFile> = {}) {
  calls.length = 0;
  resetReply = null;
  file = { path: "/realm-home/keybindings.json", rules: [...DEFAULT_KEYBINDINGS], error: null, ...over };
  const store = createAppStore(fakeApi());
  await store.getState().boot();
  render(<StoreContext.Provider value={store}><KeybindingsPanel /></StoreContext.Provider>);
  await screen.findByText("Command palette");
  return { store };
}

const rowFor = (label: string) => screen.getByText(label).closest(".settings-row") as HTMLElement;

afterEach(() => { delete (window as any).realm; });

describe("the keybindings panel", () => {
  it("lists every catalogued command with the chord that currently runs it", async () => {
    await mount();
    expect(within(rowFor("Command palette")).getByText("⌘K")).toBeInTheDocument();
    expect(within(rowFor("Split right")).getByText("⌘\\")).toBeInTheDocument();
    // A command Realm ships no chord for still gets a row: the page is the catalogue, and a command
    // you could bind and have not is a fact worth being able to find.
    expect(within(rowFor("Rename the focused pane")).getByText("Not bound.")).toBeInTheDocument();
  });

  it("a command whose rule fires only in a particular state says which, instead of reading as live", async () => {
    await mount();
    const row = rowFor("Add files to this session");
    expect(within(row).getByText("⌘U")).toBeInTheDocument();
    expect(row).toHaveTextContent("Only while");
    expect(row).toHaveTextContent("!overlayOpen && sessionFocus");
  });

  it("a defeated rule is marked as defeated, not left absent", async () => {
    /* The brief's rule and the page's reason for existing. THE MUTANT: render only the chords
       `chordsForCommand` returns. The overridden command then reads "Not bound", which sends the user
       to the file to check whether they saved a line that is sitting right there. */
    await mount({ rules: [
      { key: "mod+k", command: "palette.toggle" },
      { key: "mod+k", command: "terminal.new" },
    ] });
    const loser = rowFor("Command palette");
    expect(within(loser).queryByText("Not bound.")).toBeNull();
    expect(loser).toHaveTextContent("Taken by New terminal further down the file.");
    // Struck as well as said — and said as well as struck, because a strike-through is not announced.
    expect(within(loser).getByText("⌘K").tagName).toBe("S");
    // The winner is plain.
    expect(within(rowFor("New terminal")).getByText("⌘K").tagName).toBe("KBD");
  });

  it("two spellings of one chord collide — the file's own `Cmd+K` defeats Realm's `mod+k`", async () => {
    await mount({ rules: [
      { key: "mod+k", command: "palette.toggle" },
      { key: "Cmd+K", command: "terminal.new" },
    ] });
    expect(rowFor("Command palette")).toHaveTextContent("Taken by New terminal");
  });

  it("says loudly when the file could not be read, and that these are Realm's rules and not theirs", async () => {
    /* THE MUTANT: drop the banner. Every shortcut still works — the server answers with the shipped
       defaults — so nothing looks wrong, and the user's own rules are quietly not running. That is
       the one state this page exists for. */
    await mount({ error: "Unexpected token } in JSON at position 214", rules: [...DEFAULT_KEYBINDINGS] });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("could not use");
    expect(alert).toHaveTextContent("/realm-home/keybindings.json");
    expect(alert).toHaveTextContent("Your file has not been changed");
    // The parser's own sentence, verbatim: it is what locates the typo.
    expect(screen.getByText("Unexpected token } in JSON at position 214")).toBeInTheDocument();
  });

  it("says nothing about errors when there are none", async () => {
    await mount();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("searches by label and by both spellings of a chord", async () => {
    await mount();
    const field = screen.getByLabelText("Search shortcuts");
    fireEvent.change(field, { target: { value: "palette" } });
    expect(screen.getByText("Command palette")).toBeInTheDocument();
    expect(screen.queryByText("Split right")).toBeNull();
    fireEvent.change(field, { target: { value: "mod+\\" } });
    expect(screen.getByText("Split right")).toBeInTheDocument();
    expect(screen.queryByText("Command palette")).toBeNull();
    fireEvent.change(field, { target: { value: "zzzz" } });
    expect(screen.getByText("Nothing matches.")).toBeInTheDocument();
  });

  it("a rule naming a project script is listed rather than dropped on the floor", async () => {
    await mount({ rules: [{ key: "mod+shift+t", command: scriptCommandId(SCRIPT_ID) }] });
    expect(screen.getByText("Project scripts")).toBeInTheDocument();
    expect(screen.getByText(scriptCommandId(SCRIPT_ID))).toBeInTheDocument();
  });

  it("reveals the actual file, at the path the server reported", async () => {
    /* THE MUTANT: build the path from `KEYBINDINGS_FILE` and a guess at REALM_HOME. The server owns
       that path and a Realm on a moved home would open the wrong folder, or none. */
    const reveal = vi.fn();
    (window as any).realm = { files: { reveal } };
    await mount();
    fireEvent.click(screen.getByRole("button", { name: /Reveal in Finder/ }));
    expect(reveal).toHaveBeenCalledWith("/realm-home/keybindings.json");
  });

  it("Reset asks first, names what goes, and only then writes", async () => {
    /* THE MUTANT: reset on the first click. The thing discarded is every line the user ever wrote in
       that file — including the ones they may be part-way through fixing, since this page is where a
       broken keymap is reported. */
    await mount({ rules: [{ key: "mod+k", command: "terminal.new" }] });
    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    expect(calls.some((c) => c.method === "keybindings.reset")).toBe(false);
    expect(screen.getByRole("alert")).toHaveTextContent("there is no undo");

    resetReply = { path: "/realm-home/keybindings.json", rules: [...DEFAULT_KEYBINDINGS], error: null };
    fireEvent.click(screen.getByRole("button", { name: "Discard my rules" }));
    await waitFor(() => expect(calls.some((c) => c.method === "keybindings.reset")).toBe(true));
    // The page redraws from the answer the write gave it, rather than waiting for a broadcast.
    await waitFor(() => expect(within(rowFor("Command palette")).getByText("⌘K")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Discard my rules" })).toBeNull();
  });

  it("Cancel leaves the file alone", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(calls.some((c) => c.method === "keybindings.reset")).toBe(false);
    expect(screen.getByRole("button", { name: "Reset to defaults" })).toBeInTheDocument();
  });

  it("an unreadable key is reported as one — not as a working shortcut", async () => {
    await mount({ rules: [{ key: "ctrl+k ctrl+c", command: "palette.toggle" } as Keybinding] });
    const row = rowFor("Command palette");
    expect(within(row).getByText("ctrl+k ctrl+c")).toBeInTheDocument();
    expect(row).toHaveTextContent("Realm cannot read this key");
  });
});
