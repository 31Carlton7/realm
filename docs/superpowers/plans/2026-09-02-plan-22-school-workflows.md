# Realm Plan 22 — School workflows: guides, lectures, the Plynn handoff

> Numbered 22: 21 is the visual editor's mobile half. Built 2026-09-02 on `integration/v0.4`, on top
> of Plan 17's document panes — which is what made it small: every artefact here is a **file** the
> Documents pane already shows live, and the agents already edit with their own tools.
>
> **What the user asked for** (brainstorm, 2026-09-02): interactive HTML study guides — "very
> helpful for EE 451 studying" — and a way to take notes in class, with Plynn's meeting recorder as
> the transcript source. Harder for a course like EE 457 (whiteboard, Verilog) but wanted anyway.

## The shape of it

Three loops, all on the Documents pane and the space folder:

```
  guides/<topic>.html        ← study-guide skill writes; pane renders (sandboxed frame); runtime records quiz results
  guides/.<topic>.html.progress.json   ← the sidecar the runtime's attempts land in; docs_progress reads it
  lectures/YYYY-MM-DD-<topic>.md       ← "New lecture…" creates; the user types; a session answers; "Wrap up" rewrites
  lectures/<date>-<title>.md (source: plynn)   ← "Import recording from Plynn…" copies Plynn's export here
  slides/*.pdf                         ← previewed in the pane; text searchable through docs_search
```

**Files, not rows** — Plan 17's load-bearing decision, kept. A lecture is a Markdown file with
front-matter; a guide is one HTML file; progress is a JSON sidecar. No new table, no migration. The
one new persistent thing is a settings row (`plynn.imported`), the CLI import's own pattern.

## W1 — Guide previews  ✅

**The problem was CSP, not rendering.** A `srcdoc`/`blob:`/`data:` frame inherits the renderer's
policy — `script-src 'self'` — which forbids the inline script every self-contained guide is made
of. So the server gained a **loopback preview listener** (`documents/preview.ts`): the pane frames
`http://127.0.0.1:<port>/p/<token>/<documentsId>/<path>`, and the response carries its own strict
policy (`script-src 'self' 'unsafe-inline'`, `connect-src 'none'`, no forms). The frame is
`sandbox`ed without `allow-same-origin`, so the guide's origin is opaque. The token is per boot and
a path segment, so a guide's relative `<img src>` resolves under the same prefix. `documentsId` maps
to a checkout through the same `resolveInRoot` guard the RPC uses. The renderer CSP's `frame-src`
went from `'none'` to `http://127.0.0.1:*`.

