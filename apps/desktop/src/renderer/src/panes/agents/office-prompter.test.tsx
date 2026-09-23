import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installOfficeAssets, furnitureVocabulary } from "@realm/pixel-office";
import { OfficePrompter, buildWorld, propsToDraw } from "./OfficePrompter";
import { createAppStore, StoreContext, type OfficeWorld } from "../../state/store";
import { fakeApi, item, space, type FakeApi } from "../../state/store.test-fakes";

afterEach(() => cleanup());
beforeAll(() => installOfficeAssets());

/** A room the model might plausibly answer with: 6×5, walled, one desk. */
const desk = () => furnitureVocabulary().flatMap((g) => g.ids).find((t) => t.includes("DESK")) ?? furnitureVocabulary()[0]!.ids[0]!;
const answer = (over: Record<string, unknown> = {}) => JSON.stringify({
  name: "Night shift",
  room: ["######", "#1111#", "#1111#", "#1111#", "######"],
  furniture: [{ type: desk(), col: 2, row: 2 }],
  theme: { name: "Night", floor: { h: 230, s: 30, b: -40, c: 10, colorize: true }, wall: { h: 230, s: 30, b: -55, c: 8, colorize: true } },
  ...over,
});

describe("buildWorld", () => {
  it("turns a model's answer into a world", () => {
    const built = buildWorld(answer(), "a night office");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.world.name).toBe("Night shift");
    const layout = built.world.layout as { cols: number; rows: number; tiles: number[]; tileColors: unknown[] };
    expect(layout.cols).toBe(6);
    expect(layout.rows).toBe(5);
    expect(layout.tiles).toHaveLength(30);
    // The theme was applied rather than merely accepted — a world that validates and then renders
    // unpainted is the failure this pins.
    expect(layout.tileColors).toHaveLength(30);
  });

  it("refuses a ragged room, which is the mistake this format exists to make visible", () => {
    const built = buildWorld(answer({ room: ["######", "#111#", "######"] }), "x");
    expect(built.ok).toBe(false);
    expect(!built.ok && built.problems.join(" ")).toMatch(/6 characters/);
  });

  it("refuses furniture the model invented, and names it", () => {
    /* The engine looks furniture up without checking, so this is the line between a hallucination
       and a blank pane. */
    const built = buildWorld(answer({ furniture: [{ type: "ESPRESSO_MACHINE", col: 1, row: 1 }] }), "x");
    expect(built.ok).toBe(false);
    expect(!built.ok && built.problems.join(" ")).toContain("ESPRESSO_MACHINE");
  });

  it("refuses a theme whose numbers are out of range", () => {
    const built = buildWorld(answer({ theme: { name: "n", floor: { h: 999, s: 0, b: 0, c: 0 }, wall: { h: 0, s: 0, b: 0, c: 0 } } }), "x");
    expect(built.ok).toBe(false);
    expect(!built.ok && built.problems.join(" ")).toMatch(/floor\.h/);
  });

  it("keeps a good floor plan when the model simply left the paint out", () => {
    /* A theme is optional. Throwing away a room the model got right because it skipped the palette
       would be the validator exceeding its brief. */
    const built = buildWorld(answer({ theme: undefined }), "x");
    expect(built.ok).toBe(true);
  });

  it("says so plainly when the answer is not JSON at all", () => {
    for (const junk of ["", "Sure! Here you go:", "{ nope"]) {
      const built = buildWorld(junk, "x");
      expect(built.ok, junk).toBe(false);
    }
  });

  it("falls back to the prompt when the model names nothing", () => {
    const built = buildWorld(answer({ name: "   " }), "a quiet library");
    expect(built.ok && built.world.name).toBe("a quiet library");
  });
});

describe("propsToDraw", () => {
  it("reads the props a model asked to have drawn for it", () => {
    const got = propsToDraw(JSON.stringify({ draw: [
      { id: "I95_SHIELD", label: "I-95 shield", prompt: "an interstate 95 highway shield" },
      { id: "CAPITOL", prompt: "a domed capitol building seen from above" },
    ] }));
    expect(got.map((p) => p.id)).toEqual(["I95_SHIELD", "CAPITOL"]);
    // A prop with no label is named by its id rather than dropped.
    expect(got[1]!.label).toBe("CAPITOL");
  });

  it("answers nothing for an answer with no props, and never throws on a malformed one", () => {
    for (const junk of ["{}", "not json", JSON.stringify({ draw: "a flag" }), JSON.stringify({ draw: [1, null] })]) {
      expect(propsToDraw(junk), junk).toEqual([]);
    }
  });

  it("drops an entry missing what a drawing needs rather than the whole batch", () => {
    /* One malformed prop costs the room one prop. The room is what was asked for. */
    const got = propsToDraw(JSON.stringify({ draw: [{ id: "A", prompt: "a flag" }, { id: "B" }] }));
    expect(got.map((p) => p.id)).toEqual(["A"]);
  });
});

