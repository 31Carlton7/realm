# Realm Shell — UI Overhaul Design (Codex-flat)

**Date:** 2026-08-24 · **Status:** approved in brainstorming. Supersedes the visual/layout portions of Plan 2's shell. The spaces model, gesture stack, agent sessions, and all of Plan 3 are untouched.

**Decision history:** depth was diagnosed as the core visual problem; an earlier draft of this spec chose vibrant glass (macOS vibrancy). **Revised the same day to the Codex-app flat direction** after reviewing OpenAI's Codex desktop app: glass is hard to replicate faithfully in React/Electron and platform-dependent, while the Codex look — panels-in-a-frame, generous consistent rounding, hairline borders, no blur — achieves the depth goal in plain CSS with identical results everywhere. Navigation = **Arc-true** (sidebar is the open set, TabBar retired). Themes = **dark-first, competent light**. References: Codex app screenshots (2026-08-24), `Realm Material Study` / `Realm Shell Layouts` artifacts.

---

## 1. The material system (panel-in-frame)

Three flat levels. Every component sits on exactly one. No vibrancy, no backdrop blur — the BrowserWindow's vibrancy setting is removed and the window paints opaque, identically on every platform.

### Level 0 — the frame
The window ground: the darkest surface (mockup starting point `#131417`). The sidebar sits directly on it with no panel of its own — its rows, search field, and strip are drawn straight on the frame, Codex-style. No space-colour tinting.

### Level 1 — panels
Every layout leaf (session, terminal, future browser pane) is a **rounded panel**: one luminance step up (`#1b1c20`), `1px` hairline border (`#26272c`), radius **12px**, with an **8px gap** between panels and against the frame edge. A split therefore reads as side-by-side rounded panels on the frame — exactly the Codex two-pane composition. Panels have **no drop shadow**; the luminance step and hairline do the separation. Terminal keeps its own darker interior but takes the same border/radius.

### Level 2 — raised
True overlays only: menus, sheets, the command palette, and the floating composer. One more luminance step (`#222329`), same hairline, radius 12px, plus the only shadows in the app (`0 8px 24px rgba(0,0,0,.4)`).

### Rounding and borders
Radii are few and consistent — 12px panels/overlays, 8px controls (rows, buttons, chips, search), 6px small chips. Hairlines everywhere separation is needed; never two adjacent fills without one. This — not blur — is the "squircle" feel of the reference.

### Space colour: accent only
`paletteFromColor` shrinks: it derives `accent` (contrast-adjusted per mode) and nothing else — no ground tints, no sidebar hues. The space colour appears in exactly: the space dot next to the name, the active square in the space strip, the active sidebar row's 2px left indicator, focus rings, and the filled primary button. Switching spaces changes content + accent, not the world's colour. (If spaces later need more visual identity, a ≤4% ground tint is the escape hatch — explicitly out of scope now.)

### Tokens
`--rl-*` rebuilt (~18 tokens): `frame`, `panel`, `raised`, `line`, three text tiers (`textBright #ececf1` / `textDim #9a9ba5` / `textFaint #5e5f68`), `accent`, semantic (`danger`/`success`/`warning` — warning is the Codex-style orange for permission/full-access states), radii, shadow, easing. Exact values are plan-time; the hexes above are the mockup starting points. `applyTheme`/`data-mode` delivery unchanged.

## 2. Shell structure (Arc-true)

### TabBar retires
- Delete `apps/desktop/src/renderer/src/components/TabBar.tsx` and its CSS.
- Contracts: a layout **leaf holds exactly one item** — `tabs: string[]`/`activeTab` becomes `itemId: string | null`. `packages/contracts/src/layout.ts` reshapes: `setActiveTab` deleted; `addTab` → `openItem(l, leafId, itemId)` (replace-in-leaf); `removeTab` → `closeItem(l, itemId)` (keeping its collapse-the-split semantics); `allTabs`/`findLeafOfTab` → `allItems`/`findLeafOfItem`; `splitLeaf`, `gridPreset`, `updateSizes`, `firstLeaf` keep their shapes. Uniqueness invariant: an item appears in at most one leaf. Persisted layouts migrate: each leaf collapses to its `activeTab` (or first tab); displaced tabs return to the space list (pure `migrateLayout` in contracts, applied on read).
- `PaneHost` renders leaves as Level-1 panels with the 8px gutter; store drops tab-tracking state.

