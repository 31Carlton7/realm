import { figure, h2, h3, note, p, page, table, tip, ul } from "@/lib/docs-blocks"

export default page({
  slug: "documents-and-library",
  title: "Documents and Library",
  summary:
    "Read and write files beside the session that made them, ask about any file where you're looking at it, and find everything your agents ever wrote or were given in the Library.",
  body: [
    h2("The Documents tab"),
    figure(
      { crop: "documents-home" },
      "The side panel's Documents tab with no file open. A Search files field with ⌘P and a New button. Under This session, auto-compact.ts and orgs.ts. Under Library, eight files including migrations.ts, AppSettings.tsx, blocks.md, three pictures, release-brief.pdf and launch-notes.md, each with where it came from, and Show all 10.",
      "Documents with nothing open: this session's files, then the Library's.",
    ),
    p(
      "Open **Documents** from the side panel's **+**, or **View ▸ Documents**. With no file open it's a home for your files: what this session made and was given, then the Library's, under one search that also finds files in the session's checkout by name.",
    ),
    ul(
      "[[⌘P]] opens a file by name, from anywhere.",
      "[[⌘⇧P]] searches inside files, in the palette.",
      "A file an answer names, such as `web/lib/orgs.ts (line 83)`, is a link once Realm has found it in the checkout, and opens beside the session at that line.",
    ),
    h3("Make a new file"),
    p("**New** makes one of these:"),
    table(
      ["Kind", "What it is"],
      ["**Document**", "Markdown, written as rich text"],
      ["**Spreadsheet**", "A CSV in a grid, with formulas"],
      ["**Presentation**", "Slides, written in Markdown"],
      ["**LaTeX**", "A paper, in source"],
      ["**Study guide**", "A page with quizzes and step-throughs"],
      ["**Code file…**", "TypeScript, Python, Swift and more"],
    ),
    h3("Editing"),
    ul(
      "A Markdown file opens as rich text, and **Source** shows the file as written. A CSV opens as a grid. Code opens in an editor with line numbers; long lines scroll sideways.",
      "There's no Save button: a pause in typing saves, and the head says **Saving…**, then **Saved**.",
      "If the file changes on disk while you're editing it, Realm asks which to keep: **Keep mine** or **Take theirs**.",
      "A file outside the space, such as one an agent wrote to `/tmp` or your Downloads, opens read-only.",
    ),

    h2("Looking at a file"),
    p(
      "Every file Realm shows outside the Documents tab (a picture in a message, an attachment, a Library tile) opens in the same viewer. Markdown is rendered and code is highlighted, PDFs open in a PDF viewer, and videos play in Realm's own player.",
    ),
    p(
      "Under the file is its session's prompter. A question asked there is a turn of the session the file came from, with the file attached, because that agent knows what the file is for. Marks you draw on a picture go to the agent as part of the picture.",
    ),
    table(
      ["In the video player", "Keys"],
      ["Play and pause", "[[Space]] or [[K]]"],
      ["Back or forward 10 seconds", "[[J]] and [[L]]"],
      ["Back or forward 5 seconds", "[[←]] and [[→]]"],
      ["One frame back or forward, while paused", "[[,]] and [[.]]"],
      ["Volume, mute, full screen", "[[↑]] [[↓]], [[M]], [[F]]"],
    ),
    p(
      "The player also has speed, loop and picture in picture, and remembers where you stopped. For a format Chromium can't play, Realm offers a playable copy when ffmpeg is installed.",
    ),
    tip(
      "A file in Realm behaves like one in the Finder: [[Space]] opens it in Quick Look, you can drag it out into another app, and its menu has **Show in Finder** and the system's Share menu.",
    ),

    h2("The Library"),
    figure(
      { crop: "library-files" },
      "Library ▸ Files, with tabs for All, Images, Documents, Code and Data. Under Today, square tiles: migrations.ts, AppSettings.tsx and blocks.md, each labelled with the session that made it; a picture shown edge to edge; and release-brief.pdf and launch-notes.md, marked Added.",
      "The Library's newest files, each labelled with where it came from.",
    ),
    p(
      "**Library** on the rail holds everything your agents made and everything you gave them, across every space in the profile. It has four sections:",
    ),
    table(
      ["Section", "What's in it"],
      ["**Files**", "Every file a session wrote or was given. Tabs narrow it by kind (**All**, **Images**, **Documents**, **Code**, **Data**), and the filter narrows it by space or by who made it."],
      ["**Saved**", "The turns you saved from a session's track (see [Sessions](/docs/sessions#find-your-place-in-a-long-session))"],
      ["**Skills**", "The skills your agents can use. See [Connections and skills](/docs/connections-and-skills#skills)."],
      ["**Memory**", "The memory documents your agents read, and exactly which files each agent loads"],
    ),
    ul(
      "**Add** puts files from your Mac in the Library, or drop them on the page. Realm keeps its own copy of each, in `~/Realm/library/`.",
      "Removing a file from the Library takes away Realm's copy, never the original, and the notice that follows has **Undo**.",
      "Switch between tiles and rows with the view buttons beside the search.",
    ),

    h2("Memory"),
    p(
      "Memory is what your agents read before they start. A space's memory document (its page's **Memory** tab) is read by every session in that space; write conventions, links and standing instructions there, anything you'd otherwise retype at the start of every session. No agent edits it; only an import you run adds to it.",
    ),
    p(
      "**Library ▸ Memory** shows the memory at each level (the space, the profile) and, session by session, the exact files each agent loads. **Also write AGENTS.md** puts the space's memory into an `AGENTS.md` in its folder, for agents that read that file.",
    ),
    note(
      "Agents can use the Library and your space's files too: Realm's document tools let them list, search, open and read files, and reveal one in the Finder.",
    ),
  ],
})
