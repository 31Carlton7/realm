import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { APP_ICONS, AppIconPicker, canChooseAppIcon, dataUrlBytes } from "./AppIconPicker";

/* Vitest serves an asset as its PATH even under `?inline`; the built renderer gets a data: URL. The
   one picture this file picks is given the built form — a real PNG signature — so the decode is what
   is under test (app-icon-live.mjs checks the real bundle). */
vi.mock("../../assets/app-icons/ember.png?inline", () => ({ default: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" }));

function bridge(current: string, accept = true) {
  const appIcon = { get: vi.fn(async () => current), set: vi.fn(async (_id: string, _png: Uint8Array) => accept) };
  Object.assign(window, { realm: { appIcon } });
  // The picker must never fetch: the built renderer's CSP refuses file:// (see AppIconPicker.tsx).
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("fetch is refused by the renderer CSP"); }));
  return appIcon;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete (window as { realm?: unknown }).realm; });

const radio = (label: string) => screen.getByRole("radio", { name: label }) as HTMLInputElement;

describe("AppIconPicker", () => {
  it("is offered only where main has a Dock to put the icon on", () => {
    expect(canChooseAppIcon()).toBe(false);
    bridge("default");
    expect(canChooseAppIcon()).toBe(true);
  });

  it("shows every icon and starts on the one main says is on the Dock", async () => {
    bridge("ocean");
    render(<AppIconPicker />);
    expect(screen.getAllByRole("radio")).toHaveLength(APP_ICONS.length);
    await waitFor(() => expect(radio("Ocean").checked).toBe(true));
    expect(radio("Graphite").checked).toBe(false);
  });

  it("hands main the picture the tile draws, under the tile's id", async () => {
    const appIcon = bridge("default");
    render(<AppIconPicker />);
    await waitFor(() => expect(radio("Graphite").checked).toBe(true));
    fireEvent.click(radio("Ember"));
    await waitFor(() => expect(appIcon.set).toHaveBeenCalledTimes(1));
    const [id, png] = appIcon.set.mock.calls[0]!;
    expect(id).toBe("ember");
    // The tile's own picture, as a PNG — decoded from the data: URL the tile draws.
    expect(Array.from(png.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(png).toEqual(dataUrlBytes(APP_ICONS.find((i) => i.id === "ember")!.src));
    expect(fetch).not.toHaveBeenCalled();
    expect(radio("Ember").checked).toBe(true);
  });

  it("goes back to the previous choice when main refuses", async () => {
    bridge("clay", false);
    render(<AppIconPicker />);
    await waitFor(() => expect(radio("Clay").checked).toBe(true));
    fireEvent.click(radio("Mint"));
    await waitFor(() => expect(radio("Clay").checked).toBe(true));
    expect(radio("Mint").checked).toBe(false);
  });
});