### Sidebar composition (top → bottom, drawn on the frame)
1. **Search field** — 8px-radius recessed field; placeholder carries the ⌘K affordance.
2. **Space header** — icon + name 15px/600 with the accent dot; ⋯ menu unchanged.
3. **`OPEN` group** — items currently in the layout, in layout order. Active row: `panel`-level fill + 2px accent left indicator. Hover reveals ×; closing removes from layout only. During a split, each open row shows a 2px quadrant glyph for its pane position.
4. **`SPACE` group** — everything else; click opens into the focused leaf (replaced item returns here). Pinned grid renders as a compact tile row at the top of this group. An item appears in exactly one group.
5. **New…** footer button — unchanged behaviour.
6. **Space strip** — unchanged (icons, drag-reorder, two-finger swipe). Active square = accent fill.

Group labels (`OPEN`, `SPACE`): 10.5px/500 uppercase, letter-spaced, `textFaint` — the Codex "Projects/Recents" register.

### Splits
- `⌘\` splits the focused leaf; next item opened fills the new leaf. `LayoutMenu` presets unchanged.
- **New interaction:** dragging a sidebar row onto a panel edge creates a split there (drop zones: 4 edges + centre-replace).
- Closing a split leaf's item collapses the split (`closeItem` inherits `removeTab`'s semantics).

### Untouched
SpaceSwiper/gesture stack (the swipe slides sidebar content only — no ground re-tint now), drag-reorder, item context menus, sheets, CommandPalette, NewSessionSheet (all restyled only).

## 3. Panel contents

Transcript components keep structure and behaviour; material, type, and the two noted follow-ups change.

- **Empty session state:** centered, Codex-style — agent icon, "What should we work on in *<space>*?", and 3–4 suggestion chips that fill the composer (static per agent kind in v1; no new backend).
- **User messages:** right-aligned bubbles, `raised`-level fill.
- **Assistant prose:** no container — directly on the panel, max measure ~72ch.
- **Thinking:** collapsed one-line with dim left rule; click to expand.
- **Tool cards:** 12px mono command line; running/ok/error status glyph; output in a recessed well (`frame`-level fill inside the panel). Extends `toolSummary`/`toolIcon` to Codex (`exec_command`, `apply_patch`) and ACP titles — closes that Plan 3 follow-up.
- **Permission card:** `warning`-tinted border + fill on the panel, Codex-orange register; buttons as level steps, Allow filled with accent. Behaviour untouched.
- **Composer:** Level-2 floating rounded field docked at the panel bottom with chips inside (model/effort/permissions/cwd); permission-mode chip shows in `warning` colour when mode is `bypassPermissions` (the Codex "Full access" treatment). Cost renders blank when `costUsd` is 0 — closes that follow-up.
- **Type scale:** base 13px; space name 15/600; pane title 13/600; group labels 10.5/500 caps; sidebar rows 12.5px; tool mono 12px. System font stack; bundling a mono face is a plan-time decision.

## 4. Motion

Three moments, all disabled under `prefers-reduced-motion`; everything else instant:
1. Space swipe — the existing continuous sidebar slide (no tint work).
2. Panel settle: 150ms opacity + 4px translate when a leaf's item changes.
3. Permission card enter: 120ms scale from 98%.

## 5. Light mode (dark-first)

Same token structure, inverted derivation: light frame (`#f2f2f4`), white panels, hairlines darker than fills, text tiers flipped, accent contrast-adjusted. Flat material makes this a straightforward single derivation pass. `data-mode` unchanged.

## 6. Verification

- Contracts: layout reshape + `migrateLayout` unit tests (round-trip every persisted-layout shape from Plan 2 fixtures).
- Renderer: tests updated for removed TabBar; new tests for open/space grouping, close-returns-to-space, drag-to-split, and the empty-state suggestions filling the composer.
- Visual: CDP screenshot pass, both modes × 3 space accents; WCAG AA spot checks (`textDim` on `panel` and `frame`).
- Live: `pnpm dev` manual pass — swipe, open/close/split flows, permission card, terminal legibility, empty state.

## 7. Out of scope (roadmap)

Browser pane + realm-mcp; **Pull Requests tab** (Codex-app-style PR list in the sidebar — roadmap item, records the reference app's feature); ACP mode mapping; dynamic model pickers; ground tinting for space identity; Windows/Linux polish beyond the (now trivial) shared rendering; sidebar width preference; any server/adapter change.
