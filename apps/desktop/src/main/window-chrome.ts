import type { BrowserWindowConstructorOptions, TitleBarOverlay } from "electron";
import type { PlatformCapabilities } from "@realm/contracts";

/** The head row's height, which the renderer keeps every strip at the window's top to (`--frame-top`). */
const HEAD_ROW = 40;

/**
 * How the window is framed on each OS.
 *
 * On a Mac the traffic lights are inset into the head row — y:14 centres the ~14px lights in a 40px
 * strip, and the renderer keeps every strip they can land in at 40px for exactly that reason: .sb-head
 * with the sidebar open, and with it collapsed the first pane's .panel-bar (or the group bar, which is
 * raised to 40px in that one state). One placement serves both, so nothing has to move at runtime when
 * the sidebar collapses. Behind a fully transparent paint sits the sidebar's vibrancy, which the
 * renderer's grounds are drawn over.
 *
 * On Linux and Windows the window has no frame of its own either, so the head row is one ground
 * across the window as it is on a Mac, and the system draws its minimise, maximise and close over the
 * row's right end (`titleBarOverlay`) — the renderer leaves them that room
 * (`data-window-controls="overlay"`). The overlay is clear so the row's own chrome shows behind the
 * buttons, and its glyphs take the appearance's ink. There is no material there, so the window keeps
 * an opaque ground: the BUI dark --page (#17181a ≈ oklch(.209 .004 264.477)), never a half-broken
 * effect.
 */
export function windowChrome(caps: PlatformCapabilities, dark: boolean): BrowserWindowConstructorOptions {
  if (caps.insetTrafficLights) {
    return {
      titleBarStyle: "hiddenInset", trafficLightPosition: { x: 12, y: 14 },
      ...(caps.windowMaterial ? { vibrancy: "sidebar" as const, backgroundColor: "#00000000" } : { backgroundColor: "#17181a" }),
    };
  }
  return { titleBarStyle: "hidden", titleBarOverlay: titleBarOverlay(dark), backgroundColor: "#17181a" };
}

/** The system's window controls over the head row, in the appearance's ink. Re-applied when the
 *  appearance changes (`win.setTitleBarOverlay`). */
export function titleBarOverlay(dark: boolean): TitleBarOverlay {
  return { color: "#00000000", symbolColor: dark ? "#e6e7ea" : "#1f2024", height: HEAD_ROW };
}
