# Realm Design Language v2 — "Quiet Instrument"

Grayscale, luminance-separated, shadow-over-border. Drives the implementation plan; speaks in the
existing `--rl-*` / `--r-*` token vocabulary from `packages/ui/src/theme.ts` and
`apps/desktop/src/renderer/src/styles.css`.

---

## 1. Reference inventory

Every file in `~/Desktop/Home/carlton-design-skill-inspo/`, one line each: what it is → the move worth stealing.

| File | What it is | Steal |
|---|---|---|
| `03a2b511…webp` | Knowledge Base app, light | Black-fill primary button; icon rail + inner sidebar; selected nav = gray pill fill, zero borders |
| `04801e1a…webp` | "Executing Workflow" run view, dark | Step timeline w/ check circles + hairline dividers only; agent badge = dark pill with colored status dot |
| `0b22b75f…webp` | Version-history canvas, dark | Raised dark popover with shadow, no border; green as the only non-gray; dark-gray fill buttons |
| `2db6e4eb…webp` | Analytics dashboard, dark | Pill tab nav (active = lighter fill); monochrome white area charts; tinted status pills (dark-green bg) |
| `61a6adae…webp` | Run Details modal, light | Inline mono metadata chips; step tree with green checks; segmented control w/ raised white active tab |
| `75e4fde4…webp` | AI writing assistant card, light | Model selector at BOTTOM of the card; action chip row; hairline-separated footer; dark primary button |
| `G-D7kqKXwAARSvg.jpeg` | Node canvas generating app screenshots | Dotted-grid canvas; state word ("Ready") in color under card title |
| `G3T1dZ8bcAACO7X.jpeg` | Quotient knowledge base, light | Page-as-card on faint ground; soft ambient document thumbnails; hierarchy from type scale, not rules |
| `G3Y_CjgbwAAydEQ.jpeg` | Notifications popover, light | Status-transition pills (icon ring + label); rows split by hairlines only; underline-active tabs |
| `HICKFnqaoAAue8C.jpeg` | Compose email, warm light | Model chip bottom-left / primary action bottom-right of composer; mono uppercase field labels; recipient pill chips |
| `HId3AZ5agAAdzV5.png` | Agent tool trace, light | Collapsed "18 tools, edited 5 files" summary line + duration right; dashed connector; gray tag pills; output well w/ copy |
| `HId3AwtbAAALZq4.jpeg` | Onboarding checklist cards, light | Shadow-only cards at ~24px radius; thumbnail-left rows; zero borders |
| `HId3BEIaMAEeE59.png` | "Ask anything…" prompter, light | THE prompter: floating card, controls row inside bottom edge, circular send, under-strip attached beneath |
| `HId3BS2aYAAMw69.png` | Sidebar menu, light | Hover/active = rounded gray pill; dark kbd tooltip ("Press ⌘J"); gray section labels |
| `HJ0olHUaYAEocWe.jpeg` | Email client, light | Icon rail with active icon in white squircle; model usage card w/ orange tally-bar meter; dark Continue pill |
| `HJz3J32bAAA0bfj.jpeg` | Contact card, light | Label-left / value-right k-v rows; outlined secondary button; one card, no internal rules |
| `HJz3KMTawAA6a6-.jpeg` | "What would you like to do?" agent prompt | Numbered options w/ kbd chips; selected row = gray pill; footer: navigate hints + ESC + dark Submit ↩ |
| `HKtBo7taAAAhAzI.jpeg` | GitHub redesign, light | Underline-active tabs; pill controls; table rows w/ hairlines; breadcrumb chrome |
| `HLB9sUEaQAA267c.jpeg` | Alpaca agent workspace, light | Top pill-nav; recents list w/ status dots (filled = active); feature rows in one hairline card; dark CTA pill |
| `HLB9taPa4AAQiLu.jpeg` | Alpaca mobile preview | Same system compressed; full-width dark "New task" bar |
| `HLBIXNLbcAA_gXl.jpeg` | Company profile (Zapier), light | k-v list w/ gray tag pills; stat cards; single restrained accent for tabs/links only |
| `HLGr0xUaIAAy2F5.jpeg` | Pricing, warm light | Tally-bar credit meters (segmented ticks, not smooth bars); dark vs colored CTA distinction |
| `HLGr1rPawAEWBcH.jpeg` | Share-agent dialog, warm light | Inset tinted preview panel inside card; link row + Copy; outlined + dark button pair in footer |
| `HLHApN8aIAAn3mF.jpeg` | Settings + app marketplace, light | Sectioned settings sidebar (Personal/Workspace/Channels); icon squircle rows; tab pills |
| `HLL1bGnbYAAwUaU.jpeg` | "You're all set" dialog | Checklist confirmation card; dark pill + outlined pill CTA pair |
| `Screenshot 2026-05-21 8.03.07` | Mercury "Create Agent", light | Chat-driven builder + live preview panel; tools rows w/ dark Connect buttons; green "Complete" checks |
| `Screenshot 2026-06-17 5.15.27` | shadcn dashboard, dark | True-neutral dark scale (no blue cast); monochrome charts; white stat numerals |
| `Screenshot 2026-06-18 6.44.22` | "before" gallery, dark | Near-black ground; filter pill rows; content carried by cards, chrome disappears |
| `Screenshot 2026-06-19 12.09.58` | AI Workforce empty state, light | Empty state = ghosted example cards flanking a real one + centered CTA; whisper-light sidebar |
| `Screenshot 2026-06-19 12.25.23` | Agent coding tool, light | Inline mono code chips in prose; agent work narrated as compact left panel; preview card |
| `Screenshot 2026-06-19 12.25.59` | Atlas flow graph, dark | Dark dotted canvas; white-on-dark active segment in toolbar |
| `Screenshot 2026-06-19 12.26.20` | Atlas controls panel, dark | UPPERCASE micro section labels; outlined dark control buttons; count-tag pills |
| `Screenshot 2026-06-19 12.27.36` | Mobbin directory, dark | Type-only hierarchy on near-black; no card chrome until content needs it |
| `Screenshot 2026-06-19 12.28.04` | Mobbin app page, dark | White primary pill on dark; metadata row as quiet columns; underline tabs |
| `Screenshot 2026-06-19 12.28.12` | Mobbin flows list, dark | Collapsible left tree; screens grid; dark chrome recedes fully |
| `Screenshot 2026-06-19 12.28.21` | Mobbin flow viewer, dark | Overlay viewer with Save/Copy pills; content luminous, chrome dark |
| `Screenshot 2026-06-19 12.28.25` | Mobbin screen zoom, dark | Modal viewer: one bright artifact centered on near-black |
| `Screenshot 2026-06-19 12.28.42` | Mobbin wishlist flows, dark | Same family; tree + grid consistency |
| `a933dcf2…webp` | AI chat workspace, light | Source/artifact chips (favicon + label); model dropdown in header; project counts right-aligned |
| `db9f7ce0…webp` | Storage table + dark toast | Dark floating toast panel w/ red tally meter; red reserved strictly for warning |
| `ee0a8029…webp` | AI prompt input, 4 states (Sergushkin) | Prompter states: placeholder w/ @ and / affordances; chips BELOW when empty; attachments INSIDE top; dark circular send ↔ stop square; "Thinking…" strip under bottom edge |
| `f0fb1092…webp` | Task records w/ diff table, light | Row-level diff tinting (faded red removed / green added); dotted-underline links; AI Summary/Change Log toggle chips |
| `fb612a08…webp` | Workflow node canvas + LLM settings, light | Focused card = accent ring only; PROMPT well; token/time metadata chips; settings panel structure |
| `ff83ae7f…webp` | Search result chunks, light | Card = meta header row / body / file footer row; hover preview popover w/ "View in context" |
| `original-04ca…webp` | Export interface picker, dark | Selection = accent border + tinted icon ONLY, everything else stays gray; dim unselected cards |
| `original-09d2…webp` | Knowledge base, dark | Dark tree w/ count pills; segmented Folders/Tags toggle (active = lighter fill + hairline); folder cards w/ soft top sheen |
| `original-88747…webp` | Same knowledge base, light | The light twin: proof the system is luminance-first in both modes; hover = one step darker fill |
| `original-9d1d…webp` | Command palette, dark | Action cards atop list; footer kbd chips (↑↓ Navigate, ↵ Select); hover = subtle lighter fill |

