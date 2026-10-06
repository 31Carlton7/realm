import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NewProfileSheet } from "./NewProfileSheet";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, space } from "../../state/store.test-fakes";

async function mount(api = fakeApi()) {
  const store = createAppStore(api);
  await store.getState().boot();
  store.getState().openNewProfileSheet();
  const r = render(<StoreContext.Provider value={store}><NewProfileSheet /></StoreContext.Provider>);
  return { store, api, ...r };
}

describe("NewProfileSheet", () => {
  it("makes a profile with the name, icon and colour chosen — not the server's defaults", async () => {
    /* THE mutant: create from the name alone, as the New space sheet's inline add does, and every new
       profile is a grey person glyph nobody can tell from Personal in a switcher. */
    const { store, api } = await mount();
    fireEvent.change(screen.getByRole("textbox", { name: "Profile name" }), { target: { value: "  Clients  " } });
    fireEvent.click(screen.getByRole("radio", { name: "Icon briefcase" }));
    fireEvent.click(screen.getByRole("radio", { name: "Colour #ff6b8b" }));
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));
    await waitFor(() => expect(store.getState().profiles.map((p) => p.name)).toContain("Clients"));
    expect(api.data.profiles.find((p) => p.name === "Clients")).toMatchObject({ icon: "briefcase", color: "#ff6b8b" });
    // The sheet closes on create: the profile is the confirmation.
    expect(store.getState().sheet).toBeNull();
  });

  it("asks for a name before it will create anything", async () => {
    const { api } = await mount();
    const create = screen.getByRole("button", { name: "Create profile" });
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Profile name" }), { target: { value: "   " } });
    expect(create).toBeDisabled();
    fireEvent.submit(create.closest("form")!);
    expect(api.calls.some((c) => c.startsWith("createProfile"))).toBe(false);
  });

  it("starts on a colour the existing profiles have not taken", async () => {
    // Two profiles in the fake (Work, School) take the first two; the third is the default here.
    await mount();
    expect(screen.getByRole("radio", { name: "Colour #ffb454" })).toHaveAttribute("aria-checked", "true");
  });

  it("goes to the new profile once it is made", async () => {
    const api = fakeApi();
    const { store } = await mount(api);
    // The server names the profile; a space of it is there for the switch to land on.
    const make = api.createProfile;
    api.createProfile = async (input) => ({ ...(await make(input)), id: "pNew" });
    api.data.spaces.push(space("s9", "pNew", "Inbox"));
    await store.getState().refreshSpaces();
    fireEvent.change(screen.getByRole("textbox", { name: "Profile name" }), { target: { value: "Clients" } });
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s9"));
  });
});
