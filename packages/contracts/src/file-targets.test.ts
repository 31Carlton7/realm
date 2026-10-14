import { describe, expect, it } from "vitest";
import { documentKindFor, isPlayablePath, isVideoFile, parseFileTarget, resolveFileTarget } from "./index";

const HOME = "/Users/me";

describe("parseFileTarget — a file as an agent names it", () => {
  it("takes the line off the ways editors write one", () => {
    expect(parseFileTarget("src/app.ts:42")).toEqual({ path: "src/app.ts", line: 42 });
    expect(parseFileTarget("src/app.ts:42:7")).toEqual({ path: "src/app.ts", line: 42 });
    expect(parseFileTarget("app.ts#L42-L50")).toEqual({ path: "app.ts", line: 42 });
    expect(parseFileTarget("/tmp/clip.mp4")).toEqual({ path: "/tmp/clip.mp4", line: null });
  });

  it("reads a file:// URL as its decoded path, and refuses other schemes", () => {
    expect(parseFileTarget("file:///tmp/My%20Clip%20%C3%A9.mov")).toEqual({ path: "/tmp/My Clip é.mov", line: null });
    expect(parseFileTarget("file://localhost/tmp/a.md#L3")).toEqual({ path: "/tmp/a.md", line: 3 });
    expect(parseFileTarget("file://otherhost/tmp/a.md")).toBeNull();
    expect(parseFileTarget("https://example.com/a.md")).toBeNull();
  });

  it("takes off the quotes or brackets a spaced path is written in", () => {
    expect(parseFileTarget('"~/Movies/Screen Recording.mov"')).toEqual({ path: "~/Movies/Screen Recording.mov", line: null });
    expect(parseFileTarget("</tmp/a b.png>")).toEqual({ path: "/tmp/a b.png", line: null });
    expect(parseFileTarget("")).toBeNull();
    expect(parseFileTarget("a\0b")).toBeNull();
  });
});

describe("resolveFileTarget", () => {
  it("resolves ~, a path relative to the session's directory, and climbs", () => {
    expect(resolveFileTarget("~/Downloads/x.mp4", { home: HOME })?.path).toBe("/Users/me/Downloads/x.mp4");
    expect(resolveFileTarget("./out/x.png", { cwd: "/w/repo", home: HOME })?.path).toBe("/w/repo/out/x.png");
    expect(resolveFileTarget("../shared/x.png:9", { cwd: "/w/repo", home: HOME })).toEqual({ path: "/w/shared/x.png", line: 9 });
  });

  it("refuses a relative path with nothing absolute to be relative to", () => {
    // THE MUTANT: resolve against "" — out/x.png became /out/x.png, a file at the disk's root.
    expect(resolveFileTarget("out/x.png", { home: HOME })).toBeNull();
    expect(resolveFileTarget("out/x.png", { cwd: "relative", home: HOME })).toBeNull();
  });
});

describe("videos are a kind of their own", () => {
  it("opens every video container in the player, and the media scheme serves each one", () => {
    for (const ext of ["mp4", "mov", "webm", "m4v", "mkv", "avi", "ogv"]) {
      expect(documentKindFor(`/tmp/clip.${ext.toUpperCase()}`)).toBe("video");
      expect(isVideoFile(`/tmp/clip.${ext}`)).toBe(true);
      expect(isPlayablePath(`/tmp/clip.${ext}`)).toBe(true);
    }
    expect(isVideoFile("/tmp/clip.png")).toBe(false);
  });
});