---

## 2. Synthesis: the Realm look

1. **Luminance is the border.** Separation comes from stacked gray steps (frame → panel → raised) and
   translucent fills, not drawn lines. Hairlines survive only where two scrolling regions meet
   (sidebar/pane seam, table rows, sticky headers). Everything else loses its stroke.
2. **Shadow means floating; nothing resting casts one.** Panels, panes, and cards in the layout are flat
   fills. Only detached surfaces — prompter, menus, palette, sheets, toasts, tooltips — get the shadow
   stack, paired with a 1px *inset* alpha hairline (`rgba(255,255,255,.07)` dark / `rgba(0,0,0,.07)`
   light) so edges read on any background without a solid border.
3. **Ink does the accenting.** With chroma gone, emphasis is carried by text tier jumps (faint → dim →
   bright), weight (450 → 550), and inverted fills. The primary action is always the inverted pill:
   near-white on dark, near-black on light — the single loudest thing on screen.
4. **Color = state, never chrome.** Green/amber/red appear only as 6–8px status dots, tinted status
   pills, and diff tints. A screen at rest is 100% gray; a colored pixel always means "something is
   live, waiting, or wrong." Space colors survive solely in the space dot and space-strip icon.
5. **Metadata lives in chips.** Model names, branches, token counts, file names, durations, tags: 11px
   mono-or-medium text in `raised`-fill rounded chips (no border). Chips are the system's unit of
   glanceable fact — steal the header/footer meta rows of `ff83ae7f` and the trace tags of `HId3AZ5`.
