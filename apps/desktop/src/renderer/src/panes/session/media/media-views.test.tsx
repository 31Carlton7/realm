import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mediaUrl, type MediaFile } from "@realm/contracts";
import { Markdown } from "../Markdown";
import { Transcript } from "../Transcript";
import { emptyTranscript } from "../transcript-model";
import { GeneratingCanvas, MediaStrip, formatTime, genWidthPx } from "./MediaView";
import { resetMediaCache } from "./use-media";

/** What main would answer for a real file. */
const file = (path: string, kind: MediaFile["kind"], size = 10_485_760): MediaFile => ({
  path, kind, size,
  mime: kind === "video" ? "video/mp4" : kind === "audio" ? "audio/mpeg" : "image/png",
});

const HOME = "/Users/test";

/**
 * Stand in for main. `known` is the whole filesystem as far as the renderer is concerned; anything
 * else answers null, which is how a guessed path costs nothing on screen.
 *
 * It expands `~` exactly as main does, so an answer's path is generally NOT the string that was
 * asked with — which is the whole reason `media:stat` answers positionally, and the only way a test
 * can tell a positional join from a by-path one.
 */
function stubMedia(known: MediaFile[]) {
  const resolve = (c: string) => (c.startsWith("~/") ? `${HOME}/${c.slice(2)}` : c);
  const stat = vi.fn(async (candidates: readonly string[]) =>
    candidates.map((c) => known.find((f) => f.path === resolve(c)) ?? null));
  const reveal = vi.fn(async () => {});
  const open = vi.fn(async () => {});
  vi.stubGlobal("realm", { media: { stat, poster: vi.fn(async () => null), reveal, open } });
  return { stat, reveal, open };
}

