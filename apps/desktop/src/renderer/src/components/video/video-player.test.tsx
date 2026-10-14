import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mediaUrl, type MediaFile } from "@realm/contracts";
import { VideoPlayer } from "./VideoPlayer";
import { rememberPosition, savedPosition } from "./video-memory";
import { bufferedSpans, videoKeyAction } from "./video-model";
import { resetMediaCache } from "../../panes/session/media/use-media";

const clip: MediaFile = { path: "/tmp/render.mp4", mime: "video/mp4", kind: "video", size: 1000 };

/** jsdom has no media pipeline: a video is an element whose state the test sets, and play/pause only
 *  flip `paused` and fire the events a real one would. */
function fakeVideo(v: HTMLVideoElement, o: { duration?: number; width?: number } = {}) {
  let paused = true;
  Object.defineProperty(v, "paused", { configurable: true, get: () => paused });
  Object.defineProperty(v, "duration", { configurable: true, get: () => o.duration ?? 120 });
  Object.defineProperty(v, "videoWidth", { configurable: true, get: () => o.width ?? 640 });
  Object.defineProperty(v, "videoHeight", { configurable: true, get: () => (o.width === 0 ? 0 : 360) });
  v.play = vi.fn(async () => { paused = false; fireEvent.play(v); });
  v.pause = vi.fn(() => { paused = true; fireEvent.pause(v); });
  fireEvent.loadedMetadata(v);
  return v;
}

function stub(more: Record<string, unknown> = {}) {
  const media = { stat: vi.fn(async () => []), poster: vi.fn(async () => null), reveal: vi.fn(async () => {}), open: vi.fn(async () => {}), ...more };
  vi.stubGlobal("realm", { media });
  return media;
}

