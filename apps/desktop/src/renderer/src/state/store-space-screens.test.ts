import { describe, expect, it } from "vitest";
import { itemIdOfLeaf } from "@realm/contracts";
import { createAppStore, PERSIST_DEBOUNCE_MS } from "./store";
import { parseSpaceScreens } from "./space-screens";
import { fakeApi, item, session, space, type FakeApi, type FakeData } from "./store.test-fakes";

/** Versed holds one session. Release holds the Release Captain's chat and a task session the
 *  captain started, which went on running — and so on getting newer — while nobody looked at it. */
const twoSpaces = (): FakeData => ({
  spaces: [space("s1", "p1", "Versed", { layout: { type: "leaf", id: "L1", itemId: "i1" } }), space("s2", "p1", "Release")],
  items: {
    s1: [item("i1", "s1", { kind: "session", refId: "se1", title: "Mine" })],
    s2: [item("cap", "s2", { kind: "session", refId: "se-cap", title: "Release Captain" }),
      item("task", "s2", { kind: "session", refId: "se-task", title: "Cut the build" })],
  },
  sessions: [session("se1", "s1", { activityAt: 1 }), session("se-cap", "s2", { activityAt: 2 }), session("se-task", "s2", { activityAt: 3 })],
});

const boot = async (api: FakeApi) => {
  const store = createAppStore(api);
  await store.getState().boot();
  return store;
};
type Store = Awaited<ReturnType<typeof boot>>;
const focused = (store: Store) => itemIdOfLeaf(store.getState().layout, store.getState().focusedLeafId);
/** The task session moving on its own, the way a turn's events move it. */
const taskRuns = (store: Store, at: number) =>
  store.setState({ sessionActivityAt: { ...store.getState().sessionActivityAt, "se-task": at } });
/** Long enough for the debounced writes to have landed — what a quit between them would have kept. */
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = () => new Promise((r) => setTimeout(r, PERSIST_DEBOUNCE_MS + 50));

/** In Release, on the captain's chat, then back to Versed. */
const leaveReleaseOnCaptain = async (store: Store) => {
  await store.getState().selectSpace("s2");
  await store.getState().openItem("cap");
  await store.getState().selectSpace("s1");
  expect(focused(store)).toBe("i1");
};

describe("going back to a space lands on the screen it was left on", () => {
  /* THE mutant: the old landing, the space's newest session. The task session moved while the person
     was in Versed, so it would open in place of the captain's chat. */
  it("the chat left open comes back, though another session of the space became newer meanwhile", async () => {
    const store = await boot(fakeApi(twoSpaces()));
    await leaveReleaseOnCaptain(store);
    taskRuns(store, 100);
    await store.getState().selectSpace("s2");
    expect(focused(store)).toBe("cap");
    expect(store.getState().activeSpaceId).toBe("s2");
    expect(store.getState().pageOverlay).toBeNull();
  });

  it("a page left up over a space comes back over it, with the space current", async () => {
    const store = await boot(fakeApi(twoSpaces()));
    await store.getState().selectSpace("s2");
    await store.getState().openItem("cap");
    store.getState().openSettingsPage();
    await store.getState().selectSpace("s1");
    expect(store.getState().pageOverlay).toBeNull();
    taskRuns(store, 100);
    await store.getState().selectSpace("s2");
    expect(store.getState().pageOverlay).toEqual({ kind: "settings-page", refId: expect.any(String), spaceId: "s2" });
    expect(store.getState().activeSpaceId).toBe("s2");
    // Behind it, the chat it was opened over.
    expect(focused(store)).toBe("cap");
  });

  /* THE mutant: recording every write as it lands. Opening a row puts the page away BEFORE it moves
     the focus, and that halfway state would be written down as Versed's screen. */
  it("leaving a page by opening another space's session keeps the page as where that space was left", async () => {
    const store = await boot(fakeApi(twoSpaces()));
    store.getState().openSettingsPage();
    await tick(); // a click of its own
    await store.getState().openItem("cap");
    expect(store.getState().activeSpaceId).toBe("s2");
    await store.getState().selectSpace("s1");
    expect(store.getState().pageOverlay?.kind).toBe("settings-page");
    expect(store.getState().pageOverlay?.spaceId).toBe("s1");
  });

  it("survives a relaunch", async () => {
    const api = fakeApi(twoSpaces());
    const before = await boot(api);
    await leaveReleaseOnCaptain(before);
    await settle();
    const after = await boot(api);
    expect(focused(after)).toBe("i1");
    taskRuns(after, 100);
    await after.getState().selectSpace("s2");
    expect(focused(after)).toBe("cap");
  });

  it("a page the window was closed on is up again after the relaunch", async () => {
    const api = fakeApi(twoSpaces());
    const before = await boot(api);
    await before.getState().selectSpace("s2");
    await before.getState().openItem("cap");
    before.getState().openSettingsPage();
    await settle();
    const after = await boot(api);
    expect(after.getState().pageOverlay).toMatchObject({ kind: "settings-page", spaceId: "s2" });
    expect(focused(after)).toBe("cap");
  });

  /* THE mutant: one memory for the profile, whatever the window. A window opened for Release and left
     on the task session would decide where the first window lands in Release. */
  it("each window keeps its own: a window opened for the space does not move the first window's", async () => {
    const api = fakeApi(twoSpaces());
    const first = await boot(api);
    await leaveReleaseOnCaptain(first);
    await settle();
    taskRuns(first, 100);
    const own = await boot({ ...api, boundSpaceId: () => "s2" });
    await own.getState().openItem("task");
    expect(focused(own)).toBe("task");
    await settle();
    const relaunched = await boot(api);
    await relaunched.getState().selectSpace("s2");
    expect(focused(relaunched)).toBe("cap");
  });
});

