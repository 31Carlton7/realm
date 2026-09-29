# Laya, local, on every computer and device step

Status: design for Phase 1 (build now) and Phase 2 (after data). 2026-09-29.

## What was asked, and what was measured

The user wants every computer-use and mobile (simulator/device) step to use **Laya** — Convai's
open-weight System One decision model — running **entirely locally** (so not TypeSafe's Jev, which
is hosted-only). "Our own version of TapKit" is Realm's `realm-simulator` provider (PR #78), which
should reach TapKit's tool parity and use Laya too.

Measured on this Mac (M-series, MPS, `laya` 0.3.21, torch 2.14), on hand-labelled iOS screens:

| decision | base `laya` | `laya-typed-decisions` |
|---|---|---|
| target — which listed element matches the goal (28) | 61% | 71% |
| sensitive — is the step sensitive / hard to undo (16) | 56% (missed 7 of 8 sensitive) | 56% |
| verify — did the screen change as intended (10) | 40% | 40% |
| confidence right vs wrong | 0.61 / 0.54 | 0.23 / 0.16 |
| warm latency p50 | 35 ms | 64 ms |

Untrained, Laya cannot decide or even advise: its confidence does not separate right from wrong, and
advice that calls "Buy $4.99" not-sensitive is worse than none. So it runs in **shadow** first —
asked on every step, never shown to the agent or the user, never altering an action — and its
answers are logged next to what actually happened. That log is the training set; Laya earns the
right to decide (**assist**) only by passing a measured bar on held-out data from this Mac.

## Phase 1 (now)

### A. `realm-simulator` input tools — TapKit parity
TapKit: `screenshot, tap, double_tap, triple_tap, long_press, flick, drag, hold_and_drag, type_text,
press_key, press_home`. `realm-simulator` already has list/open/screenshot/elements/apps/install/
launch/open_url; it lacks input. Add:
- `simulator_tap`, `simulator_double_tap`, `simulator_long_press` (duration), `simulator_swipe`
  (from→to or direction; covers flick/drag), `simulator_type` (text), `simulator_press`
  (home / lock / volume / a named key).
