// @vitest-environment node
import { describe, expect, it } from "vitest";
import { platformCapabilities } from "@realm/contracts";
import { titleBarOverlay, windowChrome } from "./window-chrome";

describe("windowChrome", () => {
  it("keeps the Mac's inset traffic lights over the sidebar's material", () => {
    expect(windowChrome(platformCapabilities("darwin"), true)).toEqual({
      titleBarStyle: "hiddenInset", trafficLightPosition: { x: 12, y: 14 }, vibrancy: "sidebar", backgroundColor: "#00000000",
    });
  });

  it.each(["win32", "linux"])("on %s, lays the system's controls over the head row, with no Mac offsets", (platform) => {
    // THE MUTANT: keep `hiddenInset` everywhere, and a Windows window has no close button at all.
    const o = windowChrome(platformCapabilities(platform), true);
    expect(o.titleBarStyle).toBe("hidden");
    expect(o.titleBarOverlay).toEqual({ color: "#00000000", symbolColor: "#e6e7ea", height: 40 });
    expect(o).not.toHaveProperty("trafficLightPosition");
    expect(o).not.toHaveProperty("vibrancy");
    expect(o.backgroundColor).toBe("#17181a");
  });

  it("draws the controls' glyphs in the appearance's ink", () => {
    expect(titleBarOverlay(false).symbolColor).toBe("#1f2024");
    expect(titleBarOverlay(true).symbolColor).toBe("#e6e7ea");
  });
});