describe("the office prompter", () => {
  async function mount(api: FakeApi, current: OfficeWorld | null = null) {
    api.data.items.s1 = [item("i1", "s1", { title: "One" })];
    const store = createAppStore(api); await store.getState().boot();
    render(<StoreContext.Provider value={store}><OfficePrompter current={current} seats={6} /></StoreContext.Provider>);
    return store;
  }
  const field = () => screen.getByLabelText("Describe the office");

  it("builds a world from a description and puts it on screen", async () => {
    const api = fakeApi({ spaces: [space("s1", "p1", "Versed")], pixelWorldJson: answer() });
    const store = await mount(api);
    fireEvent.change(field(), { target: { value: "a night office" } });
    fireEvent.click(screen.getByRole("button", { name: "Build it" }));
    await waitFor(() => expect(store.getState().officeWorld?.name).toBe("Night shift"));
    expect(api.calls).toContain("generatePixelWorld:a night office");
  });

  it("shows why a world was refused rather than doing nothing", async () => {
    /* "Nothing happened" is the one outcome a person cannot act on, and a model that invents
       furniture is the ordinary case rather than the strange one. */
    const api = fakeApi({ spaces: [space("s1", "p1", "Versed")], pixelWorldJson: answer({ furniture: [{ type: "LAVA_LAMP", col: 1, row: 1 }] }) });
    const store = await mount(api);
    fireEvent.change(field(), { target: { value: "make it cosy" } });
    fireEvent.click(screen.getByRole("button", { name: "Build it" }));
    await waitFor(() => expect(screen.getByLabelText("Why that office was refused")).toBeInTheDocument());
    expect(screen.getByLabelText("Why that office was refused")).toHaveTextContent("LAVA_LAMP");
    // …and the office on screen was left alone rather than replaced with a broken one.
    expect(store.getState().officeWorld).toBeNull();
  });

  it("will not ask on an empty description", async () => {
    const api = fakeApi({ spaces: [space("s1", "p1", "Versed")] });
    await mount(api);
    expect(screen.getByRole("button", { name: "Build it" })).toBeDisabled();
    fireEvent.change(field(), { target: { value: "  " } });
    expect(screen.getByRole("button", { name: "Build it" })).toBeDisabled();
  });

  it("repaints an existing world without rebuilding it — no model call, same room", async () => {
    /* The whole reason a theme is a separate object: repainting must not move anyone's chair, and
       must not cost a round trip to a model. */
    const api = fakeApi({ spaces: [space("s1", "p1", "Versed")], pixelWorldJson: answer() });
    const built = buildWorld(answer(), "x");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const store = await mount(api, built.world);
    const before = (built.world.layout as { tiles: number[] }).tiles;
    fireEvent.click(screen.getByRole("button", { name: "Terminal green" }));
    await waitFor(() => expect(store.getState().officeWorld?.layout).not.toBe(built.world.layout));
    const after = store.getState().officeWorld!.layout as { tiles: number[]; tileColors: { h: number }[] };
    expect(after.tiles).toEqual(before);
    expect(after.tileColors[7]!.h).toBe(140);
    expect(api.calls.some((c) => c.startsWith("generatePixelWorld"))).toBe(false);
  });

  it("draws the props the model asked for, and places them", async () => {
    /* The gap this closes: asked for a room "about the DC area", a model with only the generic
       catalog builds a generic office, because that is the only thing it can say. Now it can ask
       for a prop and then place it — so the prop must be REGISTERED before the world is checked,
       which is the ordering this pins. */
    const api = fakeApi({
      spaces: [space("s1", "p1", "Versed")],
      pixelWorldJson: answer({
        draw: [{ id: "I95_SHIELD", label: "I-95 shield", prompt: "an interstate 95 shield" }],
        furniture: [{ type: "DRAWN_I95_SHIELD", col: 2, row: 2 }],
      }),
      pixelSpriteJson: JSON.stringify({ name: "I-95 shield", palette: { a: "#1b3a6b", b: "#ffffff" }, pixels: ["aaaa", "abba", "abba", "aaaa"] }),
    });
    const store = await mount(api);
    fireEvent.change(field(), { target: { value: "a DC map room" } });
    fireEvent.click(screen.getByRole("button", { name: "Build it" }));
    await waitFor(() => expect(store.getState().officeWorld).not.toBeNull());
    expect(api.calls).toContain("drawPixelSprite:an interstate 95 shield");
    expect(furnitureVocabulary().flatMap((g) => g.ids)).toContain("DRAWN_I95_SHIELD");
  });

  it("retries once with the refusal handed back, rather than dead-ending", async () => {
    /* A ragged room by one character is the model's most common slip, and the first version of this
       showed the error and stopped — which for the user is a dead end they cannot act on. */
    const api = fakeApi({ spaces: [space("s1", "p1", "Versed")], pixelWorldJson: answer({ room: ["######", "#111#", "######"] }) });
    const store = await mount(api);
    fireEvent.change(field(), { target: { value: "a city at night" } });
    fireEvent.click(screen.getByRole("button", { name: "Build it" }));
    await waitFor(() => expect(screen.getByLabelText("Why that office was refused")).toBeInTheDocument());
    expect(api.calls.filter((c) => c.startsWith("generatePixelWorld:"))).toHaveLength(2);
    expect(store.getState().officeWorld).toBeNull();
  });

  it("stops at two attempts — a second failure is the ask, not the model", async () => {
    const api = fakeApi({ spaces: [space("s1", "p1", "Versed")], pixelWorldJson: answer({ room: ["##", "#"] }) });
    await mount(api);
    fireEvent.change(field(), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Build it" }));
    await waitFor(() => expect(screen.getByLabelText("Why that office was refused")).toBeInTheDocument());
    expect(api.calls.filter((c) => c.startsWith("generatePixelWorld:"))).toHaveLength(2);
  });

  it("offers no repaint until there is a world to repaint", async () => {
    const api = fakeApi({ spaces: [space("s1", "p1", "Versed")] });
    await mount(api, null);
    expect(screen.getByRole("button", { name: "Terminal green" })).toBeDisabled();
  });
});
