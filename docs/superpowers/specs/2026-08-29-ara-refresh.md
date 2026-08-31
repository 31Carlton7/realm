# Ara refresh — design spec

> Transcribed from three screenshots of Ara (ara.so) supplied by the user on 2026-08-29, with the
> instruction: "Make the UI look virtually indistinguishable from this. Maintain the dark mode though, but
> use an ever so slightly transparent Sidebar… Just copy the entire thing."
>
> This spec AMENDS `2026-08-27-design-language.md`. Where the two disagree, THIS document wins. The ink
> grayscale palette (§3 tokens) survives — Ara is a light app; Realm stays dark and maps Ara's relationships
> (surface steps, hairlines, contrast hierarchy) onto the existing `--rl-*` tokens. What changes is
> typography, scale, geometry, and component shape.

## 1. Typography

Ara is set in the Apple system stack — not Inter, not a webfont. Generous sizes, tight tracking.

- `--font-ui: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif`. JetBrains Mono
  stays ONLY for terminals, diffs, code, kbd.
- **Hero greeting**: ~30px / 600 / -0.02em, `text-bright`. (Today it is 18px — this is the single most
  visible change.) Copy becomes: `What should we build in <space>?` — Ara's phrasing, verbatim.
- **Transcript prose**: 15px / 1.6. Roomy. Assistant text is plain prose, no card.
- **Sidebar rows**: 14px / 500. Section labels ("Projects" → Realm's "OPEN"/"SPACE"): 13px / 500,
  `text-faint`, sentence case — NOT letterspaced smallcaps. Ara does not use smallcaps anywhere.
- **Chips / control row**: 13px / 500. Panel tab labels: 14px. Large panel titles (diff pane header if any):
  24px / 650.
- Placeholder: 15px `text-faint` — "Ask <agent> anything…" replaces "Message the agent…".

## 2. Sizing & geometry

Everything is one step airier and one step rounder than today.

- Radii: prompter card **16px** (unchanged token, but now also on the panel cards), sidebar rows and
  suggestion rows **10px**, chips **8px**, icon buttons **8px**, transcript user-block **14px**.
- Sidebar width: **280px**. Row height 32px, icon 16px, gap 10px, 8px inline padding; 16px page padding.
- Prompter card width: **min(720px, 100% − 48px)** (was 680 — Ara's card is wider relative to the pane).
  Internal padding 16px. Textarea min-height in hero: ~56px before growth.
- Control row height 40px, sits inside the card bottom, 12px horizontal padding.
- Send button: **32px** circle (was 28), accent fill, arrow glyph. Sits flush right.
- Hairlines get SOFTER, not stronger: keep `--rl-edge` shadows; where a real border remains, drop its alpha
  ~25%. Ara reads as almost borderless white-on-white; dark equivalent is raised-on-panel with faint edges.

## 3. The prompter (copy exactly)

Layout of the card, top to bottom:

1. **Textarea** (no context row above it — the context chips MOVE DOWN into the control row).
2. **Control row**, one line:
   - LEFT, in order: a "+" icon button (this is the attach affordance — the paperclip is retired, "+"
     replaces it); then the context chips as plain ghost text+caret chips: folder chip (`<cwd> ⌄`),
     environment chip (`Work locally ⌄` maps to Realm's environment/worktree chip), branch chip
     (`⑂ main ⌄` — opens the diff pane as today).
   - RIGHT, in order: model chip as **plain text** `Fable 5 ⌄` (13px, text-dim; the brand mark stays in the
     picker MENU but comes OFF the chip — Ara's chip is text-only); then the 32px circular send.
   - Effort and permission chips: keep them, but they compress to the left group after the context chips —
     Ara has fewer controls; ours must not overflow. If the row overflows at 720px, effort+permission
     collapse into the model menu rather than wrapping.
3. Attachment chip row (when present) renders ABOVE the textarea inside the card, unchanged behaviour.

**Suggestions become a single-column LIST, not a 2×2 grid.** Full prompter width, directly under the card,
8px gap. Each row: 10px radius, transparent at rest, `--rl-hover` on hover, 12px padding, a leading 16px
glyph (`idea`/play-style icon, text-faint), one line of 14px text-dim (title only — the description line is
retired), no trailing affordances. Stagger animation survives, applied to rows.

**"Thinking…" strip and send↔stop morph survive unchanged.**

## 4. Transcript

- **User message**: a raised card (`--rl-raised`, radius 14, padding 14px 16px), aligned to the RIGHT edge
  of the 720px column, max-width 85%, and — copying Ara exactly — **text-align: right**. (Yes, ragged-left.
  It is Ara's signature and the user said copy it.)
- **Assistant**: plain prose, 15px/1.6, no card, full column width. Links: ink underline (keep grayscale).
- **Working/tool ledger**: the collapsed group row relabels to `Worked for <duration> ›` (live-ticking
  while running, frozen when settled), 14px text-dim, chevron rotates on expand. The expanded ledger keeps
  its current internals.
- Column width follows the prompter to 720px.

## 5. Sidebar (translucent)

- The WINDOW gains macOS vibrancy (`vibrancy: "sidebar"` or `under-window` on the BrowserWindow +
  `backgroundColor: "#00000000"`); every surface EXCEPT the sidebar then paints itself opaque with its
  existing token. The sidebar paints `rgba(18,18,18,0.82)` over the vibrancy — "ever so slightly
  transparent". If vibrancy proves unavailable (non-mac, or transparent-window cost), fall back to the
  opaque `--rl-frame` and say so; never ship a half-broken translucency.
- Structure, top to bottom (mapping Ara → Realm): traffic-light inset (exists) → **Search field stays** →
  section list. Ara's "New chat" row at top maps to Realm's "New session" — MOVE it from the bottom to the
  TOP, first row, icon `edit`-style + label. Bottom bar keeps settings + space strip + "+" as today.
- Rows: 32px, radius 10px, hover `--rl-hover`, active `--rl-active`; session rows under the space header
  indent 8px and truncate with ellipsis. Status dots unchanged.

## 6. Agent view / panel chrome

Ara's right panel header is an icon-button row, not text chips. Map onto Realm's pane header:

- LEFT: pane glyph + title (14px/550) as today.
- RIGHT: a cluster of 28px icon buttons, 8px radius, text-dim → text-bright on hover, in order:
  **branch/diff** (opens diff pane — exists), **terminal** (drawer toggle — exists), **open-external**
  (only where meaningful; skip if nothing to open), **⋯ menu**, **close**. Rename stays on double-click +
  menu. The visual change is: uniform icon cluster, tighter, no text labels, generous 12px padding from the
  pane edge.
- Diff pane header adopts the same cluster (History, Stage all move into it as icon buttons w/ tooltips? NO —
  keep "Stage all" and "History" as text buttons; Ara keeps textual actions where they are primary. Only the
  chrome-level controls become icons.)
- Panel/pane surfaces: same tokens as today, radius 12 where floating.

## 7. Explicitly NOT copied

- Ara's back/forward nav arrows and "Help" (no history concept in Realm; dead chrome is worse than none).
- The blue link color, blue dots, and green "Open" badge hues — grayscale ink stays; semantic tokens
  (`--rl-success` etc.) keep their §3 values where they already apply (PR state, status dots).
- The mic button (no dictation capability — established in Plan 6; do not ship a dead control).
- Ara's queued-task rows' trailing dot/× (they are queue controls, not suggestions).

## 8. Verification bar

jsdom cannot judge "indistinguishable". The coordinator (who holds the screenshots) does a live CDP pass and
iterates; implementers make the structural change + keep the suite green. Tests that pin copy ("What should
we work on"), grid classes, chip order, greeting size, or the paperclip icon MUST be updated to the new
truth — a test that pins the old design is wrong by definition here.
