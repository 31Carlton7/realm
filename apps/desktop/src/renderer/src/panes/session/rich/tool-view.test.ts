import { describe, expect, it } from "vitest";
import { DRAW_LIMIT, aspectIn, mediaWorkFor, parseMatches, parseTodos, splitExitCode, stripLineNumbers, toolInputView, toolMediaPath, toolResultView } from "./tool-view";

describe("parseTodos", () => {
  it("reads TodoWrite's list, carrying a missing activeForm as null rather than faking one", () => {
    expect(parseTodos({ todos: [
      { content: "Write the parser", status: "completed", activeForm: "Writing the parser" },
      { content: "Wire the card", status: "in_progress" },
    ] })).toEqual([
      { content: "Write the parser", status: "completed", activeForm: "Writing the parser" },
      { content: "Wire the card", status: "in_progress", activeForm: null },
    ]);
  });

  it("declines anything that is not the documented shape, so the card falls back to the raw payload", () => {
    expect(parseTodos({})).toBeNull();
    expect(parseTodos({ todos: [] })).toBeNull();
    expect(parseTodos({ todos: ["just a string"] })).toBeNull();
    expect(parseTodos({ todos: [{ content: "x", status: "blocked" }] })).toBeNull();
    expect(parseTodos({ todos: [{ status: "pending" }] })).toBeNull();
  });

  it("one unreadable row rejects the whole list — a plan missing a step is worse than no plan", () => {
    expect(parseTodos({ todos: [{ content: "a", status: "pending" }, { content: "b" }] })).toBeNull();
  });
});

describe("splitExitCode", () => {
  it("lifts the trailing [exit N] the Codex mapper appends", () => {
    expect(splitExitCode("boom\n[exit 2]")).toEqual({ output: "boom", exitCode: 2 });
    expect(splitExitCode("ok\n[exit 0]\n")).toEqual({ output: "ok", exitCode: 0 });
  });

  it("reports no code at all when the result never carried one", () => {
    // Claude's Bash result is bare output. Reading that as "exit 0" would put a green success badge
    // on a command whose status nobody recorded.
    expect(splitExitCode("total 8\ndrwxr-xr-x")).toEqual({ output: "total 8\ndrwxr-xr-x", exitCode: null });
    expect(splitExitCode("see [exit 3] in the log")).toEqual({ output: "see [exit 3] in the log", exitCode: null });
  });
});

describe("stripLineNumbers", () => {
  it("strips Read's cat -n gutter and keeps the file's real first line", () => {
    expect(stripLineNumbers("     1\tconst a = 1;\n     2\tconst b = 2;")).toEqual({ text: "const a = 1;\nconst b = 2;", firstLine: 1 });
    expect(stripLineNumbers("    40\tfourty\n    41\tfourty-one")).toEqual({ text: "fourty\nfourty-one", firstLine: 40 });
  });

  it("refuses text that is not a numbered listing", () => {
    expect(stripLineNumbers("plain output")).toBeNull();
    expect(stripLineNumbers("     1\tone\nnot numbered")).toBeNull();
    // Numbers that do not count up are data in a tab-separated file, not a gutter.
    expect(stripLineNumbers("  7\tseven\n  9\tnine")).toBeNull();
  });

  it("keeps the leading tab's content intact, including further tabs", () => {
    expect(stripLineNumbers("     1\ta\tb")!.text).toBe("a\tb");
  });
});

describe("parseMatches", () => {
  it("groups path:line:text results by file", () => {
    const out = parseMatches("/repo/a.ts:12:const a = 1;\n/repo/a.ts:40:const b = 2;\n/repo/b.ts:3:x")!;
    expect(out.groups.map((g) => g.path)).toEqual(["/repo/a.ts", "/repo/b.ts"]);
    expect(out.groups[0]!.matches).toEqual([{ line: 12, text: "const a = 1;" }, { line: 40, text: "const b = 2;" }]);
  });

  it("reads a bare path list (Glob, Grep's files_with_matches) as files with no match rows", () => {
    const out = parseMatches("/repo/a.ts\n/repo/src/b.tsx")!;
    expect(out.groups).toEqual([{ path: "/repo/a.ts", matches: [] }, { path: "/repo/src/b.tsx", matches: [] }]);
  });

  it("lifts Grep's own preamble and truncation notice out of the results", () => {
    const out = parseMatches("Found 2 files\n/repo/a.ts:1:x\n(Results are truncated. Consider a more specific path)")!;
    expect(out.note).toBe("Found 2 files · (Results are truncated. Consider a more specific path)");
    expect(out.groups).toHaveLength(1);
  });

  it("declines when any line is not a result, rather than silently dropping it", () => {
    // Half a search result is the one thing worse than a raw dump: the reader cannot see what is
    // missing.
    expect(parseMatches("No files found")).toBeNull();
    expect(parseMatches("/repo/a.ts:1:x\nsomething went wrong")).toBeNull();
    expect(parseMatches("")).toBeNull();
  });
});