**The runtime is injected, not linked** (`documents/guide-runtime.ts`, string constants in the
bundle): every served `.html` gets the stylesheet and `guide.js`; KaTeX (vendored, `katex` on the
server's dependencies) only when the document opts in with `<meta name="realm-helpers"
content="katex">`. A guide opened in any other browser is a plain readable page. The runtime wires
`rg-quiz` (multiple choice by letter/index/list, short answer with `|` alternatives, explanations,
score, retake), `rg-steps` (Prev/Next, ←/→), `rg-flashcards` (flip), `details.rg-reveal`, auto-
renders math, and bridges progress: `realm-guide:ready`/`realm-guide:attempt` out, `realm-guide:
progress` in. `window.Realm.attempt(topic, correct, total)` for custom exercises.

**Progress lives in a sidecar** (`.<name>.html.progress.json`, hidden from the picker), folded by
`recordGuideAttempt` in contracts (pure; history capped at 50 attempts; `best`/`last` derived on
write). The pane records over RPC because an opaque origin has no storage of its own. Realm's own
sidecar write is hash-noted so it never echoes as an external change.

Two new document kinds: `html` (Preview ⇄ Source; the frame re-versions on the disk hash, so an
agent's rewrite re-renders through the existing watcher) and `pdf` (preview-only, no text read, no
sandbox — Chromium's viewer does not run sandboxed; the bytes are Realm's own).

**Found only by the live check**: the built server bundle failed to load — `preview.ts` imported
`createRequire` from `node:module`, and tsup's banner already declares that exact import for the
CJS deps it inlines. A second top-level declaration is a SyntaxError in the built ESM that no
source-level test can see. Fixed with `process.getBuiltinModule("node:module")`.

## W2 — The agentic half: `realm-docs`  ✅

Plan 17 W6's rule, kept: anything a file edit can do is not a tool. Four tools on a gateway
provider (`documents/agent-tools.ts`), per-space off switch like `realm-browser`:

- `docs_search(query, dir?, limit?)` — every file in the space folder mentioning every word, ranked,
  with snippets. **Live, not indexed** (the global search's own stance for user-edited files), over
  a walk that skips hidden and build folders (cap 3000 files, depth 8). PDF text through pdf.js's
  legacy build in Node — real for text-based decks, empty for scans (which still match by filename)
  — memoized on `(path, size, mtime)` and bounded. Scoring is occurrences (log-damped) plus a path
  bonus, divided by a length term so a textbook does not win every query.
- `docs_list(dir?)`, `docs_open(path)` (→ `documents.openPath`), `docs_progress(path)` (sidecar summary + weak topics).

## W3 — Lectures  ✅

`lectures.start` writes `lectures/YYYY-MM-DD-<slug>.md` from a template (front-matter `course`,
`title`, `date`; sections Notes / Questions / Follow-ups; numbered suffix rather than overwrite) and
hands it to `documents.openPath`, the one "put this file on screen" call — the server puts the path
on the workspace's tab strip and broadcasts `documents.openRequested`; a mounted pane opens the
tab, and the store brings the item in beside the focused pane *quietly* (no focus steal, the
browser-agent idiom) unless it is already on screen.

The store's `startLecture(title)`: a new pane group named `<topic> · <date>`, the notes pane in
its empty leaf, a session beside it. Nothing is sent — a lecture starts quiet. `wrapUpLecture` opens
a session beside and sends `lectureWrapUpPrompt` (contracts; no `@`-mentions, by `mentions.ts`'s
rule): read, `docs_search` to connect, rewrite Notes, answer Questions in place, Follow-ups as a
checklist, append Flashcards, build/extend the guide, `docs_open` it, five-line reply.

Palette: **New lecture…**, **Wrap up a lecture…**, **Import recording from Plynn…** — sheets, since
each needs one input the palette cannot take inline.

## W4 — The Plynn handoff  ✅

Plynn's meeting mode already writes one Markdown file per recording (`<yyyy-MM-dd HH.mm> <title>.md`:
summary, a rule, `## Transcript`) to its Application Support `Meetings/` folder. **That file is the
interface.** Realm lists the folder, copies chosen files under `lectures/` with a front-matter
header naming the source, remembers imports by path, and never opens Plynn's SQLite store (a
private format that moves with the app) or writes its folder. Paths outside the folder are refused
server-side — the RPC takes absolute paths back from `list`, and that must not become "copy any
file into the space". `REALM_PLYNN_MEETINGS_DIR` overrides the folder for tests and live checks.

**There is no live transcript, and this plan does not fake one.** Plynn writes at stop. The notes
file during class is what the user types; the transcript joins afterwards. The follow-up that would
change this is a Plynn change (periodically `updateMeeting(transcript:)` plus a rewrite of the
Markdown file); this importer would pick it up unchanged because it re-reads the file on import.

## W5 — Skills and verification  ✅

`skills/study-guide/SKILL.md` teaches the markup contract, the no-network rule, one quiz per
concept with stable `data-topic` slugs, step-throughs for procedures, flashcards, a sources
footer, `docs_search` before writing and `docs_open` after. `skills/lecture-notes/SKILL.md`
teaches the in-class stance (answer briefly, cite by path, do not rewrite while the user types)
and the wrap-up sequence. Both install on first boot like `mac`.

Tests: contracts (kinds, template, slugify, progress fold, lecture/Plynn parsing, prompt);
server (preview routes/CSP/injection/traversal/KaTeX, extraction incl. a hand-built PDF through
real pdf.js, walk/rank/scope, provider, `openPath`/progress RPCs, lecture and Plynn RPCs against
`createApp`); renderer (store actions, sheets, pane preview + bridge + open requests, palette).
`apps/desktop/scripts/school-live.mjs` boots the built app: New lecture → group + notes + session;
Guide → frame loads from the preview server; a **real CDP click inside the sandboxed frame** grades
the quiz and the sidecar appears on disk; PDF preview; Plynn import through the sheet.

## Out of scope, deliberately

- A per-space **tutor mode** (Socratic system-prompt append). Cheap, wanted, not in this ask.
- **Course-space templates / semester rollover**. The lecture and guide conventions are what a
  template would seed; the template itself is a later, small plan.
- **Scheduled review sessions** (spaced repetition) — wants durable runs on a timer.
- OCR for scanned decks; lecture-photo ingestion beyond dropping files into the folder.
