import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FILES_OPEN_IN_KEY, type InstalledEditor } from "@realm/contracts";
import { PathMenu } from "./PathMenu";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, type FakeData } from "../../state/store.test-fakes";

const CURSOR: InstalledEditor = { id: "cursor", name: "Cursor" };
const ZED: InstalledEditor = { id: "zed", name: "Zed" };

async function menu(path: string, overrides: FakeData = {}) {
  const api = fakeApi(overrides);
  const store = createAppStore(api);
  await store.getState().boot();
  const anchor = document.createElement("span");
  document.body.appendChild(anchor);
  render(<StoreContext.Provider value={store}>
    <PathMenu path={path} anchorRef={{ current: anchor }} environmentId={null} onClose={() => {}} />
  </StoreContext.Provider>);
  return { api, store };
}

const items = () => screen.getAllByRole("menuitem").map((b) => b.textContent);

describe("the path menu's editor", () => {
  it("offers the first installed editor until someone chooses, and opens the path in it", async () => {
    const { api } = await menu("/repo/src/app.ts", { editors: [CURSOR, ZED] });
    expect(items()).toEqual(["Open app.ts", "Open in Cursor", "Reveal in Finder", "Copy path"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in Cursor" }));
    // THE label-only mutant: draw the item and send the path nowhere.
    await waitFor(() => expect(api.calls).toContain("openInEditor:cursor:/repo/src/app.ts"));
  });

  it("offers the editor the setting names, and none at all once it says Realm", async () => {
    await menu("/repo/src/app.ts", { editors: [CURSOR, ZED], settings: { [FILES_OPEN_IN_KEY]: "zed" } });
    expect(items()).toContain("Open in Zed");
    expect(items()).not.toContain("Open in Cursor");
  });

  it("offers nothing for an editor that is not installed — not the next one along", async () => {
    // The user chose Zed, not "any editor". THE fall-through mutant: offer Cursor instead.
    await menu("/repo/src/app.ts", { editors: [CURSOR], settings: { [FILES_OPEN_IN_KEY]: "zed" } });
    expect(items().some((t) => t?.startsWith("Open in"))).toBe(false);
  });

  it("says nothing about editors on a Mac that has none", async () => {
    await menu("/repo/src/app.ts", { editors: [] });
    expect(items()).toEqual(["Open app.ts", "Reveal in Finder", "Copy path"]);
  });

  it("opens a folder in the editor too, which is what an editor makes a workspace of", async () => {
    await menu("/repo/src/", { editors: [CURSOR] });
    expect(items()).toEqual(["Open in Cursor", "Reveal in Finder", "Copy path"]);
  });

  it("Realm hides the editor item even on a Mac that has one", async () => {
    await menu("/repo/src/app.ts", { editors: [CURSOR], settings: { [FILES_OPEN_IN_KEY]: "realm" } });
    expect(items()).toEqual(["Open app.ts", "Reveal in Finder", "Copy path"]);
  });
});