6. **Density with air.** 12.5–13px UI type, 28px rows, but generous section padding (16–24px) and real
   type-scale jumps for page titles (15/600 → 18/650). Uppercase 10.5px/.08em micro-labels mark
   sections (already in `.group-label` — keep, extend to panels per Atlas `12.26.20`).
7. **Selected ≠ outlined.** Active nav/list state is a translucent pill fill + bright text
   (+ optional 2px left tick). Kill the accent-tinted `data-active` fills and `line-strong` borders on
   active strip items; match `HId3BS2`/`original-88747`.
8. **The agent's work is a quiet ledger.** Tool activity renders as collapsed summary lines
   ("18 tools · 5 files · 2 commands · 6m 12s") that expand into icon + label + tag-chip steps with
   hairline or dashed connectors — never as loud boxed cards (`HId3AZ5`, `04801e1a`, `61a6adae`).

**Honest flags where direction and corpus diverge:**
- "No borders" is not literal in the corpus: light-mode floating cards in these references almost
  always carry a *hairline* (≤8% alpha) plus shadow. Borderless-with-shadow-only reads mushy on white.
  So: drop `line-strong` borders and all *resting* borders; keep low-alpha inset hairlines on floating
  surfaces. That is what the references actually do.
- The corpus is not 100% achromatic: several references keep one restrained blue for links/tabs/selection
  (`HLBIXNL`, `original-04ca`, Kombai). The call for Realm: go fully neutral anyway — the inverted-ink
  primary appears in enough references (`03a2b511`, Mobbin, Alpaca, `HICKFnq`) to prove it works, and it
  differentiates Realm harder. Semantic green/amber/red carry all remaining meaning.
- Half the corpus is light mode. The grayscale spec below therefore lands both modes with equal care;
  dark stays the default.

---

## 3. Token spec

Neutralize every surface (current darks have a blue cast — h≈228). All values are pure gray.
`paletteFromColor()` keeps its signature, but the space color no longer tints frame/panel (delete the
`ground()` escape hatch) and no longer produces the accent: chrome is space-agnostic; the space color
is exposed only as `--rl-space` for dots/icons.

### Dark (default)

