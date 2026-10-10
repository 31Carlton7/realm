import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { AgentSignIn } from "@realm/contracts";
import { Onboarding } from "./Onboarding";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi } from "../state/store.test-fakes";

/** A space-less sign-in for Codex that is asking for the code its page shows. */
const asking = (id: string, over: Partial<AgentSignIn> = {}): AgentSignIn => ({ id, kind: "codex", state: "code", url: null, detail: null, ...over });

/** The first run's page on an empty home, where a lead agent's card draws a sign-in's steps. */
async function firstRun() {
  const api = fakeApi({ spaces: [], items: {} });
  const store = createAppStore(api);
  await store.getState().boot();
  render(<StoreContext.Provider value={store}><Onboarding /></StoreContext.Provider>);
  return store;
}

const codeField = () => screen.getByRole("textbox", { name: "Code from Codex's sign-in page" });

describe("the code typed into a sign-in's steps on the first run's card", () => {
  it("is not left in the field for a sign-in that takes the place of the one it was typed for", async () => {
    const store = await firstRun();
    act(() => store.getState().applyAgentSignIn(asking("si-first")));
    fireEvent.change(codeField(), { target: { value: "ABCD-1234" } });
    act(() => store.getState().applyAgentSignIn(asking("si-next")));
    expect(codeField()).toHaveValue("");
  });

  it("stays in the field through a new report of the sign-in it was typed for", async () => {
    const store = await firstRun();
    act(() => store.getState().applyAgentSignIn(asking("si-first")));
    fireEvent.change(codeField(), { target: { value: "ABCD-1234" } });
    act(() => store.getState().applyAgentSignIn(asking("si-first", { url: "https://example.com/oauth/authorize" })));
    expect(codeField()).toHaveValue("ABCD-1234");
  });
});