describe("toolInputView", () => {
  it("draws the tools whose payload IS a picture, and declines the rest", () => {
    expect(toolInputView("Edit", { file_path: "/a", old_string: "a", new_string: "b" })?.kind).toBe("diff");
    expect(toolInputView("Bash", { command: "ls -la" })).toEqual({ kind: "command", command: "ls -la", cwd: null, description: null });
    expect(toolInputView("TodoWrite", { todos: [{ content: "x", status: "pending" }] })?.kind).toBe("todos");
    expect(toolInputView("WebFetch", { url: "https://example.com", prompt: "summarise" })?.kind).toBe("request");
    expect(toolInputView("Read", { file_path: "/a" })).toBeNull();
    expect(toolInputView("mcp__thing__do", { anything: 1 })).toBeNull();
  });

  it("declines a command tool whose payload has no command — the raw well then shows what it does have", () => {
    expect(toolInputView("Bash", { timeout: 5000 })).toBeNull();
  });
});

describe("toolResultView", () => {
  it("draws a diff printed into ANY result, whichever tool printed it", () => {
    const patch = "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b";
    expect(toolResultView("Bash", { command: "git diff" }, patch, false)).toMatchObject({ kind: "diff" });
  });

  it("a command result is a terminal, with an exit code only where one was stated", () => {
    expect(toolResultView("Bash", {}, "hello", false)).toEqual({ kind: "terminal", output: "hello", exitCode: null });
    expect(toolResultView("exec_command", {}, "bad\n[exit 1]", false)).toEqual({ kind: "terminal", output: "bad", exitCode: 1 });
  });

  it("a Read is a numbered file preview, and keeps its numbering when the listing carries none", () => {
    expect(toolResultView("Read", { file_path: "/a.ts" }, "     1\tconst a = 1;", false))
      .toEqual({ kind: "code", path: "/a.ts", text: "const a = 1;", firstLine: 1 });
    expect(toolResultView("Read", { file_path: "/a.ts" }, "raw contents", false))
      .toEqual({ kind: "code", path: "/a.ts", text: "raw contents", firstLine: null });
  });

  it("a search result is a match list, and unparseable output falls back to the raw well", () => {
    expect(toolResultView("Grep", {}, "/a.ts:1:x", false)).toMatchObject({ kind: "matches" });
    expect(toolResultView("Grep", {}, "No matches found", false)).toBeNull();
  });

  it("never draws an error or an empty result — both belong in the well as they arrived", () => {
    expect(toolResultView("Bash", {}, "command not found", true)).toBeNull();
    expect(toolResultView("Bash", {}, "", false)).toBeNull();
  });
});

describe("the draw limit", () => {
  it("hands a result at or past the clamp back to the raw well, whatever shape it is", () => {
    // A-M2's "Show all (N KB)" expander is the only thing standing between the transcript and an
    // agent that cats a bundle; a drawn view would swallow it.
    expect(toolResultView("Bash", {}, "x".repeat(DRAW_LIMIT), false)).toBeNull();
    expect(toolResultView("Bash", {}, "x".repeat(DRAW_LIMIT - 1), false)).toMatchObject({ kind: "terminal" });
  });
});

describe("toolMediaPath", () => {
  it("names the picture a file tool is about", () => {
    expect(toolMediaPath("Read", { file_path: "/tmp/mockup/s1.png" })).toBe("/tmp/mockup/s1.png");
    expect(toolMediaPath("Write", { file_path: "/out/hero.webp" })).toBe("/out/hero.webp");
    expect(toolMediaPath("view_image", { path: "/out/frame.jpg" })).toBe("/out/frame.jpg");
  });
  it("declines a file tool pointed at anything that is not media", () => {
    expect(toolMediaPath("Read", { file_path: "/src/index.ts" })).toBeNull();
    expect(toolMediaPath("Read", { file_path: "/a/report.pdf" })).toBeNull();
    expect(toolMediaPath("Read", {})).toBeNull();
  });
  it("declines tools whose payload merely mentions a path", () => {
    // A Bash command that writes a png is not a call ABOUT that png, and its input well is a
    // terminal — drawing the picture there would replace the command with its output.
    expect(toolMediaPath("Bash", { command: "convert a.svg /out/a.png", file_path: "/out/a.png" })).toBeNull();
    expect(toolMediaPath("Grep", { file_path: "/out/a.png" })).toBeNull();
  });
});