| Token | Value | Notes |
|---|---|---|
| `--rl-frame` | `#111113` → **`#121212`** | window ground, space strip, sidebar |
| `--rl-panel` | **`#1a1a1a`** | panes, sidebar cards |
| `--rl-raised` | **`#222222`** | menus, sheets, prompter, chips, wells-on-panel |
| `--rl-terminal-bg` | **`#0e0e0e`** | darkest step; terminals sit below frame |
| `--rl-line` | **`#252525`** | hairlines: pane seams, table rows, sticky header edges |
| `--rl-line-strong` | **`#333333`** | resize-handle hover, kbd chips only — no longer a card border |
| `--rl-hover` | `rgba(255,255,255,.06)` | hover fill |
| `--rl-active` *(new)* | `rgba(255,255,255,.09)` | selected pill fill (replaces accent-tinted selection) |
| `--rl-text-bright` | **`#f2f2f2`** | |
| `--rl-text-dim` | **`#a0a0a0`** | |
| `--rl-text-faint` | **`#6f6f6f`** | |
| `--rl-accent` | **`#f2f2f2`** | = ink. Primary buttons, focus rings, active ticks, send button |
| `--rl-accent-contrast` *(new)* | **`#111111`** | text/icon on accent fills |
| `--rl-danger` | **`#e5484d`** | slightly desaturated from `#f87171` |
| `--rl-success` | **`#46a758`** | replaces minty `#6ee7a0`; darker, reads as state not neon |
| `--rl-warning` | **`#d9822b`** | |
| `--rl-shadow` | `0 1px 2px rgba(0,0,0,.3), 0 8px 24px rgba(0,0,0,.45)` | two-layer stack |
| `--rl-edge` *(new)* | `inset 0 0 0 1px rgba(255,255,255,.07)` | floating-surface hairline (box-shadow, composes with `--rl-shadow`) |

### Light

| Token | Value |
|---|---|
| `--rl-frame` | `#f4f4f4` |
| `--rl-panel` | `#ffffff` |
| `--rl-raised` | `#fafafa` |
| `--rl-terminal-bg` | `#141414` (terminals stay dark in light mode — corpus-consistent) |
| `--rl-line` | `#e8e8e8` |
| `--rl-line-strong` | `#d6d6d6` |
| `--rl-hover` | `rgba(0,0,0,.05)` |
| `--rl-active` | `rgba(0,0,0,.07)` |
| `--rl-text-bright` | `#181818` |
| `--rl-text-dim` | `#606060` |
| `--rl-text-faint` | `#8f8f8f` |
| `--rl-accent` | `#181818`; `--rl-accent-contrast: #ffffff` |
| `--rl-danger` `#d93036` · `--rl-success` `#2f9e44` · `--rl-warning` `#c2701d` |
| `--rl-shadow` | `0 1px 2px rgba(0,0,0,.06), 0 8px 24px rgba(20,20,20,.10)` |
| `--rl-edge` | `inset 0 0 0 1px rgba(0,0,0,.07)` |

### Usage rules
- **Focus ring:** `0 0 0 2px color-mix(in srgb, var(--rl-accent) 35%, transparent)` — neutral, replaces purple ring everywhere (`.composer:focus-within`, `.field input`, `.rename`).
- **Selection (::selection):** `color-mix(in srgb, var(--rl-accent) 18%, transparent)`.
- **Primary button:** accent fill, accent-contrast text, radius `--r-ctl`, no border. Secondary: `raised` fill. Ghost: text-dim + hover fill. Destructive: danger-tinted text button; danger fill only in confirm dialogs.
- **Status pills:** `color-mix(in srgb, var(--rl-success) 14%, transparent)` fill + full-strength colored text (per `2db6e4eb`, `f0fb1092`).
- **Radii:** keep `--r-panel: 12px`, `--r-ctl: 8px`, `--r-chip: 6px`; add `--r-float: 16px` for prompter/palette/sheets. Concentric rule: outer = inner + padding.
- **Session status:** running = success dot (pulse), waiting_permission = warning dot, error = danger dot, idle = `line-strong` dot. Nothing running-related uses accent anymore.

---

## 4. The prompter (composer)

Codex-style centerpiece. Two states, one component. References: `HId3BEI`, `ee0a8029`, `75e4fde4`, `HICKFnq`.

**Geometry**
- `width: min(680px, 100% - 48px)`, always horizontally centered in its pane (`margin-inline: auto`) — never full pane width, in both states.
- Radius `--r-float` (16px). Background `--rl-raised`.
- **No border.** `box-shadow: var(--rl-edge), var(--rl-shadow)`. On focus, swap ring in: `var(--rl-edge), 0 0 0 2px color-mix(in srgb, var(--rl-accent) 30%, transparent), var(--rl-shadow)`.