- Address by **element** (an id from `simulator_elements`, re-resolved against the LIVE tree at act
  time, like `realm-computer`'s index) or by **point** (device points). An element tap acts on the
  element's frame centre.
- Every input tool takes a short required `intent` ("open Wi-Fi settings") — shown wherever the step
  is shown, and the label source for Laya's training data.
- iOS: a server-side client of the same serve-sim input channel the pane uses (the frame builders in
  `panes/simulator/sim-input.ts` are pure — move them where both sides can import them).
  Android: `adb shell input` (tap/swipe/text/keyevent).
- Permission: the existing broker, one card per device per session (not per tap), following
  `realm-computer`'s per-application card; Plan/Ask refuse.

### B. `LayaService` — the local runtime, managed by Realm
- Runtime: official `laya[serve]==0.3.21` in a Realm-managed venv at `<REALM_HOME>/laya/venv`, created
  from a Python 3.10–3.13 arm64 interpreter found on the machine (or a clear "Needs Python 3.10+"
  state — never a guess). Checkpoint cached at `<REALM_HOME>/laya/hf` (`HF_HOME`).
- Process: `laya-serve` bound to **127.0.0.1** on a Realm-chosen free port (verify the host/port
  flags; never 0.0.0.0), `LAYA_DEVICE=mps` when available, `LAYA_PRELOAD=1`. Health-checked,
  restarted with backoff, stopped on quit. Client uses `/predict` (or `/v1/systemone`), with a short
  timeout.
- States for Settings: off · not installed · installing (progress) · ready (device, p50 latency) ·
  failed (the reason, verbatim) · needs Python. Install is an explicit user action (it downloads
  ~1 GB of PyTorch and ~0.8 GB of weights) — nothing downloads until asked.
- Tests use a fake Laya HTTP server; the suite never spawns Python.

### C. Shadow decisions
- One module providers call around each act: `beforeAct({surface, intent, elements, chosen})` and
  `afterAct({before, after})`. Fire-and-forget: never awaited by the action, never delays it, never
  changes its result, and silently skipped when Laya is not ready.
- Questions: `target` (choice over ≤20 candidates; candidate selection documented), `sensitive`
  (noul), and after the act `verify` (noul on before/after element summaries).
- Log: append-only JSONL at `<REALM_HOME>/laya/decisions.jsonl` (rotated), one row per step: surface,
  intent, candidates, Laya's answers + probabilities + latency + checkpoint, and the ground truth with
  its source — `target`: the element the agent actually addressed (`agent`); `sensitive`: the
  permission outcome + a keyword rule (`rule`/`user`); `verify`: from the next step (`heuristic`).
- Hooks: `realm-simulator` input tools and `realm-computer` acts.
- Privacy: local only; the log holds on-screen labels, so Settings says so and offers "Delete log".

### Settings
A "Laya (local decisions)" section: the state line, Install / Enable (Off · Shadow), device +
latency, steps logged, and — once Phase 2 exists — the last evaluation. Plain text states, per
design.md's "say what actually happened".

## Phase 2 (after enough data)
- `eval`: accuracy/ECE per question type on the log (held-out split); shown in Settings.
- `fine-tune`: the official RLCD recipe adapted for MPS, on the log plus a synthetic bootstrap built
  from real simulator accessibility trees; outputs `<REALM_HOME>/laya/checkpoints/<date>`.
- **Assist** unlocks only when the local checkpoint clears the bar (target ≥ 95%; sensitive recall
  ≥ 99%): input tools may then take `target: "<description>"` and Laya resolves it above a
  calibrated threshold, else returns candidates to the agent.
- Later: `realm-browser` gets the same shadow hooks.

## Phase 2, as built (2026-09-29)

- **Benchmark** (`resources/laya/benchmark/`, README there): 109 screens and 181 real steps read off
  an iOS 27 simulator across 19 apps; 776 `target` cases (673 whose words share none with the
  element's label), 180 `sensitive` (82 sensitive), 198 `verify` (52 failures of six kinds). Maps,
  Health, Contacts, Files and Passwords are held out whole, Reminders and Watch kept for validation,
  and 15% / 12% of every other app's cases go to held-out / validation by a stable hash.
- **Eval** (`apps/server/src/laya/eval.ts`, harness `scripts/laya/eval.ts`): every question built by
  the shadow's own functions; `target` asked exactly as a walk's Assist asks it. Writes
  `LayaEvalReportSchema`, with the Assist threshold fitted on `train` (precision ≥ 0.98 over at least
  20 picks) and measured on held-out, plus the rule baselines and the not-copying subset.
- **Candidates** changed with it, for Assist only where marked: the walk no longer offers Laya the
  status bar; ties go to what can be tapped; with nothing chosen, no heading or group is offered.
- **Training** (`trainset.ts`, `training.ts`, `resources/laya/train.py`): questions generated from the
  train apps' screens and a hand-written lexicon (`resources/laya/lexicon.json`), never repeating a
  benchmark case, plus the user's log; Laya's RLCD recipe on MPS with the lower 12 encoder layers
  frozen; temperatures fitted on the benchmark's train split; the epoch best at validation `target`
  kept. `laya.train` runs it from Settings, scores the result on held-out through laya-serve, and
  makes it active only when it beats the active checkpoint there.
- **Result** (held-out, benchmark 2026-09-29.2): `target` 41.7% for the download, 46.7% for
  laya-typed-decisions, 63.0% for a checkpoint trained here (62.3% on the words that share nothing
  with the label; the Assist threshold it fitted on train, 0.978, held at 100% precision on 6.3% of
  held-out steps); `sensitive` recall 81.5% → 77.8–81.5% with precision 54% → 91%, against the
  keyword rule's 85.2%; `verify` 45.5% → 80.3%, level with the "changed and no alert" rule. p50
  about 42 ms either way. No checkpoint reaches the Assist bar of 95%; Assist stays locked and says
  so with the measured number.
