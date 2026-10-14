import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi, type FakeData } from "../state/store.test-fakes";
import { NewWorktreeSheet } from "./NewWorktreeSheet";

const REPO = { "/tmp": { branch: "main", additions: 0, deletions: 0, dirty: 0, ahead: 0, behind: 0 } };

async function open(over: FakeData = {}) {
  const api = fakeApi({ gitInfo: REPO, branches: { s1: { branches: ["feat/x", "main"], current: "main" } }, ...over });
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().askNewWorktree("s1");
  render(<StoreContext.Provider value={store}><NewWorktreeSheet spaceId="s1" /></StoreContext.Provider>);
  return { api, store };
}

describe("NewWorktreeSheet", () => {
  it("starts from the branch the space folder has checked out, and says the branch it will make as the name is typed", async () => {
    await open();
    expect(screen.getByRole("combobox", { name: "Start from" })).toHaveValue("main");
    expect(screen.getByRole("textbox", { name: "Worktree name" })).toHaveFocus();
    expect(document.querySelector(".wt-derived")).toHaveTextContent("Makes branch realm/session from main.");
    fireEvent.change(screen.getByRole("textbox", { name: "Worktree name" }), { target: { value: "Fix the login flow" } });
    expect(document.querySelector(".wt-derived")).toHaveTextContent("Makes branch realm/fix-the-login-flow from main.");
  });

  it("creates it from the chosen branch and lands in a new session there, keyboard in its prompter", async () => {
    // THE MUTANTS: the base dropped on the way to the server; a worktree made but no session in it.
    const { api, store } = await open();
    fireEvent.change(screen.getByRole("textbox", { name: "Worktree name" }), { target: { value: "Try it" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Start from" }), { target: { value: "feat/x" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(store.getState().sheet).toBeNull());
    expect(api.calls).toContain("createWorktree:s1");
    expect(api.calls).toContain("createWorktreeFrom:feat/x");
    const made = api.data.environments.s1!.at(-1)!;
    expect(made.branch).toBe("realm/try-it");
    const session = Object.values(store.getState().sessions).find((x) => x.environmentId === made.id);
    expect(session).toBeDefined();
    expect(store.getState().keyboardFor?.sessionId).toBe(session!.id);
  });

  it("keeps the sheet and says why when git refuses", async () => {
    const api = fakeApi({ gitInfo: REPO, branches: { s1: { branches: ["main"], current: "main" } } });
    api.createWorktree = async () => { throw new Error("main is not a branch or commit in this repository"); };
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().askNewWorktree("s1");
    render(<StoreContext.Provider value={store}><NewWorktreeSheet spaceId="s1" /></StoreContext.Provider>);
    fireEvent.change(screen.getByRole("textbox", { name: "Worktree name" }), { target: { value: "x" } });
    fireEvent.submit(screen.getByRole("textbox", { name: "Worktree name" }).closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("The worktree wasn't created: main is not a branch or commit in this repository");
    expect(store.getState().sheet).toEqual({ kind: "new-worktree", spaceId: "s1" });
    expect(screen.getByRole("textbox", { name: "Worktree name" })).toHaveValue("x");
  });

  it("gives a plain folder the session it can have, without a sheet", async () => {
    const { api, store } = await open({ gitInfo: {} });
    expect(store.getState().sheet).toBeNull();
    expect(api.calls).not.toContain("listBranches:s1");
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("createSession:"))).toBe(true));
    expect(api.calls.some((c) => c.startsWith("createWorktree:"))).toBe(false);
  });
});
