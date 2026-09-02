---
name: lecture-notes
description: Use during or after a class — answering questions from what the lecture just covered, cleaning up notes typed in class, folding in a recording's transcript, turning a lecture into flashcards and a study guide. Works on the dated Markdown files under lectures/ in a course space; reads the course folder with docs_search and never invents what the lecture said.
---

# lecture-notes — before, during and after a class

A lecture is a Markdown file at `lectures/YYYY-MM-DD-<topic>.md` in the course's space folder,
with front-matter (`course`, `title`, `date`) and the sections `## Notes`, `## Questions`,
`## Follow-ups`. A recording imported from Plynn adds `## Transcript` (verbatim) after a rule.
Realm's Documents pane shows the file live: edit it with your normal file tools and the user sees
the change.

The rule that governs everything here: **the lecture is the record**. Your job is to organise and
connect what was said, not to write the lecture you would have given. Mark inference as inference.

## During class (the lecture session)

The user is in class, typing under `## Notes` and dropping questions under `## Questions`. When asked
something:

1. Read the lecture file first; the last few lines are the context.
2. `docs_search` the course folder (`lectures/`, `slides/`, `guides/`) for the term — the answer is
   usually in an earlier lecture or the slide deck, and should cite it by path.
3. Answer briefly. Two paragraphs, then offer to go deeper. The user is listening to someone else.
4. If the question is in `## Questions`, write the answer under it in the file (indented under the
   bullet) rather than only in chat, so it survives.

Do not rewrite the notes while class is running; the user is typing in the same file.

## After class (the wrap-up)

When asked to wrap up a lecture (Realm's "Wrap up a lecture" sends this request with the file path):

1. **Read** the whole file. If there is a `## Transcript`, it is what was said; `## Notes` is what the
   user found worth typing — the emphasis. Without a transcript, work from the notes and the course
   materials and say so at the top of the notes.
2. **Connect**: `docs_search` for the lecture's main terms across `lectures/` and `guides/`, then the
   whole folder (slides are PDFs; their text is searchable). Note which earlier lecture introduced
   each idea.
3. **Rewrite `## Notes`** into structured notes: headings per idea in the order taught, the user's
   own phrasing kept where it is theirs, transcript material added where the notes are thin, and
   anything inferred marked *(inferred)*. Definitions get their own line. Worked examples stay
   worked. Keep it under roughly two screens.
4. **Answer `## Questions`** in place, under each bullet, citing the transcript or source file.
   A question the material does not answer says so and goes to `## Follow-ups`.
5. **Keep `## Follow-ups`** as a checklist (`- [ ]`), adding what the lecturer said to do.
6. **Append `## Flashcards`**: 8–15 `**Q:** … / **A:** …` pairs on the core ideas, no trivia.
7. **Leave the transcript untouched.** It is evidence.
8. **Build or extend the study guide** for the topic under `guides/` — follow the `study-guide` skill
   if it is available (self-contained HTML, `rg-quiz` per concept with `data-topic`, `rg-steps` for
   procedures, KaTeX for math, a sources footer naming this lecture file). Extend an existing guide
   on the same topic rather than creating a second. Then `docs_open` it.
9. **Reply** with five lines: what changed, what to review first, and any question left open.

## Reviewing before an exam

`docs_progress` on a guide reports best/last per topic and which are weak. Build the review from the
weak topics: re-read those lectures, add targeted questions to the guide's existing quizzes (keep
the `data-topic` slugs so history survives), and list the three things to redo by hand.
