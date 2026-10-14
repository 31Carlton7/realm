import { platformCapabilities, setKeyDisplayPlatform, type PlatformCapabilities } from "@realm/contracts";

/**
 * What this OS can do for Realm, as the preload reported it — the one place the renderer asks whether
 * a Mac-only feature exists here, so Settings, the "+" menus and the palette hide what Linux and
 * Windows do not have rather than offering a control whose only outcome is a refusal.
 *
 * jsdom has no bridge, and there the answer is a Mac's: every component test was written against the
 * Mac app, and a test about another OS sets `window.realm.capabilities` itself.
 */
export function capabilities(): PlatformCapabilities {
  return window.realm?.capabilities ?? platformCapabilities("darwin");
}

/**
 * Once, at boot: chords print the way this OS spells them ("Ctrl+K" off a Mac), and the head row
 * leaves the system's window controls their room where they are drawn over it (styles.css,
 * `data-window-controls`).
 */
export function applyPlatform(doc: Document = document): void {
  const platform = window.realm?.platform;
  if (platform) setKeyDisplayPlatform(platform);
  if (!capabilities().insetTrafficLights) doc.documentElement.dataset.windowControls = "overlay";
}
