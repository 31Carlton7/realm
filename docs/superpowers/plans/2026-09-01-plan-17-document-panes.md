# Realm Plan 17 — Document panes: docs, sheets, slides, LaTeX

> Numbered 17: 16 is search-and-forks. This plan finally builds the **artifact pane** the v1 design has
> reserved since `2026-08-17-realm-v1-design.md` §5 ("renders Markdown, HTML, images, PDF, CSV/table …
> live-reloads on change") — upgraded from a renderer into four real editors, and given the agentic
> half the original spec only sketched.
>
> **Three user decisions, settled before writing:** (1) documents are **plain text files**, exported to
> Office formats on demand — not an Office round-trip and not a rich SQLite model; (2) tabs live
> **inside the document pane only**, so Plan 4's one-item-per-leaf layout survives intact; (3) LaTeX
> compiles with **tectonic**, installed on first use.

## The shape of it

One new item kind, `documents`. Its pane is a **document workspace**: a tab strip over N open files, each
rendered by the editor its extension selects. It behaves like every other item — it lives in a leaf, it
splits with `⌘\`, it drags between panels, it appears once in the sidebar. The tabs are *inside* it.

```
┌ PanelBar   [icon] Documents · realm-worktrees/api      [status] [⋯] [×] ┐
├────────────────────────────────────────────────────────────────────────┤
│ [ Report.md ×][ q3.csv ×][ deck.md ×][ paper.tex ●×]              [+]  │  ← tab strip
├────────────────────────────────────────────────────────────────────────┤
│ [B] [I] [H1▾] [•] [link]                              [source | rich]  │  ← per-type toolbar
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│                        editor surface                                  │
│                                                                        │
├────────────────────────────────────────────────────────────────────────┤
│ Saved · 2 min ago            ⟳ Claude edited this file                 │  ← status strip
└────────────────────────────────────────────────────────────────────────┘
```

### Why this is the right architecture, and not the alternatives

**Files, not a document database.** Every editor is a *view over a text file on disk*. This is the load-
bearing decision and everything good downstream follows from it: agents already edit these files with the
`Read`/`Write`/`Edit` tools they ship with, so "agentically modify the document" needs **no new tool
surface at all**. The diff pane shows document changes for free. Checkpoints snapshot and restore them for
free. Git tracks them for free. A rich in-SQLite model would have forfeited all four and required a
bespoke MCP toolset before an agent could change a single word.

| Type   | On disk                                      | Editor                          |
|--------|----------------------------------------------|---------------------------------|
| Docs   | Markdown (`.md`)                              | TipTap/ProseMirror WYSIWYG ⇄ source ✅ |
| Sheets | CSV/TSV, formulas stored as text (`=SUM(A1:A5)`) | react-datasheet-grid + MIT formula engine ✅ |
| Slides | Marp Markdown (`---`-separated)               | source ⇄ live deck + filmstrip  |
| LaTeX  | `.tex`                                        | CodeMirror 6 + tectonic → PDF   |

The cost is honest and should be stated: text can't hold arbitrary positioning or deep styling. A Marp deck
is not Keynote; a CSV is not a formatted Excel workbook. Presentation-only metadata (column widths, number
formats, slide theme) goes in an **ignorable sidecar** (`.q3.csv.meta.json`) so the canonical file stays
clean and diffable, and any consumer that ignores the sidecar still gets a correct document. Export to
`.docx`/`.xlsx`/`.pptx`/`.pdf` is a command, not a save format.

**Tabs inside the pane, not on every leaf.** Plan 4 removed `{tabs, activeTab}` from layout leaves
deliberately and ships a migration that collapses legacy ones. Reintroducing tabs at the layout level would
mean rewriting the layout contract, the store's open/close/drop ops, and the sidebar's OPEN/SPACE grouping —
re-litigating a settled decision. It is also the wrong concept: layout tabs would stack *sessions*, while
what the user asked for is stacking *files within one workspace*. A pane-local tab strip is a different
thing that happens to share a name. Reading across two documents at once is still served — the item splits
like any other, and two `documents` items on the same environment can hold different tabs.

**Rooted at an environment, like the diff pane.** The item's `refId` is an **environment id**, not a session
id — the precedent `diff` already set (`entities.ts:43`). A document workspace is a view of a checkout, and
several sessions sharing that checkout share its documents. Spaces without a repo use their primary
environment, which is the space folder. This is what makes the per-session gesture work: a `documents`
button in the session's PanelBar, sitting next to the existing diff and terminal buttons, opens the pane
for *that session's* environment — the exact `SessionDiffButton` pattern (`SessionPane.tsx:49`).

**DOM, not a native view.** The browser pane's `WebContentsView` forced the no-overlay invariant (nothing
may paint over its rectangle), which is why its PanelBar has no dropdown menu. Document editors are ordinary
DOM, so they inherit none of that: menus, the palette and sheets may open over them freely, and the pane
keeps its normal `⋯` menu.

## W1 — The substrate  ✅ built (2026-09-01)

The half that has no UI and carries all the risk. **Four amendments the build made to this plan**, each
because the code disagreed with the design:

1. **No `chokidar`.** Watching is `node:fs.watch` on parent directories — no new dependency, which suits
   a server whose dependency list carries a justification comment per entry.
2. **The reason for directory-watching is not the one this plan gave.** The plan said a file-bound
   watch goes deaf after an atomic temp-file-plus-rename save. Measured on macOS, that is false —
   `fs.watch` is path-based here and still reports. What a file-bound watch really does not survive is
   **delete-then-recreate**: it reports the deletion and then goes permanently silent, including for
   every later edit. `git checkout` across a branch that lacks the file, `git stash`, and any agent
   that rewrites rather than edits in place all produce exactly that. The test that pins this is
   `keeps reporting after the file is deleted and recreated`; the atomic-rename test alone did **not**
   kill the file-bound mutant.
3. **`environmentId` is optional on `documents.create`.** Environments are created lazily
   (`ensurePrimary`), so a space that has never run a session has none — and "open Documents" from the
   sidebar has to work there. Omitted, the server roots the workspace at the primary checkout.
4. **`documents.detach`.** Closing a pane is layout-only (Plan 4), so the tab strip must outlive it
   while the filesystem watches must not. Without this, every pane ever opened leaks a watcher.

Shipped: contracts (`documents` item kind, `DocumentWorkspaceSchema`, the extension→editor classifier),
migration v17, `DocumentsStore`, `DocumentService`, the path guard, the file layer, the watcher, the RPC
surface, the renderer pane with its tab strip and conflict UI, and the session PanelBar button.
**87 tests** across seven files (contracts 11, paths 10, files 14, watcher 13, service 14, buffers 14,
pane 11); the three watcher mutants below were each written, run, and confirmed to fail the suite before
being reverted. Repo-wide: 2640 passing, `pnpm -r typecheck` and `pnpm build` both clean.

- **`documents` item kind** added to `ItemKindSchema`; `DocumentWorkspaceSchema` row mirroring
  `BrowserSchema`'s precedent — `{id, spaceId, environmentId, openPaths: string[], activePath}` — so a
  restart restores the open tabs. `registerPane("documents", DocumentsPane)`.
- **Buffer manager**: open → read → text; dirty tracking; debounced autosave; close. One buffer per path,
  shared if the same file is open in two panes.
- **File watching — new infrastructure.** Nothing in the repo watched files before this (verified: no
  `chokidar`, no `fs.watch` in `apps/server` or `apps/desktop`). The server watches the parent directories
  of open documents with `node:fs.watch` and pushes changes to the renderer, so an agent's edit lands in
  the open editor live.
- **The write/watch loop, and how it is broken.** Realm's own saves must not read back as external changes.
  Every save records `(mtime, sha256)` before emitting; the watcher drops events matching the last recorded
  pair. This is the single most mutation-prone piece in the plan — see the mutants below.
- **Conflict policy** (VS Code's, because users already know it):
  - clean buffer + external change → reload silently, preserving cursor and scroll;
  - dirty buffer + external change → **never clobber**; a status-strip bar offers *Keep mine* / *Take
    theirs* / *Show diff*;
  - deleted underneath → the tab goes stale-but-open, save re-creates.

**Mutants that must die** — all three run against the built watcher, all three killed:

| Mutant | Killed by |
|---|---|
| Track the last *written* hash instead of the last *known* one | `reports a change back to content Realm previously wrote` |
| Drop the content comparison (the "mtime-ish" filter) | 5 tests, incl. `stays silent for content Realm wrote itself` |
| Bind the watch to the file instead of its directory | `keeps reporting after the file is deleted and recreated` |

The third initially **survived** — see amendment 2 above. The dirty-buffer branch falling through to
reload (which destroys the user's unsaved paragraph) is covered on the renderer side by
`never overwrites unsaved text; it raises a conflict instead`.

W1 ships **one** editor — Markdown source with live preview, reusing the existing sanitized `Markdown`
component — as the cheapest proof the substrate is real. W2–W5 replace it behind the same seam.

A conflict is returned as a typed `{ ok: false, currentText, currentHash }` result rather than thrown:
errors have nowhere to put a payload, and the pane needs the other side's text to offer *keep mine* /
*take theirs* / *diff* without a second round trip.

## W2 — Docs  ✅ built (2026-09-01)

TipTap/ProseMirror (MIT) WYSIWYG over Markdown, with a Rich/Source toggle. Headings, bold/italic/strike,
inline code, lists, quotes, code blocks, links, images.

**The plan's mitigation for round-trip fidelity was measured, and it was not enough.** This plan called
for "one canonical serializer" plus an idempotency property test. Both were built — and re-serializing
this repository's own 31 markdown documents still rewrote **72% of their lines**. Escaping turned every
`- [ ]` task item into `- \[ \]`, block spacing shifted, and any document you opened and touched once
would have come back as a whole-file diff. A canonical serializer is necessary and nowhere near
sufficient.

What actually works is **block-level source preservation**, and it exploits something already true of
the editor: ProseMirror nodes are persistent, so a transaction creates new node objects only for what
changed and reuses the objects for everything else. Object identity is therefore already an exact record
of "did the user touch this block". Each top-level block's original source is recorded in a `WeakMap`
keyed by its node, and the serializer hands those bytes back untouched; only genuinely edited blocks go
through canonical serialization at all.

Measured after: **0 of 12,940 lines changed (0.0%)** across the same corpus, byte-for-byte. Mutating the
preservation lookup away puts it straight back to 72.2% and fails 5 tests, so the mechanism is pinned.

Three further things the build found that the plan did not anticipate:

- **`softbreak` is the highest-stakes token in the format** (1146 occurrences in this repo's docs). The
  obvious mapping is a space, which silently rejoins prose wrapped at 100 columns into single long lines.
  Kept as a literal newline instead. Found by counting token types across real documents, not by reading
  the CommonMark spec.
- **StarterKit has no table and no image node.** A naive parse deletes both on first save. Everything
  the schema cannot hold — tables, HTML blocks, front-matter, link reference definitions (which emit *no
  tokens at all* and would vanish without trace) — is captured as a `rawBlock` and written back verbatim.
- **Two silent-failure bugs, each found only by a mutation run.** TipTap's `Image` node defaults to
  `inline: false`, so images parsed into an empty paragraph — invisible while source preservation was
  masking the fallback path. And TipTap builds its *own* `Schema` instance, so nodes parsed against the
  module's schema were rejected and the editor rendered blank; the parser is now built per-schema and
  cached. Neither surfaced as an error, only as missing content.

Bundle weight is handled as the plan required: the editor is a dynamic `import()`, so TipTap lands in a
**separate 1,277 kB chunk** and the main bundle grew by 3.4 kB. A workspace showing a `.csv` or `.tex`
never loads it.

**64 tests** across three files (markdown model 37, buffers 14, pane 13), including a corpus test over
every markdown file in this repository that asserts idempotency, no lost tables/fences/headings, and
reports round-trip churn so a regression is visible rather than silent.

## Live verification of W1+W2+W3  ✅ (2026-09-01)

`apps/desktop/scripts/documents-pane-live.mjs` — the same discipline as `no-overlay-live.mjs`, which it
copies structurally: boots the REAL built app on a scratch `REALM_HOME` with CDP open, drives the
renderer, asserts against the real filesystem, and screenshots for the human verdict. It defaults to
ports 9333/8899 so it runs BESIDE a developer's own Realm (which holds 9223/8788) instead of contending
with it. Sixteen checks: palette → pane, picker → rich editor, autosave to the real file, outside-edit
live reload, the conflict bar + Keep-mine winning the disk, a second tab, and the sheet section — the
grid mounts, cells typed through real CDP mouse events, `=A1+A2` computes to 350 on screen while the
file keeps the formula as text, zero renderer console errors.

It caught **three bugs the 2679-test suite could not see**, which is the argument for its existence:

1. **The pane was unreachable.** The only trigger was the session PanelBar button, gated on a loaded
   environment — a fresh space had no way in. Fixed with a palette entry, deliberately labelled
   "Documents" not "New documents": the server dedupes one workspace per environment, so the entry is
   an open-or-focus and "New" would promise a second pane it never creates.
2. **The rich editor crashed the whole pane in the production build.** Under React 19, TipTap's
   `useEditor` destroys and recreates the editor across a commit, and the sync effect still fired once
   against the STALE instance — whose `schema` getter returns null after destroy. jsdom's lifecycle
   never hits this. The throw unmounted the entire pane. Fix: an `isDestroyed` guard, load-bearing and
   commented as such.
3. **The pane floated at content width in half its panel.** `.pane-slot` is a flex row and
   `.documents-pane` never claimed `flex: 1` — invisible to every DOM assertion, obvious in the
   screenshot.

## W3 — Sheets  ✅ built (2026-09-01)

**Amendment: the grid is `react-datasheet-grid`, not Glide.** Decided by the dependency data, not
preference: Glide's peer range stops at React 18 (this repo is on 19) and demands `lodash`, `marked@4`
(conflicting with the repo's `marked@18`) and `react-responsive-carousel`. Under the 2 MiB document
ceiling the DOM grid's virtualization is ample — and being DOM is what let the live check drive it with
real clicks. The formula engine is `fast-formula-parser` (MIT; transitive deps checked, `jstat`'s legacy
`licenses` field is MIT), whose API was probed before writing: 1-based coordinates, evaluation errors
RETURNED as `FormulaError`, parse failures THROWN.

Architecture as planned, with W2's proven trick applied one level down:

- **`csv-model.ts`** — parse/serialize with **row-level source preservation**: every row remembers its
  exact source text and gives it back verbatim; only edited rows re-serialize canonically. Another
  author's quote-everything style survives on every line you didn't touch. papaparse does cell parsing;
  a 20-line quote-state scanner does record accounting — and when the two disagree on record count
  (probed: `"a"x,b\n` recovers differently in each), preservation is dropped for the whole file rather
  than risk attaching row N's bytes to row N+1. `trailingNewline` means "the last record was
  terminated", not "ends with \n" — an unterminated quote can swallow the final newline into a cell,
  and double-counting it grew the file a byte per save (caught by test).
- **`formulas.ts`** — memoized recursion, not a dependency graph: resolving a reference recursively
  evaluates that cell through the same memo, so a whole-sheet pass is one traversal and the size cap
  keeps recompute-per-edit cheap. On cycle detection every cell on the in-flight stack is marked
  `#CYCLE!` at once — marking only the closer would leave the rest recursing forever.
- Formulas live in the file as literal text; computed values never do — **proven in the live check**:
  the on-disk file reads `100,=A1+A2,C` while the screen shows 350. That property is why `sheet_eval`
  (W6) exists.

**Three bugs only the live check caught** (the jsdom grid renders zero cells — virtualization needs real
layout, so the pure models carry the logic tests and the live driver carries interaction):

1. **Commit-on-blur lost edits.** The grid exits edit mode on an outside click by UNMOUNTING the cell
   input, and React fires no blur on unmount — typed text vanished. Now controlled, committing per
   keystroke (the library's own textColumn pattern).
2. **A local Enter handler double-advanced.** The grid's document-level listener also processes Enter
   while editing; calling `stopEditing` too stepped the active cell twice — off the end of the data —
   and the grid scrolled a phantom selection into view, hiding row 1. The grid owns Enter/Escape/Tab.
3. **Theming + sizing were invisible to DOM assertions.** The library's `className` lands on a wrapper
   (so a compound selector re-skin matched nothing and the grid rendered light-on-dark), and it sizes
   from a `height` PROP, not CSS — both obvious only in the screenshot.

v1 remains one sheet per file; a workbook is a folder of CSVs, and `.xlsx` export (via `exceljs`, MIT —
**not** the stale `xlsx@0.18.5` on npm) merges them (W7).

**Licensing was a live trap and drove the picks**, as this plan predicted: `hyperformula` is
**GPL-3.0-only** and `handsontable` ships a **commercial licence** — both verified against the registry
2026-09-01 and unusable in a signed, distributed product.

## W4 — Slides

`@marp-team/marp-core` (MIT) renders Markdown to styled HTML slides. Split view: source on the left, live
deck on the right, thumbnail filmstrip along the bottom for navigation. Full-screen presenter mode with
notes and next-slide preview. Export to `.pptx` (`pptxgenjs`, MIT) and PDF.

Because a deck is just Markdown, an agent restructuring a presentation is an ordinary text edit — the same
capability that makes the docs editor work, applied to slides.

## W5 — LaTeX

The pillar most exposed to "does this actually work", so it was **verified live before planning**
(2026-09-01, this machine):

- `tectonic` compiles a document with `amsmath` in **1.4s cold** — including fetching missing Type-1 fonts —
  and **0.17s warm**. Live preview on a typing debounce is therefore genuinely viable, not aspirational.
- `--synctex` emits `t.synctex.gz` alongside the PDF. **This is what makes it feel like the OpenAI LaTeX
  tool**: click a paragraph in the PDF to land on its source line, and vice versa. Without SyncTeX it is
  merely two panes that happen to sit beside each other.

Editor is CodeMirror 6 with the `stex` mode from `@codemirror/legacy-modes` (MIT) — note that
`codemirror-lang-latex` is **AGPL-3.0-or-later** and must not be used. Preview renders through
`pdfjs-dist` (Apache-2.0) to a canvas, which keeps full control of highlighting and avoids relying on
Chromium's PDF plugin. Tectonic's log is parsed into a structured error panel with clickable line numbers.

Tectonic is a system binary (~30 MB), installed on first use rather than bundled — the DMG stays small.
When it is absent and installation is declined, the pane degrades to source editing plus KaTeX math preview
with an explicit, non-nagging CTA. It must never present as broken.

## W6 — The agentic half

Content editing needs nothing new: agents change documents with `Read`/`Write`/`Edit`, and W1's watcher
puts the result on screen live. What the files *cannot* express is the pane itself, so a small
`realm-docs` provider mounts on the MCP gateway exactly as `realm-browser` does — in-process
`RealmToolProvider`, one endpoint every agent already reaches, per-space off switch, existing ApprovalCard
permission flow.

Deliberately small; anything a file edit can do is not a tool here:

- `docs_open(path)` — surface a document in the user's pane ("look at this").
- `docs_selection()` — what the user currently has selected. This is the tool that makes *"tighten this
  paragraph"* work, and it has no file-based equivalent.
- `sheet_eval(path, range)` — computed values, since the CSV holds only formula text.
- `latex_compile(path)` — structured errors rather than raw log scraping.
- `docs_export(path, format)`.

Closing the loop in the UI: the open document and the current selection become `@`-mentionable in the
prompter (the mentions system already exists), and a tab whose file an agent changed while you were looking
elsewhere carries an **agent-edit badge** until you visit it. That badge is the whole story of this plan in
one affordance — you can watch an agent rewrite a document you are holding open.

## W7 — Export and live verification

Export to `.docx` (`docx`, MIT), `.xlsx` (`exceljs`), `.pptx` (`pptxgenjs`), PDF. Then real documents, not
fixtures: a long Markdown report, a sheet with cross-referencing formulas, a deck presented full-screen,
and a LaTeX paper with a bibliography — each edited by hand *and* by an agent, concurrently, with the
conflict policy driven through every branch.

## Risks

- **Bundle weight.** CodeMirror + TipTap + Glide + Marp + pdf.js is a lot of JavaScript. Every editor is a
  dynamic `import()` keyed on file type, so opening a `.md` never loads the spreadsheet or PDF stacks.
- **Markdown round-trip noise** — solved by block-level source preservation, not by the canonical
  serializer this plan originally relied on; the corpus churn report is the standing guard (W2).
- **Watcher/save feedback loop** — W1's hash-tagged self-writes; the mutants above are the test list.
- **Large CSVs** — the grid virtualises; parsing is the real cost, so it streams.
- **Licence drift** — the MIT/Apache picks here are deliberate and two near-misses are GPL/commercial.
  Any substitution needs re-checking, not assuming.

## Out of scope

Real-time multi-user collaboration and presence (the `y-prosemirror` seam exists if it is ever wanted);
Office round-trip as a *save* format; arbitrary freeform slide positioning; PDF annotation; a full
filesystem tree (the pane opens documents, it is not a file manager).

## Relationship to the reserved `artifact` kind

`artifact` stays reserved. Once this pane exists, the v1 spec's `artifact.publish(path|content, title)`
becomes a one-line call into it — publish writes the file and opens a tab — rather than a second, parallel
rendering surface. That unification is a follow-up, not this plan.
