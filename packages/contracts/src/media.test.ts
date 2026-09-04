import { describe, expect, it } from "vitest";
import {
  MAX_MEDIA_CANDIDATES, isAudioMime, isPlayablePath, isVideoMime, mediaCandidatesIn, mediaKindFor,
  mediaUrl, pathFromMediaUrl,
} from "./media";

describe("mediaKindFor", () => {
  it("names the element that plays each family", () => {
    expect(mediaKindFor("image/png")).toBe("image");
    expect(mediaKindFor("video/mp4")).toBe("video");
    expect(mediaKindFor("audio/mpeg")).toBe("audio");
  });
  it("refuses everything else, including the near misses", () => {
    expect(mediaKindFor("application/pdf")).toBeNull();
    expect(mediaKindFor("text/plain")).toBeNull();
    // The prefix has to be the family, not a substring of the subtype.
    expect(mediaKindFor("application/x-video-thing")).toBeNull();
    expect(isVideoMime("video/quicktime")).toBe(true);
    expect(isAudioMime("audio/mp4")).toBe(true);
  });
});

describe("isPlayablePath", () => {
  it("admits the media extensions and nothing else", () => {
    expect(isPlayablePath("/a/clip.mp4")).toBe(true);
    expect(isPlayablePath("/a/CLIP.MOV")).toBe(true);
    expect(isPlayablePath("/a/shot.png")).toBe(true);
    expect(isPlayablePath("/a/track.wav")).toBe(true);
  });
  /* This is the whole gate on the protocol handler: if a source file or a secret could be spelled
     as a playable path, the renderer could fetch it. */
  it("refuses source, config and secrets", () => {
    expect(isPlayablePath("/a/.env")).toBe(false);
    expect(isPlayablePath("/a/index.ts")).toBe(false);
    expect(isPlayablePath("/a/id_rsa")).toBe(false);
    expect(isPlayablePath("/a/notes.pdf")).toBe(false);
    // A media extension in a DIRECTORY name is not a media file.
    expect(isPlayablePath("/home/me.png/secrets")).toBe(false);
  });
});

describe("mediaUrl / pathFromMediaUrl", () => {
  it("round-trips a plain path", () => {
    expect(pathFromMediaUrl(mediaUrl("/Users/me/out/clip.mp4"))).toBe("/Users/me/out/clip.mp4");
  });
  /* The reason the path is one encoded segment rather than an interpolated one: each of these
     characters would otherwise truncate or re-point the URL. */
  it("round-trips the characters that would break an interpolated URL", () => {
    for (const path of [
      "/a/my clip.mp4",
      "/a/what?.png",
      "/a/frame#3.png",
      "/a/100%.png",
      "/a/quote'and\"dbl.mp4",
      "/a/café/naïve.png",
      "/a/back\\slash.png",
    ]) expect(pathFromMediaUrl(mediaUrl(path)), path).toBe(path);
  });
  it("refuses anything that is not one of ours", () => {
    expect(pathFromMediaUrl("file:///a/clip.mp4")).toBeNull();
    expect(pathFromMediaUrl("https://example.com/clip.mp4")).toBeNull();
    expect(pathFromMediaUrl("realm-media://elsewhere/%2Fa%2Fclip.mp4")).toBeNull();
    expect(pathFromMediaUrl("realm-media://f/")).toBeNull();
    expect(pathFromMediaUrl("not a url")).toBeNull();
    // A malformed escape is not a path; decodeURIComponent throws and the answer is null, not a crash.
    expect(pathFromMediaUrl("realm-media://f/%E0%A4%A")).toBeNull();
  });
});

describe("mediaCandidatesIn", () => {
  it("takes a stated path as it stands", () => {
    expect(mediaCandidatesIn("wrote ~/out/clip.mp4 just now", null)).toEqual(["~/out/clip.mp4"]);
  });

  /* The case this function exists for — the shape of the message in the mockups session: the
     directory is named once in prose and the files are named in a table. Neither half is a usable
     path alone. */
  it("joins a message's bare filenames to the directory it named", () => {
    const text = [
      "Done — three mockup videos are in `~/Desktop/mockups/`:",
      "",
      "| File | Length |",
      "|---|---|",
      "| `versed-mockup-1-1403.mp4` | 1:41 |",
      "| `versed-mockup-2-1404.mp4` | 1:00 |",
    ].join("\n");
    expect(mediaCandidatesIn(text, null)).toEqual([
      "~/Desktop/mockups/versed-mockup-1-1403.mp4",
      "~/Desktop/mockups/versed-mockup-2-1404.mp4",
    ]);
  });

  it("joins bare names to the session's cwd when the message named no directory", () => {
    expect(mediaCandidatesIn("Rendered `hero.png`.", "/work/site")).toEqual(["/work/site/hero.png"]);
    // A cwd without its trailing separator must not produce `/work/sitehero.png`.
    expect(mediaCandidatesIn("Rendered `hero.png`.", "/work/site/")).toEqual(["/work/site/hero.png"]);
  });

  it("takes the directory of a non-media path as a place its siblings may live", () => {
    expect(mediaCandidatesIn("see ~/out/README.md, and `hero.png`", null)).toEqual(["~/out/hero.png"]);
  });

  it("does not ask twice about a file it already has a full path for", () => {
    expect(mediaCandidatesIn("`clip.mp4` is at /a/clip.mp4", "/a")).toEqual(["/a/clip.mp4"]);
  });

  it("leaves sentence punctuation out of the path", () => {
    expect(mediaCandidatesIn("It is at /a/clip.mp4.", null)).toEqual(["/a/clip.mp4"]);
    expect(mediaCandidatesIn("(see /a/shot.png)", null)).toEqual(["/a/shot.png"]);
    expect(mediaCandidatesIn("in `~/out/`. Named `a.png`", null)).toEqual(["~/out/a.png"]);
    /* The case that makes the trim load-bearing rather than a belt: a path with no directory above
       the root has no directory to fall back on, so if the full stop stays attached the file is
       lost entirely instead of being rejoined from its bare name. */
    expect(mediaCandidatesIn("saved to /clip.mp4.", null)).toEqual(["/clip.mp4"]);
  });

  it("proposes nothing for prose with no files in it", () => {
    expect(mediaCandidatesIn("All three encodes finished cleanly.", "/work")).toEqual([]);
    // A non-media file is not a candidate however it is spelled.
    expect(mediaCandidatesIn("Updated /a/index.ts and /a/.env", "/work")).toEqual([]);
  });

  it("caps what one message can ask about", () => {
    const names = Array.from({ length: 40 }, (_, i) => `\`f${i}.png\``).join(" ");
    expect(mediaCandidatesIn(`in \`/out/\`: ${names}`, "/work").length).toBe(MAX_MEDIA_CANDIDATES);
  });

  it("dedupes a name that resolves the same way twice", () => {
    // Two mentions of one directory, one filename: one candidate, not two.
    expect(mediaCandidatesIn("in `/out/` — see `/out/` — `a.png`", null)).toEqual(["/out/a.png"]);
  });
});
