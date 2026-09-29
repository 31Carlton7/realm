# Laya's benchmark

Real iOS screens, and labelled steps on them, for scoring a Laya checkpoint on the three questions
Realm asks it (`apps/server/src/laya/shadow.ts`). Every evaluation report (`eval.json`) is computed
on the `heldout` split of this directory and names its `version`.

## What is here

- `benchmark.json` — the version, the apps, how cases were split, and counts.
- `screens/<id>.json` — one accessibility-tree read: `{ id, app, from, elements }`, each element
  `{ id, role, label, value?, frame? }` with `id` the element's path in the tree, as realm-simulator
  numbers it, and `frame` `[x, y, width, height]` in points. Status-bar elements are kept: they are on
  every screen an agent sees.
- `pairs/<id>.json` — one step really taken: `{ id, app, tool, action, target?, before, after }`, the
  screen read just before the step and about 2.5 s after it.
- `cases/target.jsonl` — `{ id, split, app, screen, element, alsoRight?, intent, copies }`: on `screen`,
  an agent that wants `intent` taps `element` (or one of `alsoRight`, the same thing drawn twice).
  `copies` is true when the intent repeats a word of the element's label; those are the cases a walk
  resolves without asking Laya. Only labelled elements are targets: Assist never offers another.
- `cases/sensitive.jsonl` — `{ id, split, app, screen, element, tool, intent, sensitive, part }`: is the
  step sensitive, and if so which of the four things it does (`money`, `delete`, `send`, `secret`).
- `cases/verify.jsonl` — `{ id, split, app, pair, tool, intent, achieved, kind }`: did the step in
  `pair` do what `intent` says it was for, and if not, how it failed (`no-change`, `alert`,
  `wrong-screen`, `interrupted`, `confirm`, `partial`).

## How it was made

1. **Crawled on a simulator** (iPhone 17 Pro Max, iOS 27, 2026-09-29) with
   `apps/server/scripts/laya/sim.mjs`: 19 of the apps a fresh simulator ships (Settings — about forty
   panes — Safari, Maps, Calendar, Contacts, Messages, Photos, Files, Reminders, Shortcuts, Health,
   Wallet, Passwords, News, Fitness, Watch, Remote, Preview, the Home Screen), read through
   serve-sim's `/helper/<udid>/ax` and flattened the way realm-simulator flattens it. Every pair is a
   step that was really performed, including the ones that went wrong on their own: a tap that hit a
   floating search bar, a list that would not scroll, an Apple Pay error, a sign-in that failed.
   Only what iOS draws on a fresh simulator is kept; the reviews on a map card, the day's headlines
   and the one third-party app on the device were dropped (`scripts/laya/bench/screens.ts`).
2. **Labelled by hand** in `apps/server/scripts/laya/bench/{target,sensitive,verify}.ts`. A case went
   in only if a careful person looking at the screen would answer it one way; ambiguous ones were
   dropped rather than guessed. Most `target` intents do not repeat the label ("pair my AirPods",
   "SFMOMA", "VO2 max") because those are the only ones Laya is asked in a walk. `sensitive` is the
   four parts and nothing else, weighted to hard cases both ways (opening the Passwords pane,
   Recently Deleted, clearing a search field are not; a trial that renews at a price, a code typed
   into a chat are). Some `wrong-screen` verify cases reuse a real step with a goal it did not meet.
3. **Split** by `scripts/laya/bench-build.ts`: five apps are held out whole (Maps, Health, Contacts,
   Files, Passwords) and two kept whole for validation (Reminders, Watch); of every other app's cases
   15% are held out and 12% go to validation, by a stable hash of the case, so a rebuild never moves
   a case. Training data is generated only from `train` screens and never repeats a held-out or
   validation intent. Thresholds and temperatures are fitted on `train`, choices between runs are
   made on `validation`, and `heldout` is only ever reported.

Rebuild after changing a case: `pnpm --filter @realm/server exec tsx scripts/laya/bench-build.ts <crawl dir>`
(it needs the crawl it was built from, kept outside the repo) and bump `BENCHMARK_VERSION` in
`apps/server/src/laya/benchmark.ts` whenever a case changes, so reports from before and after are not
compared as if they were one benchmark.