beforeEach(() => { localStorage.clear(); resetMediaCache(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const mount = (o: Parameters<typeof fakeVideo>[1] = {}) => {
  const r = render(<VideoPlayer file={clip} variant="pane" />);
  const video = fakeVideo(r.container.querySelector("video")!, o);
  const player = r.container.querySelector<HTMLElement>(".video-player")!;
  return { ...r, video, player };
};

describe("the player's keyboard", () => {
  it("plays and pauses on Space and K, and seeks with J, L and the arrows", async () => {
    stub();
    const { video, player } = mount();
    fireEvent.keyDown(player, { key: " " });
    expect(video.play).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument());
    fireEvent.keyDown(player, { key: "k" });
    expect(video.pause).toHaveBeenCalled();
    video.currentTime = 30;
    fireEvent.keyDown(player, { key: "l" });
    expect(video.currentTime).toBe(40);
    fireEvent.keyDown(player, { key: "j" });
    expect(video.currentTime).toBe(30);
    fireEvent.keyDown(player, { key: "ArrowRight" });
    expect(video.currentTime).toBe(35);
    fireEvent.keyDown(player, { key: "ArrowLeft" });
    expect(video.currentTime).toBe(30);
    // Never before the start.
    video.currentTime = 2;
    fireEvent.keyDown(player, { key: "j" });
    expect(video.currentTime).toBe(0);
  });

  it("mutes on M and turns the volume with ↑ and ↓", () => {
    stub();
    const { video, player } = mount();
    fireEvent.keyDown(player, { key: "m" });
    expect(video.muted).toBe(true);
    expect(screen.getByRole("button", { name: "Unmute" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(player, { key: "m" });
    fireEvent.keyDown(player, { key: "ArrowDown" });
    expect(video.volume).toBeCloseTo(0.95);
  });

  it("steps a frame with comma and period only while paused", () => {
    expect(videoKeyAction({ key: "." }, true)).toEqual({ kind: "frame", direction: 1 });
    expect(videoKeyAction({ key: "," }, true)).toEqual({ kind: "frame", direction: -1 });
    expect(videoKeyAction({ key: "." }, false)).toBeNull();
    // A chord is the app's.
    expect(videoKeyAction({ key: "k", metaKey: true }, true)).toBeNull();
    expect(videoKeyAction({ key: "f" }, true)).toEqual({ kind: "fullscreen" });
  });

  it("keeps the keys inside the player, so the viewer's ← and → do not walk away from the video", () => {
    stub();
    const { player } = mount();
    const outside = vi.fn();
    window.addEventListener("keydown", outside);
    fireEvent.keyDown(player, { key: "ArrowRight" });
    window.removeEventListener("keydown", outside);
    expect(outside).not.toHaveBeenCalled();
  });
});

describe("where a video was left", () => {
  it("starts where the file was left, and forgets a place near either end", () => {
    stub();
    rememberPosition(clip.path, 47, 120);
    const { video } = mount();
    expect(video.currentTime).toBe(47);
    rememberPosition(clip.path, 118.5, 120);
    expect(savedPosition(clip.path, 120)).toBeNull();
    rememberPosition(clip.path, 1, 120);
    expect(savedPosition(clip.path, 120)).toBeNull();
  });

  it("writes the place down when the video is paused", () => {
    stub();
    const { video, player } = mount();
    fireEvent.keyDown(player, { key: " " });
    video.currentTime = 63;
    fireEvent.keyDown(player, { key: " " });
    expect(savedPosition(clip.path, 120)).toBe(63);
  });
});

describe("a video Realm cannot play", () => {
  it("says so and offers a playable copy when this Mac has ffmpeg, then plays the copy", async () => {
    const transcode = vi.fn(async () => "/realm/tmp/playable/abc.mp4");
    const media = stub({ canTranscode: vi.fn(async () => true), transcode });
    const r = render(<VideoPlayer file={clip} variant="pane" />);
    const video = r.container.querySelector("video")!;
    Object.defineProperty(video, "error", { configurable: true, get: () => ({ code: 4 }) });
    fireEvent.error(video);
    expect(await screen.findByText("Realm cannot play the video format in render.mp4.")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Make a playable copy" }));
    await waitFor(() => expect(r.container.querySelector("video")).toHaveAttribute("src", mediaUrl("/realm/tmp/playable/abc.mp4")));
    expect(transcode).toHaveBeenCalledWith(clip.path);
    expect(screen.getByText("Playable copy")).toBeInTheDocument();
    expect(media.open).not.toHaveBeenCalled();
  });

  it("is honest without ffmpeg: the default app and the Finder, and no copy button", async () => {
    const media = stub({ canTranscode: vi.fn(async () => false) });
    const { video } = mount({ width: 0 }); // the sound decoded, the picture did not
    void video;
    expect(await screen.findByText(/This Mac has no ffmpeg/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Make a playable copy" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open in default app" }));
    fireEvent.click(screen.getByRole("button", { name: "Reveal in Finder" }));
    expect(media.open).toHaveBeenCalledWith(clip.path);
    expect(media.reveal).toHaveBeenCalledWith(clip.path);
  });

  it("calls a file that did not arrive unreadable, and tries again", async () => {
    stub();
    const r = render(<VideoPlayer file={clip} variant="pane" />);
    const video = r.container.querySelector("video")!;
    Object.defineProperty(video, "error", { configurable: true, get: () => ({ code: 2 }) });
    fireEvent.error(video);
    expect(await screen.findByText(/may still be being written/)).toBeInTheDocument();
    act(() => { fireEvent.click(screen.getByRole("button", { name: "Try again" })); });
    expect(r.container.querySelector("video")).not.toBeNull();
  });
});

describe("the scrubber", () => {
  it("draws what has loaded as fractions of the length", () => {
    const ranges = { length: 2, start: (i: number) => [0, 60][i]!, end: (i: number) => [30, 90][i]! };
    expect(bufferedSpans(ranges, 120)).toEqual([{ from: 0, to: 0.25 }, { from: 0.5, to: 0.75 }]);
    expect(bufferedSpans(ranges, NaN)).toEqual([]);
  });
});
