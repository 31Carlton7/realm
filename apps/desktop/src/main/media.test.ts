import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";

/* `media.ts` imports `net` and `protocol` for the scheme; neither is touched by anything under
   test here, and pulling in the real electron module in node would fail at import. */
vi.mock("electron", () => ({ net: {}, protocol: {}, nativeImage: { createFromPath: () => ({ isEmpty: () => true }) } }));

const { expandHome, servablePath, statMedia } = await import("./media");

let home: string;
beforeEach(async () => { home = tempDir("realm-media-test-"); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const put = async (rel: string, bytes = "x") => {
  const path = join(home, rel);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, bytes);
  return path;
};

describe("expandHome", () => {
  it("expands the two forms agents actually write", () => {
    expect(expandHome("~", "/Users/me")).toBe("/Users/me");
    expect(expandHome("~/out/clip.mp4", "/Users/me")).toBe("/Users/me/out/clip.mp4");
  });
  it("leaves everything else alone, including another account's home", () => {
    expect(expandHome("/abs/clip.mp4", "/Users/me")).toBe("/abs/clip.mp4");
    expect(expandHome("out/clip.mp4", "/Users/me")).toBe("out/clip.mp4");
    // `~other` is not this user's home and guessing one would be inventing a path.
    expect(expandHome("~other/clip.mp4", "/Users/me")).toBe("~other/clip.mp4");
  });
});

/* `servablePath` is the single gate on `realm-media://`. Everything the renderer can fetch has to
   pass it, so these are the tests that matter most in this file. */
describe("servablePath", () => {
  it("resolves a real media file, by absolute path and through ~", async () => {
    const clip = await put("out/clip.mp4");
    await expect(servablePath(clip, home)).resolves.toBe(clip);
    await expect(servablePath("~/out/clip.mp4", home)).resolves.toBe(clip);
  });

  it("refuses a file that is not media, however real it is", async () => {
    await put("out/.env", "SECRET=1");
    await put("out/index.ts", "export {}");
    await expect(servablePath(join(home, "out/.env"), home)).resolves.toBeNull();
    await expect(servablePath(join(home, "out/index.ts"), home)).resolves.toBeNull();
  });

  it("refuses a media path that does not exist", async () => {
    await expect(servablePath(join(home, "out/missing.mp4"), home)).resolves.toBeNull();
  });

  it("refuses a directory, even one named like a movie", async () => {
    await mkdir(join(home, "clip.mp4"), { recursive: true });
    await expect(servablePath(join(home, "clip.mp4"), home)).resolves.toBeNull();
  });

  it("refuses a relative path rather than resolving it against the app's cwd", async () => {
    await put("clip.mp4");
    await expect(servablePath("clip.mp4", home)).resolves.toBeNull();
    await expect(servablePath("./clip.mp4", home)).resolves.toBeNull();
  });

  it("refuses the empty string and a non-string", async () => {
    await expect(servablePath("", home)).resolves.toBeNull();
    await expect(servablePath(undefined as unknown as string, home)).resolves.toBeNull();
  });

  /* `..` is collapsed before the extension is checked, so a path cannot dress a non-media file up
     as a media one by climbing. The extension check runs on the resolved string. */
  it("collapses .. before deciding, so traversal cannot change the verdict", async () => {
    const clip = await put("out/clip.mp4");
    await expect(servablePath(join(home, "out", "..", "out", "clip.mp4"), home)).resolves.toBe(clip);
    await put("out/.env", "SECRET=1");
    await expect(servablePath(join(home, "out/clip.mp4", "..", ".env"), home)).resolves.toBeNull();
  });

  it("follows a symlink to real media — a render in a symlinked output directory is ordinary", async () => {
    const clip = await put("out/clip.mp4");
    await symlink(clip, join(home, "link.mp4"));
    // The LINK's path comes back, not the target's: it is what the user was shown, and it is what
    // reveal-in-Finder should select.
    await expect(servablePath(join(home, "link.mp4"), home)).resolves.toBe(join(home, "link.mp4"));
  });

  /* The reason the extension is checked again after `realpath`. An agent has write access to its
     workspace, so `evil.mp4 -> ~/.ssh/id_rsa` is a link it can make and then embed in a message —
     and the name alone would let the renderer fetch the key's bytes. */
  it("refuses a symlink that lends its media extension to something that is not media", async () => {
    const secret = await put("out/.env", "SECRET=1");
    await symlink(secret, join(home, "sneaky.mp4"));
    await expect(servablePath(join(home, "sneaky.mp4"), home)).resolves.toBeNull();
  });

  it("refuses a symlink whose target is gone", async () => {
    await symlink(join(home, "never.mp4"), join(home, "dangling.mp4"));
    await expect(servablePath(join(home, "dangling.mp4"), home)).resolves.toBeNull();
  });
});

describe("statMedia", () => {
  it("answers positionally, so a resolved path can be matched to the guess that found it", async () => {
    const clip = await put("out/clip.mp4", "0123456789");
    const answers = await statMedia(["~/out/nope.mp4", "~/out/clip.mp4", "/not/a/path.png"], home);
    expect(answers.length).toBe(3);
    expect(answers[0]).toBeNull();
    expect(answers[2]).toBeNull();
    expect(answers[1]).toMatchObject({ path: clip, mime: "video/mp4", kind: "video", size: 10 });
  });

  it("describes each family with the kind that plays it", async () => {
    await put("a.png"); await put("b.mp4"); await put("c.wav");
    const [png, mp4, wav] = await statMedia([join(home, "a.png"), join(home, "b.mp4"), join(home, "c.wav")], home);
    expect(png).toMatchObject({ kind: "image", mime: "image/png" });
    expect(mp4).toMatchObject({ kind: "video", mime: "video/mp4" });
    expect(wav).toMatchObject({ kind: "audio", mime: "audio/wav" });
  });

  it("answers an empty ask with an empty list rather than reading anything", async () => {
    await expect(statMedia([], home)).resolves.toEqual([]);
  });

  /* The same file asked about twice is answered twice — the caller joins on index, and dropping the
     duplicate would shift every answer after it onto the wrong candidate. */
  it("keeps one answer per candidate even when two name the same file", async () => {
    const clip = await put("clip.mp4");
    const answers = await statMedia([clip, "~/clip.mp4"], home);
    expect(answers.map((a) => a?.path)).toEqual([clip, clip]);
  });
});
