import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NewSpaceSheet } from "./NewSpaceSheet";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi } from "../../state/store.test-fakes";

async function mount(api = fakeApi()) {
  const store = createAppStore(api);
  await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}><NewSpaceSheet /></StoreContext.Provider>);
  return { store, api, ...r };
}

describe("NewSpaceSheet", () => {
  it("with zero profiles: explains why Create is disabled instead of failing silently, and inline profile creation unlocks the flow", async () => {
    const { store } = await mount(fakeApi({ profiles: [], spaces: [], items: {} }));
    // The dead-end is explained, not silent (U-H1).
    expect(screen.getByText(/no profiles yet/i)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Space name" }), { target: { value: "Versed" } });
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    // The inline mini-field is already open in the zero-profile state.
    fireEvent.change(screen.getByRole("textbox", { name: "New profile name" }), { target: { value: "Personal" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(store.getState().profiles.map((p) => p.name)).toEqual(["Personal"]));
    expect(screen.queryByText(/no profiles yet/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(store.getState().spaces).toHaveLength(1));
    expect(store.getState().spaces[0]!.profileId).toBe(store.getState().profiles[0]!.id);
  });

  it("with existing profiles: 'New profile…' reveals the mini-field, creates the profile, and selects it", async () => {
    const { store, api } = await mount();
    expect(screen.queryByRole("textbox", { name: "New profile name" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New profile…" }));
    const input = screen.getByRole("textbox", { name: "New profile name" });
    fireEvent.change(input, { target: { value: "Side projects" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(store.getState().profiles.map((p) => p.name)).toContain("Side projects"));
    const created = store.getState().profiles.find((p) => p.name === "Side projects")!;
    expect((screen.getByRole("combobox", { name: "Profile" }) as HTMLSelectElement).value).toBe(created.id);
    // The mini-field folds back away after a successful add.
    expect(screen.queryByRole("textbox", { name: "New profile name" })).not.toBeInTheDocument();
    expect(api.calls).toContain("createProfile:Side projects");
  });

  it("creating a space uses the selected profile (regression: the sheet used to be a dead end with no createProfile caller)", async () => {
    const { store } = await mount();
    fireEvent.change(screen.getByRole("textbox", { name: "Space name" }), { target: { value: "Homework 2" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Profile" }), { target: { value: "p2" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(store.getState().spaces.some((s) => s.name === "Homework 2")).toBe(true));
    expect(store.getState().spaces.find((s) => s.name === "Homework 2")!.profileId).toBe("p2");
  });
});