**Internal rows (top → bottom)**
1. *Context row* (only when present): attachment/context chips — repo, branch, files — as `raised`-on-raised chips (`--rl-hover` fill, 11px, × to remove). Padding 10px 12px 0.
2. *Input row:* textarea, 13px/1.55, padding 12px 14px; placeholder "Message the agent…" in text-faint. Min-height 44px empty-state, autogrows to 10 lines.
3. *Control row* (inside the card, hairline-free, 12px padding): left → **agent icon** (Claude spark glyph, 16px, text-dim), **model selector** (ghost chip: "Claude · Fable 5 ⌄"), effort selector, permission-mode selector — all borderless ghost chips that open menus upward. Right → mic/attach ghost icon-buttons, then **send**: 28px circle, accent fill, accent-contrast ↑ icon; morphs to ▪ stop while streaming (crossfade opacity+scale 0.25→1 w/ 4px blur, 160ms).

**Empty state (centered hero)**
- Prompter block sits at ~38% viewport height, pane otherwise empty (`frame`-level calm).
- Above: space name greeting, 18px/650 text-bright (one line, no illustration).
- Below the card, 12px gap: **suggested-prompt chips**, 2×2 grid ≤ 640px (reuse `.suggestion-chip`): `raised` fill, radius `--r-ctl`, title 12.5px/550 bright + one-line 11.5px dim description, hover = lift to `--rl-hover` overlay. No borders. Stagger-in 40ms apart, 8px rise, 220ms ease-out; never re-animate on revisit.
- Optional under-strip (Codex-style, per `HId3BEI`): a `frame`-fill strip tucked under the card's bottom radius for hints/usage; reserved, off by default.

**Docked state (active transcript)**
- Same component pinned to pane bottom: `margin: 8px auto max(12px, env(safe-area))`; transcript scrolls beneath — give transcript matching `max-width: 680px` centered column so prompter and content share rails.
- Transition empty → docked: the card *moves* (translateY + width settle, 320ms `--ease-in-out-strong`); do not fade out/in two instances.
  *(Amended 2026-08-28, W2: this line originally read `--ease-out-strong`, contradicting §6's motion table.
  §6 is authoritative — it assigns `--ease-in-out-strong` to on-screen movement, which is exactly what this is.)*
- While streaming: "Thinking…" shimmer line docks under the bottom edge (per `ee0a8029` state 4); no skeletons inside the card.

---

## 5. Component treatments

- **Sidebar:** stays on `--rl-frame`; kill `.sb-divider` solid line → 16px spacing + `.group-label`. Active item: `--rl-active` pill + bright text; drop the accent left-tick or render it in `--rl-accent` (ink) at 2px. Item status dots go semantic (green/amber/red). Search field: `raised` fill, no border, focus ring per §3. Space dot keeps `--rl-space` color — the one identity pixel.
- **Space strip:** active space = `--rl-active` fill squircle, no `line-strong` border, its glyph in `--rl-space` color; badges keep semantic colors (running badge → success, not accent).
- **Pane headers:** height/type unchanged; remove bottom border where the header sits on same-luminance panel — separation via `frame` vs `panel` step; keep 1px `--rl-line` only when content scrolls beneath (sticky). Active-pane indicator: 2px accent underline on the title, not a full-width colored bar. Header meta (model · cost · turns) becomes chips.
- **Tool cards:** demote borders: `--rl-panel` card on transcript with `--rl-edge` only when expanded; collapsed = a *row* (icon 16px stroke-standard, name 12.5px/550, args mono dim, status glyph right) — per `HId3AZ5`. Output/`tool-well`: `--rl-terminal-bg`-adjacent well (`frame` fill), radius `--r-chip`, mono 12px, copy ghost button, max-height 260px. Group consecutive tools under a collapsed summary line with dashed left connector.
- **Permission cards:** drop the amber-tinted panel wash → neutral `raised` card, `--rl-edge` + shadow (it *floats*: it interrupts), amber reserved for a 6px dot + "Waiting" pill. Options become the numbered list pattern from `HJz3KMT`: kbd number chips, selected row = `--rl-active` pill, footer = ↑↓/esc hints left, dark Submit (accent pill, ↩ glyph) right.
- **Menus / command palette:** `raised` fill, `--r-float` on palette / `--r-panel` on menus, `--rl-edge` + `--rl-shadow`, **no `line-strong` border**. Items 28px, hover `--rl-hover` pill. Palette gains footer kbd-hint row (↑↓ Navigate · ↵ Select · esc) per `original-9d1d`. Menus scale from trigger origin 0.97→1, 140ms.
- **Sheets / dialogs:** `raised`, `--r-float`, edge+shadow, scrim `rgba(0,0,0,.45)`. Footer: primary accent pill right, ghost/outlined left (`HLL1bGn`). Destructive confirms are the only red-filled buttons in the app.
- **Terminals:** `--rl-terminal-bg` below frame luminance — the terminal is the darkest thing on screen (per shadcn/Mobbin darks); no border, no radius when full-pane; 8px radius + edge when embedded in transcript. Hint text stays faint mono.
- **Tables / lists:** hairline rows (`--rl-line`), no vertical rules, header 11px faint uppercase; counts right-aligned in `raised` count pills (per `original-09d2`).
- **Error/conn banners:** keep tinted-text treatment but fills at 8% color-mix on `panel`, no colored border — tint + dot suffices.
- **Empty states:** ghosted example content + one accent CTA (per `12.09.58`), never a lone icon.