beforeEach(() => { resetMediaCache(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("formatTime", () => {
  it("reads as a player's clock", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(9)).toBe("0:09");
    expect(formatTime(101)).toBe("1:41");
    expect(formatTime(3661)).toBe("1:01:01");
  });
  /* A video whose metadata has not arrived reports NaN for its duration, and `NaN:NaN` in the
     transport would be the first thing a reader saw. */
  it("survives the values a video element reports before it has loaded", () => {
    expect(formatTime(NaN)).toBe("0:00");
    expect(formatTime(Infinity)).toBe("0:00");
    expect(formatTime(-1)).toBe("0:00");
  });
});

describe("MediaStrip", () => {
  it("plays a video through the media scheme, without autoplaying it", async () => {
    const clip = file("/out/clip.mp4", "video");
    stubMedia([clip]);
    const { container } = render(<MediaStrip files={[clip]} />);
    const video = container.querySelector("video")!;
    expect(video).toHaveAttribute("src", mediaUrl("/out/clip.mp4"));
    // The three attributes that would make a transcript start playing at the reader.
    expect(video).not.toHaveAttribute("autoplay");
    expect(video).not.toHaveAttribute("loop");
    expect(video.getAttribute("preload")).toBe("metadata");
    expect(screen.getByRole("button", { name: "Play clip.mp4" })).toBeInTheDocument();
  });

  it("names the file and its size beside it", () => {
    const clip = file("/out/clip.mp4", "video", 10 * 1024 * 1024);
    stubMedia([clip]);
    render(<MediaStrip files={[clip]} />);
    expect(screen.getByText("clip.mp4")).toBeInTheDocument();
    expect(screen.getByText("10 MB")).toBeInTheDocument();
  });

  it("hands Finder and the OS opener the path, not a URL", async () => {
    const shot = file("/out/hero.png", "image");
    const { reveal, open } = stubMedia([shot]);
    render(<MediaStrip files={[shot]} />);
    fireEvent.click(screen.getByRole("button", { name: "Reveal hero.png in Finder" }));
    fireEvent.click(screen.getByRole("button", { name: "Open hero.png" }));
    expect(reveal).toHaveBeenCalledWith("/out/hero.png");
    expect(open).toHaveBeenCalledWith("/out/hero.png");
  });

  it("opens a file in the lightbox and closes it on Escape", async () => {
    const shot = file("/out/hero.png", "image");
    stubMedia([shot]);
    render(<MediaStrip files={[shot]} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open hero.png larger" }));
    expect(screen.getByRole("dialog", { name: "hero.png" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("draws nothing at all for an empty list", () => {
    const { container } = render(<MediaStrip files={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Markdown media embeds", () => {
  it("turns a local image embed into a player once main confirms the file", async () => {
    const shot = file("/out/hero.png", "image");
    const { stat } = stubMedia([shot]);
    const { container } = render(<Markdown text="Here it is: ![hero](/out/hero.png)" />);
    await waitFor(() => expect(container.querySelector("img.media-el")).toBeInTheDocument());
    expect(container.querySelector("img.media-el")).toHaveAttribute("src", mediaUrl("/out/hero.png"));
    expect(stat).toHaveBeenCalledWith(["/out/hero.png"]);
    // The prose around the embed survives.
    expect(container.textContent).toContain("Here it is:");
  });

  it("turns a link to a local video into a player", async () => {
    const clip = file("/out/clip.mp4", "video");
    stubMedia([clip]);
    const { container } = render(<Markdown text="Watch [the clip](/out/clip.mp4)." />);
    await waitFor(() => expect(container.querySelector("video")).toBeInTheDocument());
  });

  /* The gap this closes: both of these used to fail silently — an `<img>` resolved against the app
     bundle, and a `file://` href did not survive the sanitizer's URI allowlist at all. */
  it("handles a file:// href and a ~ path", async () => {
    stubMedia([file("/out/a.png", "image"), file("/Users/test/b.png", "image")]);
    const { container } = render(<Markdown text="![a](file:///out/a.png) ![b](~/b.png)" />);
    await waitFor(() => expect(container.querySelectorAll("img.media-el").length).toBe(2));
  });

  it("draws nothing for a path main does not confirm, and leaves no broken frame", async () => {
    const { stat } = stubMedia([]);
    const { container } = render(<Markdown text="![gone](/out/gone.png)" />);
    await waitFor(() => expect(stat).toHaveBeenCalled());
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("video")).toBeNull();
  });

  it("leaves ordinary links and remote images alone", async () => {
    const { stat } = stubMedia([]);
    const { container } = render(<Markdown text="[docs](https://example.com) and ![x](https://example.com/x.png)" />);
    expect(container.querySelector("a")).toHaveAttribute("href", "https://example.com");
    expect(container.querySelector("img")).toHaveAttribute("src", "https://example.com/x.png");
    // Nothing local was named, so main was never asked.
    expect(stat).not.toHaveBeenCalled();
  });

  /* A filename is user-controlled text being interpolated into markup. */
  it("does not let a filename break out of the placeholder's attribute", async () => {
    stubMedia([]);
    const { container } = render(<Markdown text={'![x](/out/a".png)'} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector(".md-media-ref")).toHaveAttribute("data-media-path", '/out/a".png');
  });

  it("never asks main about a non-media path, however it is spelled", async () => {
    const { stat } = stubMedia([]);
    render(<Markdown text="![x](/etc/passwd) [y](/src/index.ts) [z](file:///Users/me/.ssh/id_rsa)" />);
    expect(stat).not.toHaveBeenCalled();
  });
});

/* The width has to be computed rather than left to CSS: `aspect-ratio` with both a `max-width` and a
   `max-height` clamps each side independently and stops preserving the ratio, which rendered a 9:16
   canvas as a square — verified in a real browser, since jsdom has no layout to notice it. */
describe("genWidthPx", () => {
  it("fits each shape inside the same square, keeping the shape", () => {
    expect(genWidthPx("1 / 1", 320)).toBe(320);
    expect(genWidthPx("1080 / 1920", 320)).toBe(180); // portrait: the HEIGHT is what hits the cap
    expect(genWidthPx("16 / 9", 320)).toBe(320);
    expect(genWidthPx("808 / 1756", 320)).toBe(147);
  });
  it("falls back to the full square on anything it cannot read", () => {
    for (const bad of ["", "wide", "0 / 0", "16", "x / y", "16 / 0"])
      expect(genWidthPx(bad, 320), bad).toBe(320);
  });
});

describe("GeneratingCanvas", () => {
  it("is a placeholder the shape of the thing coming, captioned with what is being made", () => {
    const { container } = render(
      <GeneratingCanvas kind="video" label="Encoding video" detail="Encode all three mockup videos" aspect="1080 / 1920" />);
    expect(screen.getByRole("img", { name: "Encoding video" }))
      .toHaveStyle({ aspectRatio: "1080 / 1920", width: "180px" });
    expect(screen.getByText("Encode all three mockup videos")).toBeInTheDocument();
    // The shimmer and the glow are decoration; the caption is what a screen reader is given.
    for (const el of container.querySelectorAll(".gen-glow, .gen-dots"))
      expect(el).toHaveAttribute("aria-hidden", "true");
  });
  it("carries no progress it cannot know", () => {
    const { container } = render(<GeneratingCanvas kind="image" label="Rendering image" />);
    expect(container.querySelector("progress")).toBeNull();
    expect(container.querySelector("[role='progressbar']")).toBeNull();
  });
});

/* The feature end to end, on the shape of message that motivated it: an agent encodes three videos
   with ffmpeg, then reports the directory in prose and the filenames in a table. Neither half is a
   usable path, and until now the reader's only option was to go to Finder. */
describe("a message that points at files it made", () => {
  const REPORT = [
    "Done — three mockup videos are in `~/Desktop/mockups/`:",
    "",
    "| File | Length | Size |",
    "|---|---|---|",
    "| `versed-mockup-1-1403.mp4` | 1:41 | 10 MB |",
    "| `versed-mockup-2-1404.mp4` | 1:00 | 20 MB |",
    "| `notes.md` | — | 2 KB |",
  ].join("\n");

  const transcript = (text: string, streaming: boolean) => ({
    ...emptyTranscript(),
    blocks: [{ kind: "assistant" as const, messageId: "m1", text, streaming, ts: 0 }],
  });

  it("plays the videos the message named, and nothing it did not", async () => {
    const { stat } = stubMedia([
      file("/Users/test/Desktop/mockups/versed-mockup-1-1403.mp4", "video"),
      file("/Users/test/Desktop/mockups/versed-mockup-2-1404.mp4", "video"),
    ]);
    const { container } = render(
      <Transcript transcript={transcript(REPORT, false)} sessionStatus="idle" onDecide={() => {}} cwd="/work" />);
    await waitFor(() => expect(container.querySelectorAll("video").length).toBe(2));
    // The URL carries the path MAIN gave back, not the `~` spelling the message used.
    expect(container.querySelector("video")).toHaveAttribute("src", mediaUrl("/Users/test/Desktop/mockups/versed-mockup-1-1403.mp4"));
    // `notes.md` is not media, so it was never even asked about.
    expect(stat.mock.calls.flat(2).some((c) => String(c).includes("notes.md"))).toBe(false);
  });

  it("shows nothing for a file that is not there", async () => {
    const { stat } = stubMedia([]);
    const { container } = render(
      <Transcript transcript={transcript(REPORT, false)} sessionStatus="idle" onDecide={() => {}} cwd="/work" />);
    await waitFor(() => expect(stat).toHaveBeenCalled());
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector(".media-strip")).toBeNull();
  });

  /* Half a path is a different path. A strip that appeared, changed and vanished as the sentence
     completed would be worse than one that waits for the full stop. */
  it("asks about nothing while the message is still streaming", () => {
    const { stat } = stubMedia([file("/Users/test/Desktop/mockups/versed-mockup-1-1403.mp4", "video")]);
    render(<Transcript transcript={transcript(REPORT, true)} sessionStatus="running" onDecide={() => {}} cwd="/work" />);
    expect(stat).not.toHaveBeenCalled();
  });
});
