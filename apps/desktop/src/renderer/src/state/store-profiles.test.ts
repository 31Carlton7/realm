import { describe, expect, it } from "vitest";
import { createAppStore } from "./store";
import { fakeApi, profile, space } from "./store.test-fakes";

/* Plan 27 Phase 2 — the store's profile actions, and a window opened for one profile. Defaults
   (fakeApi): profiles p1 "Work" / p2 "School"; spaces s1 "Versed" and s2 "Homework", both Work's. */
describe("store · profiles made real", () => {
  it("a window opened for a profile boots into THAT profile — its saved space if it is the profile's, else its first", async () => {
    /* THE mutant: ignore the window's profile and boot where the app was last left, and a Work window
       opened beside Personal shows Personal's spaces too. */
    const spaces = [space("s1", "p1", "Versed"), space("s2", "p2", "Homework"), space("s3", "p2", "Thesis")];
    const school = createAppStore(fakeApi({ spaces, boundProfileId: "p2", settings: { "ui.activeSpaceId": "s1" } }));
    await school.getState().boot();
    expect(school.getState().activeSpaceId).toBe("s2");
    const saved = createAppStore(fakeApi({ spaces, boundProfileId: "p2", settings: { "ui.activeSpaceId": "s3" } }));
    await saved.getState().boot();
    expect(saved.getState().activeSpaceId).toBe("s3");
    // The first window has no profile of its own and lands where the app was last left.
    const first = createAppStore(fakeApi({ spaces, settings: { "ui.activeSpaceId": "s3" } }));
    await first.getState().boot();
    expect(first.getState().activeSpaceId).toBe("s3");
  });

  it("a profile's own window never writes where the app was left — only the first window does", async () => {
    // THE MUTANT: drop the guard. A second window switched to School would then make the FIRST window
    // open in School on the next launch.
    const spaces = [space("s1", "p1", "Versed"), space("s2", "p2", "Homework"), space("s3", "p3", "Notes")];
    const profiles = [profile("p1", "Work"), profile("p2", "School"), profile("p3", "Clubs")];
    const api = fakeApi({ spaces, profiles, boundProfileId: "p2" });
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().selectProfile("p3");
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getState().activeProfileId).toBe("p3");
    expect(api.calls.filter((c) => c.startsWith("setSetting:ui.activeProfileId") || c.startsWith("setSetting:ui.activeSpaceId"))).toEqual([]);
    // The first window, bound to nothing, does write it.
    const first = fakeApi({ spaces, profiles });
    const main = createAppStore(first);
    await main.getState().boot();
    await main.getState().selectProfile("p3");
    await new Promise((r) => setTimeout(r, 0));
    expect(first.calls.some((c) => c.startsWith("setSetting:ui.activeProfileId") && c.includes("p3"))).toBe(true);
  });

  it("creates with a name alone or with an icon and colour, and merges the server's row", async () => {
    const api = fakeApi();
    const store = createAppStore(api);
    await store.getState().boot();
    const plain = await store.getState().createProfile("Side");
    expect(plain).toMatchObject({ name: "Side", icon: "user" });
    const styled = await store.getState().createProfile({ name: "Clients", icon: "briefcase", color: "#ff6b8b" });
    expect(styled).toMatchObject({ icon: "briefcase", color: "#ff6b8b" });
    expect(store.getState().profiles.map((p) => p.name)).toEqual(["Work", "School", "Side", "Clients"]);
  });

  it("rename and recolour go to the server and land on the row in place", async () => {
    const api = fakeApi();
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().renameProfile("p2", "Uni");
    await store.getState().recolourProfile("p2", "#3ddc97");
    expect(store.getState().profiles.map((p) => [p.id, p.name, p.color])).toEqual([["p1", "Work", "#000000"], ["p2", "Uni", "#3ddc97"]]);
    expect(api.calls).toContain(`updateProfile:p2:${JSON.stringify({ name: "Uni" })}`);
  });

  it("delete takes the profile and its spaces, and moves a window that was in one of them", async () => {
    const api = fakeApi({ spaces: [space("s1", "p1", "Versed"), space("s2", "p2", "Homework")], settings: { "ui.activeSpaceId": "s2" } });
    const store = createAppStore(api);
    await store.getState().boot();
    expect(store.getState().activeSpaceId).toBe("s2");
    await store.getState().deleteProfile("p2");
    expect(store.getState().profiles.map((p) => p.id)).toEqual(["p1"]);
    expect(store.getState().spaces.map((s) => s.id)).toEqual(["s1"]);
    expect(store.getState().activeSpaceId).toBe("s1");
  });

  it("switchProfile brings forward the window ALREADY showing a profile, and switches this one only when none does", async () => {
    /* THE mutant: switch this window regardless, and one profile ends up in two windows — each holding
       the same panes, each believing the views are its own. */
    const spaces = [space("s1", "p1", "Versed"), space("s2", "p2", "Homework")];
    const elsewhere = fakeApi({ spaces, profilesInOtherWindows: ["p2"] });
    const a = createAppStore(elsewhere);
    await a.getState().boot();
    await a.getState().switchProfile("p2");
    expect(elsewhere.calls).toContain("focusProfileWindow:p2");
    expect(a.getState().activeSpaceId).toBe("s1");
    const nowhere = fakeApi({ spaces });
    const b = createAppStore(nowhere);
    await b.getState().boot();
    await b.getState().switchProfile("p2");
    expect(b.getState().activeSpaceId).toBe("s2");
  });

});
