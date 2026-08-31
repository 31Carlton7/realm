# Realm Plan 9 — Beautiful UI, wholesale, on the Ara shell

> User decision 2026-08-31: adopt the Beautiful UI design system WHOLESALE (over the Ara ink tokens), built
> on the held `feat/ara-refresh` branch, merged as one. Source: https://github.com/slev12397/beautiful-ui
> (MIT; clone at the coordinator's scratchpad `beautiful-ui/`). The pasted integration recipe from its README
> is the baseline; deviations below are deliberate.

## What "wholesale" means here — and what it does not

**Adopted:** the token system (`:root`, `.dark`, `@theme` from `app/globals.css`), Tailwind v4, Inter +
JetBrains Mono, the radii (chip 6 / control 8 / card 10 / window 14), hairline borders, shadow-plugin's
layered shadows, the `motion` library, and the primitives/atoms as Realm's rendering layer.

**Kept from Ara (structure, not skin):** the sidebar arrangement with translucency (dark `.dark` values show
through at ~0.82), "New session" on top, the hero prompter at ~38% with "What should we build in <space>?",
single-column suggestions, right-aligned user cards, per-session terminal drawer, pane system. Realm stays
**dark by default** — BUI is light-first, so its `.dark` block is our primary palette and light mode is the
secondary mapping. The existing theme toggle keeps working.

**Dropped, per the recipe's own outs:** `@central-icons-react` (commercial — Hugeicons + brand marks stay),
cuelume sounds, dialkit, posthog, glimm/liveline where unused. `next/font` → self-hosted woff2 (no Next).

## Workstreams (sequential, on `feat/ara-refresh`)

- **W1 — Foundation.** Tailwind v4 via `@tailwindcss/vite` into electron-vite; BUI's globals.css ported
  (tokens verbatim, `@custom-variant dark` mapped onto Realm's existing `data-theme` mechanism); Inter +
  JetBrains Mono vendored; a BRIDGE layer mapping the old `--rl-*` names onto BUI tokens so every existing
  component renders correctly before it is migrated — the app must never be half-themed.
- **W2 — Transcript primitives.** Port `ThinkingState`, `StreamingText`, `ToolChips`, `ApprovalCard`,
  `CodeBlock`, `DiffTable`, `TaskRows`, `LoadingState` (+ needed atoms) into the renderer, strip the demo
  `STAGES`/`VARIANTS` timers, and drive them from Realm's real session events: tool ledger → ThinkingState
  coding variant, PermissionCard → ApprovalCard (Enter-on-Deny guard and numbered keys survive), streaming
  deltas → StreamingText, diff pane rows → DiffTable. Behaviour tests keep passing; visuals re-pinned.
- **W3 — Composer + chrome.** PromptBar/ChatComposer language onto Realm's prompter (chips, overflow
  collapse, attach, send↔stop all keep behaviour), SidebarNav styling onto the Ara sidebar, StatusPill/Chip
  atoms replacing bespoke ones, license attribution for vendored MIT code.
- **W4 — Coordinator visual pass** against the BUI harness look, then single merge of the combined branch.

## Rules

Same gates (`SHELL=/bin/bash pnpm vitest run`, typecheck, build), mutation-grade where logic moves,
behaviour-pinning tests survive verbatim, design-pinning tests re-pin to BUI truth. `motion` replaces CSS
transitions only where a primitive brings its own; the do-NOT-animate list (palette instant, no drag
animation) still governs. Never touch `~/Realm` or user CLI config; scratch homes; don't kill the user's
dev server (5173/8787).
