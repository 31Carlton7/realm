import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { TeamAccessMode, TeammatePermissionMode } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, profile, space, teammate } from "../../state/store.test-fakes";
import { TeammateSheet } from "../../panes/teammate/TeammateSheet";
import { Sidebar } from "./Sidebar";

/**
 * A space's Team access at the head of its Team list: the prompter's three rungs, Mixed once a
 * teammate is set on its own, and a control only the person may press.
 */

afterEach(cleanup);

const FULL_ACCESS_LINE = "Teammates run commands and edit files without asking. They still ask before deleting with rm, signing in, or using another app.";

/** Versed with cto and ops, over a stand-in for `teams.access.*` that answers as the server does. */
async function mount(modes: [TeammatePermissionMode, TeammatePermissionMode], spaceMode: TeamAccessMode | null = null) {
  const api = fakeApi({
    profiles: [profile("p1", "Work")],
    spaces: [space("s1", "p1", "Versed")],
    teammates: [teammate("cto", "s1", { name: "cto", permissionMode: modes[0] }), teammate("ops", "s1", { name: "ops", permissionMode: modes[1], sortOrder: 1 })],
  });
  const server = { mode: spaceMode };
  const list = api.teammates;
  const answer = async () => {
    const teammates = (await list("s1")).map((t) => ({ handle: t.handle, mode: t.permissionMode }));
    return { mode: server.mode, mixed: new Set([...teammates.map((t) => t.mode), ...(server.mode ? [server.mode] : [])]).size > 1, teammates };
  };
  const setAccess = api.setTeamAccess;
  api.teamAccess = async (spaceId) => { api.calls.push(`teamAccess:${spaceId}`); return answer(); };
  api.setTeamAccess = async (spaceId, mode) => { await setAccess(spaceId, mode); server.mode = mode; return answer(); };
  const store = createAppStore(api); await store.getState().boot();
  await act(() => store.getState().refreshTeammates());
  const r = render(<StoreContext.Provider value={store}><Sidebar /></StoreContext.Provider>);
  await waitFor(() => expect(api.calls).toContain("teamAccess:s1"));
  return { api, store, server, ...r };
}

const chip = () => screen.getByRole("button", { name: "Team access" });

describe("Team access in the sidebar", () => {
  it("heads the Team list and shows the team's mode in the prompter's words", async () => {
    // THE MUTANTS: the row outside the Team list; the mode drawn with a word of its own.
    await mount(["acceptEdits", "acceptEdits"], "acceptEdits");
    const team = screen.getByRole("group", { name: "Team" });
    expect(team.firstElementChild).toHaveClass("sb-team-access");
    await waitFor(() => expect(chip()).toHaveTextContent("Accept edits"));
    expect(within(team).getByText("Team access")).toBeInTheDocument();
  });

  it("says Mixed while the teammates differ", async () => {
    // THE MUTANT: the first teammate's mode shown over a mixed team.
    await mount(["default", "acceptEdits"]);
    await waitFor(() => expect(chip()).toHaveTextContent("Mixed"));
  });

  it("sets the whole team through teams.access.set", async () => {
    // THE MUTANT: a pick that never reaches the server, or sends another rung.
    const { api } = await mount(["default", "acceptEdits"]);
    await waitFor(() => expect(chip()).toHaveTextContent("Mixed"));
    fireEvent.click(chip());
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /Full access/ }));
    await waitFor(() => expect(api.calls).toContain("setTeamAccess:s1:bypassPermissions"));
    await waitFor(() => expect(chip()).toHaveTextContent("Full access"));
  });

  it("is a control no agent may press, its menu rows included", async () => {
    // THE MUTANT: data-no-agent dropped from the row or from the menu's rows.
    await mount(["default", "default"]);
    await waitFor(() => expect(chip()).toHaveTextContent("Ask each time"));
    expect(chip().closest("[data-no-agent]")).not.toBeNull();
    fireEvent.click(chip());
    const rows = await screen.findAllByRole("menuitemcheckbox");
    expect(rows.map((r) => r.textContent)).toEqual(["Ask each time", "Accept edits", "Full access"]);
    for (const row of rows) expect(row).toHaveAttribute("data-no-agent");
  });

  it("says what Full access still asks about under Full access, and nowhere else", async () => {
    // THE MUTANTS: the line under every mode; the line kept while the team is Mixed.
    const { store } = await mount(["acceptEdits", "acceptEdits"], "acceptEdits");
    await waitFor(() => expect(chip()).toHaveTextContent("Accept edits"));
    expect(screen.queryByText(FULL_ACCESS_LINE)).toBeNull();
    await act(() => store.getState().setTeamAccess("s1", "bypassPermissions"));
    expect(screen.getByText(FULL_ACCESS_LINE)).toBeInTheDocument();
    await act(() => store.getState().updateTeammate({ id: "ops", permissionMode: "default" }));
    await waitFor(() => expect(chip()).toHaveTextContent("Mixed"));
    expect(screen.queryByText(FULL_ACCESS_LINE)).toBeNull();
  });

  it("turns Mixed when one teammate is edited after the team was set", async () => {
    // THE MUTANT: the Edit sheet's change never reaching the held access.
    const { store, api } = await mount(["bypassPermissions", "bypassPermissions"], "bypassPermissions");
    await waitFor(() => expect(chip()).toHaveTextContent("Full access"));
    cleanup();
    render(<StoreContext.Provider value={store}><Sidebar /><TeammateSheet spaceId="s1" id="ops" /></StoreContext.Provider>);
    fireEvent.click(screen.getByRole("radio", { name: /Accept edits/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("teammateUpdate:ops:") && c.includes('"permissionMode":"acceptEdits"'))).toBe(true));
    await waitFor(() => expect(chip()).toHaveTextContent("Mixed"));
    expect(store.getState().teamAccess.s1?.mode).toBe("bypassPermissions");
  });

  it("follows teams.access.changed from another window", async () => {
    // THE MUTANT: the event handler that does not read the access again.
    const { store, server } = await mount(["default", "default"]);
    await waitFor(() => expect(chip()).toHaveTextContent("Ask each time"));
    const st = store.getState();
    for (const t of st.teammates.s1 ?? []) await st.updateTeammate({ id: t.id, permissionMode: "acceptEdits" });
    server.mode = "acceptEdits";
    await act(() => store.getState().teamAccessChanged("s1"));
    expect(chip()).toHaveTextContent("Accept edits");
  });
});

describe("the New teammate sheet under a Team access", () => {
  it("starts on the space's mode", async () => {
    // THE MUTANT: the sheet starting on the default permission whatever the space says.
    const { store, api } = await mount(["bypassPermissions", "bypassPermissions"], "bypassPermissions");
    cleanup();
    render(<StoreContext.Provider value={store}><TeammateSheet spaceId="s1" /></StoreContext.Provider>);
    await waitFor(() => expect(screen.getByRole("radio", { name: /Full access/ })).toBeChecked());
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("teammateCreate:") && c.includes('"permissionMode":"bypassPermissions"'))).toBe(true));
  });

  it("starts on the default permission while teammates are set one by one", async () => {
    const { store } = await mount(["acceptEdits", "acceptEdits"]);
    cleanup();
    render(<StoreContext.Provider value={store}><TeammateSheet spaceId="s1" /></StoreContext.Provider>);
    await waitFor(() => expect(screen.getByRole("radio", { name: /Ask each time/ })).toBeChecked());
  });
});