---

## 6. Motion spec (per emil-design-eng)

Easings: `--ease-out-strong: cubic-bezier(.23,1,.32,1)` (enter/exit, replaces current `--ease`),
`--ease-in-out-strong: cubic-bezier(.77,0,.175,1)` (on-screen movement), `ease` (color/hover), `linear` (spinners/progress).

| Moment | Duration / easing | Notes |
|---|---|---|
| Button/chip press | 120ms, scale 0.97 | all pressables incl. suggestion chips, send |
| Hover fills | 100ms `ease`, background only | `transition-property: background-color, color` — never `all` |
| Icon swaps (send↔stop, copy✓) | 160ms, opacity 0→1 + scale .25→1 + blur 4px→0 | both icons in DOM, cross-fade |
| Tooltips | 125ms ease-out, scale .97, origin = trigger | instant (0ms) for adjacent tooltips once one is open |
| Menus/popovers | 140ms ease-out, opacity + scale .97→1, origin-aware | exit 100ms |
| Prompter empty→docked | 320ms `--ease-in-out-strong`, transform+width | one instance moving, interruptible (CSS transition) |
| Suggestion-chip stagger | 220ms ease-out, 40ms delay steps, translateY 8px | first render of empty state only |
| Sheets | enter 240ms ease-out (scale .96 + fade, origin center); exit 160ms | scrim fades 160ms |
| Transcript message enter | 180ms ease-out, translateY 6px + fade | new items only; `initial=false` on mount |
| Tool row expand | height via grid-template-rows 200ms `--ease-in-out-strong` | content fade 120ms |
| Status dots (waiting) | keep `rl-pulse` 0.9s ease-in-out | the only looping motion at rest |

**Do NOT animate:** pane focus switching, sidebar space swipes triggered by keyboard, command-palette
open/close (⌘K is a 100×/day action — instant, per Raycast rule), terminal output, resize drags,
theme/mode switching, anything during an active drag. Honor `prefers-reduced-motion`: keep opacity
fades ≤160ms, remove all translate/scale.
Performance: transform/opacity only; no `transition: all` anywhere (audit `styles.css`); `will-change`
only on the swiper track.

## 7. Iconography

- **Pack:** Hugeicons **stroke-standard** everywhere (replace stroke-rounded imports app-wide — one
  codemod; no mixed packs, no filled variants except status dots which are CSS circles).
- **Sizes:** 16px default (rows, chips, headers), 18px pane-header primaries, 14px inside chips/dense
  meta, 20px only in empty states. Stroke weight stays the pack's 1.5px; never scale icons non-integer.
- **Color:** `text-dim` at rest, `text-bright` on hover/active, never accent-colored at rest; semantic
  colors only on status glyphs (check = success, alert = warning/danger).
- **Alignment:** optical centering — icons in 26px `icon-btn` grids get per-icon nudge when asymmetric
  (send arrow, play); keep ::after hit-area extension to ≥40px targets.
- **Agent identity:** the agent glyph (Claude spark) renders 16px, text-dim, in prompter control row and
  transcript avatars — a mark, not a logo moment.