describe("aspectIn", () => {
  it("takes a stated frame size, in either notation", () => {
    expect(aspectIn("scale=1080:1920,format=yuv420p")).toBe("1080 / 1920");
    expect(aspectIn("ffmpeg -s 1920x1080 -i in.mov out.mp4")).toBe("1920 / 1080");
  });
  /* The reason both sides must be three digits: a message full of timestamps and quality settings
     would otherwise produce a placeholder in an invented shape, which is worse than a square. */
  it("ignores numbers that are not dimensions", () => {
    expect(aspectIn("-crf 17 -preset slow")).toBeNull();
    expect(aspectIn("recorded at 14:03 with -g 60")).toBeNull();
    expect(aspectIn("no numbers here")).toBeNull();
  });
  it("ignores a pair too lopsided to be a frame", () => {
    expect(aspectIn("seek 100:99999")).toBeNull();
  });
});

describe("mediaWorkFor", () => {
  it("recognises an encode, and takes the frame size the command states", () => {
    const work = mediaWorkFor("Bash", {
      command: 'ffmpeg -i in.mov -filter_complex "scale=808:1756,pad=1080:1920" -c:v libx264 out.mp4',
      description: "Encode all three mockup videos",
    });
    expect(work).toEqual({ kind: "video", label: "Encoding video", detail: "Encode all three mockup videos", aspect: "808 / 1756" });
  });

  it("calls a single-frame grab an image, though it is the same binary", () => {
    expect(mediaWorkFor("Bash", { command: "ffmpeg -ss 3 -i in.mov -frames:v 1 s1.png -y" }))
      .toMatchObject({ kind: "image", label: "Rendering image" });
  });

  it("recognises the image converters", () => {
    expect(mediaWorkFor("Bash", { command: "magick in.svg -resize 400 out.png" })).toMatchObject({ kind: "image" });
    expect(mediaWorkFor("Bash", { command: "sips -Z 800 shot.png" })).toMatchObject({ kind: "image" });
  });

  /* Nothing is being MADE by an inspection, so nothing should be drawn as pending. `ffprobe` is
     absent from the producer table for exactly this reason. */
  it("declines commands that only inspect", () => {
    expect(mediaWorkFor("Bash", { command: "ffprobe -v error -show_streams in.mov" })).toBeNull();
    expect(mediaWorkFor("Bash", { command: "ls -la ~/Desktop/mockups" })).toBeNull();
  });

  it("requires the producer to BE the command, not a word inside one", () => {
    expect(mediaWorkFor("Bash", { command: "cat ffmpeg-notes.txt" })).toBeNull();
    expect(mediaWorkFor("Bash", { command: "grep convert README.md" })).toBeNull();
    // …but it survives a path, an env prefix and a pipeline position.
    expect(mediaWorkFor("Bash", { command: "/opt/homebrew/bin/ffmpeg -i a.mov b.mp4" })).toMatchObject({ kind: "video" });
    expect(mediaWorkFor("Bash", { command: "cd /tmp && ffmpeg -i a.mov b.mp4" })).toMatchObject({ kind: "video" });
  });

  it("recognises a generator tool by its own name, and captions it with the prompt", () => {
    expect(mediaWorkFor("mcp__studio__generate_image", { prompt: "a calm mountain lake at dawn" }))
      .toEqual({ kind: "image", label: "Generating image", detail: "a calm mountain lake at dawn", aspect: "1 / 1" });
    expect(mediaWorkFor("text_to_video", { prompt: "a drone shot" })).toMatchObject({ kind: "video", aspect: "16 / 9" });
    expect(mediaWorkFor("sora", { prompt: "x", size: "1920x1080" })).toMatchObject({ kind: "video", aspect: "1920 / 1080" });
  });

  it("never mistakes an ordinary tool for a generator", () => {
    for (const name of ["Read", "Edit", "Write", "Grep", "TodoWrite", "WebFetch", "reimagine_the_docs"])
      expect(mediaWorkFor(name, { prompt: "x", file_path: "/a/b.png" }), name).toBeNull();
  });
});
