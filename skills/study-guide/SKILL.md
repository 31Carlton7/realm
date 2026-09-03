---
name: study-guide
description: Use when asked to make, extend or review a study guide, review sheet, practice quiz, walkthrough or flashcards for a course topic — from lecture notes, slides, a transcript or a problem set. Produces one self-contained interactive HTML file under guides/ that Realm's Documents pane renders with quizzes, step-throughs, flashcards, KaTeX math and per-topic progress.
---

# study-guide — interactive HTML guides for a course

A guide is **one self-contained HTML file** under `guides/` in the space folder. Realm's Documents
pane renders it in a sandboxed frame and injects a small runtime that turns plain markup into
quizzes, step-throughs and flashcards, records quiz results in a sidecar next to the file, and
renders math through KaTeX. You write markup; you never write the runtime.

## Where things live

- `guides/<topic>.html` — the guide. One topic per file, lowercase-hyphen names (`guides/cache-coherence.html`).
- `lectures/YYYY-MM-DD-<topic>.md` — the lecture notes (and transcripts) you build from.
- `guides/.<name>.html.progress.json` — the quiz sidecar Realm writes. Never edit it; read it with `docs_progress`.

Before writing, run `docs_search` over `lectures/` and `guides/` for the topic: extend an existing
guide rather than starting a second one on the same subject, and cite the lectures you used.
When the file is done, call `docs_open` on it so the user sees it.

## The file

Self-contained: **no external scripts, stylesheets, fonts or images by URL** — the frame has no
network access, so a CDN link is a broken link. Inline your own CSS in a `<style>` block if the
default theme is not enough; inline SVG for diagrams. Keep everything in one file.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="realm-helpers" content="katex">   <!-- only if the guide uses math -->
<title>Cache coherence</title>
</head>
<body>
<main class="rg-guide">
  <h1>Cache coherence</h1>
  <p class="rg-lede">What this covers, and what you should be able to do afterwards.</p>
  …sections…
  <footer class="rg-sources">
    <h2>Sources</h2>
    <ul><li>lectures/2026-09-02-caches.md</li><li>slides/l6.pdf, pp. 12–20</li></ul>
  </footer>
</main>
</body>
</html>
```

## Components (markup the runtime wires up)

**Quiz** — one `section.rg-quiz` per concept, `data-topic` a stable slug (progress is keyed on it).
Multiple choice answers are letters (`a`, `b`, …), 1-based indexes, or a comma list for
select-all-that-apply. Short answers accept any of the `|`-separated alternatives, case-insensitive.

```html
<section class="rg-quiz" data-topic="mesi-states">
  <h2>Check yourself: MESI</h2>
  <div class="rg-question" data-answer="c">
    <p>A line in the Shared state is written by this core. What state does it move to?</p>
    <ol class="rg-options"><li>Invalid</li><li>Exclusive</li><li>Modified</li><li>It stays Shared</li></ol>
    <div class="rg-explain">A write needs ownership; the other sharers are invalidated and the line becomes Modified.</div>
  </div>
  <div class="rg-question" data-answer="a,c">
    <p>Which states allow a silent (no bus traffic) read hit?</p>
    <ol class="rg-options"><li>Modified</li><li>Invalid</li><li>Shared</li></ol>
  </div>
  <div class="rg-question" data-answer="write-back|writeback">
    <p>What does a Modified line do on eviction?</p>
    <input class="rg-input" placeholder="one or two words">
  </div>
  <button class="rg-check">Check answers</button>
</section>
```

**Step-through** — a procedure shown one step at a time, with Prev/Next and ←/→ keys. Put the
state after each step in the step, not just the action.

```html
<div class="rg-steps">
  <div class="rg-step"><h3>1. Core 0 reads X</h3><p>Miss → memory. Line enters <b>Exclusive</b> in C0.</p></div>
  <div class="rg-step"><h3>2. Core 1 reads X</h3><p>Snoop hit in C0 → both <b>Shared</b>.</p></div>
  <div class="rg-step"><h3>3. Core 1 writes X</h3><p>Invalidate to C0 → C1 <b>Modified</b>, C0 <b>Invalid</b>.</p></div>
</div>
```

**Reveal** — hide an answer or a derivation until asked: `<details class="rg-reveal"><summary>Show the derivation</summary>…</details>`.

**Flashcards** — a grid of flip cards:

```html
<div class="rg-flashcards">
  <div class="rg-card"><div class="rg-front">Structural hazard</div><div class="rg-back">Two instructions need the same hardware in the same cycle.</div></div>
</div>
```

**Callout** — `<div class="rg-callout">…</div>` for the one thing to remember.

**Math** — with the `realm-helpers` meta set to `katex`: `$…$` inline, `$$…$$` display, also `\(…\)` / `\[…\]`.
Math inside `<code>` or `<pre>` is left alone.

**Custom interactivity** — inline `<script>` is allowed (it runs sandboxed, no network). For your own
exercises, report a result with `window.Realm.attempt(topic, correct, total)` so it is recorded like a quiz.

## Writing the guide

1. **Orientation first.** One paragraph: what the topic is for and what the reader should be able to do after.
2. **Explain, then check.** Each concept gets a short explanation (a table or diagram where one helps) followed by its own `rg-quiz`. Four to six questions per quiz; mix recall with one applied question. Every explanation in `rg-explain` says *why*, not just which.
3. **Procedures get a step-through**, with the state after every step. Algorithms, protocols, pipelines, proofs.
4. **End with flashcards** covering the vocabulary, and a Sources footer naming the lecture files and slide pages.
5. **Extending a guide**: add sections and quizzes; keep existing `data-topic` slugs unchanged so progress history survives. Use `docs_progress` to find weak topics and add targeted questions there.
6. **Length**: a guide is read in one sitting. Split by topic, not by lecture, when a subject spans lectures.

Do not put the runtime tags (`guide.js`, `guide.css`, KaTeX) in the file — Realm injects them, and
the file stays a plain readable page anywhere else.