describe("when the session a space was left on is gone", () => {
  /* The fallback: the space's Overview, which lists what is there — never a guess at another session
     standing in for the one that went. THE mutant: falling through to the newest session. */
  it("archived: the space's Overview, not its newest session", async () => {
    const store = await boot(fakeApi(twoSpaces()));
    await leaveReleaseOnCaptain(store);
    await store.getState().archiveItem("cap", true);
    taskRuns(store, 100);
    await store.getState().selectSpace("s2");
    expect(store.getState().pageOverlay).toEqual({ kind: "space-page", refId: "s2", spaceId: "s2" });
    expect(store.getState().activeSpaceId).toBe("s2");
  });

  it("deleted: the space's Overview too", async () => {
    const store = await boot(fakeApi(twoSpaces()));
    await leaveReleaseOnCaptain(store);
    await store.getState().deleteItem("cap");
    await store.getState().selectSpace("s2");
    expect(store.getState().pageOverlay).toEqual({ kind: "space-page", refId: "s2", spaceId: "s2" });
  });

  it("a page that was up over it still comes back", async () => {
    const store = await boot(fakeApi(twoSpaces()));
    await store.getState().selectSpace("s2");
    await store.getState().openItem("cap");
    store.getState().openSettingsPage();
    await store.getState().selectSpace("s1");
    await store.getState().archiveItem("cap", true);
    await store.getState().selectSpace("s2");
    expect(store.getState().pageOverlay).toMatchObject({ kind: "settings-page", spaceId: "s2" });
    // Over Versed's session, still in the pane behind it — and it is Release the page is about.
    expect(focused(store)).toBe("i1");
    expect(store.getState().activeSpaceId).toBe("s2");
  });
});

describe("parseSpaceScreens", () => {
  it("keeps what this build can put back and drops the rest", () => {
    expect(parseSpaceScreens({
      s1: { itemId: "i1", page: null },
      s2: { itemId: null, page: { kind: "settings-page", refId: "r" } },
      s3: { itemId: 4, page: { kind: "no-such-page", refId: "r" } },
      s4: "junk",
    })).toEqual({
      s1: { itemId: "i1", page: null },
      s2: { itemId: null, page: { kind: "settings-page", refId: "r" } },
    });
    for (const junk of [null, "x", [], 3]) expect(parseSpaceScreens(junk)).toEqual({});
  });
});
