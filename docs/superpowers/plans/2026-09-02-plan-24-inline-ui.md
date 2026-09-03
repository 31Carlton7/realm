# Realm Plan 24 — Inline UI in the transcript

> Numbered 24: 23 (scoped downloads) is the highest on this branch. Renumber on landing if it
> collides with another session's in-flight plan.

> **Built (2026-09-02): W1, all of it.** W2 (below) is scoped and not built.

## Why

Realm's transcript is a well-designed frame around undesigned content. The frame — the enter
animation, the ledger row, the shimmer, the copy affordances, the surface ladder — got Plan 9's full
attention. What sits inside it did not: a tool call's input is `JSON.stringify(input, null, 2)` in a
`<pre>`, its result is the raw text in another one, and assistant prose is markdown with no
highlighting, no math and no admonitions. So the transcript's most-read surface is its least
designed one, and the reader does the parsing the app should have done.

The concrete failures, in the order they cost the most:

1. **An edit is approved sight unseen.** A permission card for `Edit` shows the tool's name, the
   path, and a `<details>` disclosure — shut — containing the JSON. The change itself is two string
   fields inside it. "Allow" on a change nobody has looked at is not consent, and it is the single
   hottest interaction in the app.
2. **The row's `+/−` counts were not diff counts.** `editStat` counted every line of an Edit's two
   fragments, so a one-line change inside twenty lines of context read `+20 −20`.
3. **No syntax highlighting anywhere** — not in fences, not in file previews.
4. **No math**, which the school spaces (lectures, study guides, `docs/`-backed course work) need
   more than the coding ones.
5. **A plan renders as JSON.** `TodoWrite` is how an agent states what it is doing; the transcript
   shows it as an array of objects.

## Reference

[aicss.dev](https://www.aicss.dev/components) — "copy-paste blocks for everything an agent shows
mid-conversation" — names the component set this is measured against. Realm already had Thinking
State, Streaming Text, Code Block, Approval Card and the Agent Input. It was missing **File Diff**,
**To-do List**, **Data Table** and the structured tool states. Those are what W1 adds, plus what the
list does not cover and Realm's tools need: a terminal, a numbered file preview, a grouped search
result, a web-request card, and math.

## The rule the whole plan runs on

**A view is drawn only where the payload actually supports it, and nothing is inferred that the
payload does not state.**

Every parser returns null on anything it does not *fully* understand, and null means "show the raw
well". This is not conservatism for its own sake — a half-parsed view silently drops the lines it did
not recognise, and a reader cannot see what is missing from a picture. It falls out into a set of
specific refusals, each of which is a test:

| Situation | What is NOT done | Why |
| --- | --- | --- |
| `Edit`'s `old_string`/`new_string` | No line numbers | A fragment's position in the file is unknown; a gutter counting from 1 would be read as file lines |
| Claude's `Bash` result | No exit code | It carries none. A green `exit 0` on a command that may have failed is an invented verdict |
| `Write` | No deletion count | It states the new contents and nothing about the old |
| An unlabelled code fence | No `highlightAuto` | A wrong guess reads as a different language and is indistinguishable from a right one |
| A search result with one unparsed line | No match list at all | Dropping a line from a search result is the one thing that must not happen |
| A 3-for-2 line replacement | No intra-line emphasis | There is no line-to-line correspondence to draw |

And its mirror: **copy always takes the raw payload**, whatever is drawn. What a reader pastes into a
shell or a bug report has to be what the tool was handed, not a transcription of Realm's picture of
it.

## W1 — what was built

**`rich/diff.ts`** — the diff model. An LCS line diff (prefix/suffix-trimmed, with a cell cap past
which the middle degrades to a straight replace), hunking with three lines of context and a counted
elision rail, a unified-diff parser for the sources that already carry line numbers, and
`fileDiffsFor` mapping `Edit`/`MultiEdit`/`Write`/`NotebookEdit`/`apply_patch` onto it.
`pairEmphasis` finds the span inside a line that actually changed.

Two sources with different amounts of truth, which is why `numbered` exists: a unified diff string
(`apply_patch`'s changes, `git diff` in a Bash result) knows where in the file it sits; an `Edit`'s
payload does not.

**`rich/tool-view.ts`** — the registry. `toolInputView` / `toolResultView` decide what a call's two
payloads should be drawn as, and `DRAW_LIMIT` (the same constant as `RESULT_CLAMP`) hands anything
past the clamp back to the raw well with its "Show all (N KB)" expander intact.

**`rich/ToolViews.tsx` + `rich/DiffView.tsx`** — the drawings: file diff, plan, command, terminal,
numbered code preview, grouped matches, web request. Deliberately, **diffs are not syntax
highlighted**: a diff already has a colour language, and layering a second one over it makes both
harder to read. What is coloured instead is the span that changed.

**`rich/highlight.ts`** — `highlight.js/lib/core` plus 25 explicit grammars, never the 190-language
build.

**`rich/math.ts`** — KaTeX behind a marked extension, four delimiter pairs. `$…$` is the dangerous
one (prose is full of prices, shell of variables) and carries the guards; nothing inside a code span
or fence reaches it. Unparseable TeX falls back to the source the agent wrote rather than KaTeX's red
`ParseError`, which a reader cannot act on. Sanitization gains the `mathMl` and `svg` profiles — with
the html profile alone DOMPurify strips `<math>` and every formula loses its accessible half.

**`Markdown.tsx`** — highlighting in fences, math, GitHub admonitions (`> [!WARNING]`), task-list
checkboxes, and a table that reads as a table.

**`PermissionCard.tsx`** — the drawn input, shown OPEN, above the disclosure that still holds the raw
payload. Failure 1 above.

**`tool-summary.ts`** — `editStat` now derives from the same `fileDiffsFor` the card draws, so the
row's counts and the diff below it can never disagree. Failure 2 above; it is a behaviour change,
and the old expectations were rewritten rather than preserved.

`electron.vite.config.ts` gains a nine-line plugin that strips KaTeX's `woff`/`ttf` sources. The
renderer is Chromium and only Chromium; without it, Vite emits 60 font files and ~1.1MB to serve one
format. Rewriting the package's CSS beats vendoring a fork of it — a KaTeX upgrade then brings its
own positioning CSS, with no local copy to drift.

## Not built

**W2 — one diff renderer, two surfaces.** The transcript's `fd-*` diff and the diff PANE's `.diff-*`
draw the same thing from the same tint tokens through two component trees. They are kept apart on
purpose for now (the pane owns staging, history and per-file actions across a full-height list; this
is a read-only card in a 680px column, and coupling them would let a change to the pane's chrome
restyle a message from three weeks ago). But `DiffLine`/`DiffHunk`/`FileDiff` is the shape both want,
and the pane's `diff-hunks` markup could be rebuilt on it. A styles test asserts the two stylesheets
stay disjoint until then.

**Not planned:** inline citations, image-generation states, comparison tables. AICSS lists them;
Realm has no payload that produces them.
