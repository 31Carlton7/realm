/** Every shipped 3D picture, keyed by its path under `assets/icons3d` (`scripts/icons3d.mjs` writes
 *  them). A module of its own so a test can stand a set of its own in for it. Never inlined: under
 *  Vite's 4 KB limit most of them would go into the bundle as text, every density of every icon, where
 *  as files the screen fetches the one density it draws. */
export const ICON3D_FILES = import.meta.glob<string>("../assets/icons3d/*.webp", { eager: true, query: "?url&no-inline", import: "default" });
