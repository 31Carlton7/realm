import { beforeAll, describe, expect, it } from "vitest";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { resolveUploadPaths } from "./upload-paths";

/**
 * The gate that runs BEFORE the user is asked. Every test here is a path that must not reach a
 * permission card — or one that must reach it labelled honestly.
 *
 * Real files on a real temp tree rather than a mocked fs, because the whole point of this module is
 * what `realpath` and `stat` answer: a mocked symlink is a symlink nobody checked.
 */
let root = "";
let outside = "";

beforeAll(async () => {
  const base = await realpath(tempDir("realm-upload-"));
  root = join(base, "space");
  outside = join(base, "elsewhere");
  await mkdir(join(root, "gallery"), { recursive: true });
  await mkdir(join(outside, ".ssh"), { recursive: true });
  await writeFile(join(root, "gallery", "hero.png"), "x".repeat(2048));
  await writeFile(join(root, "gallery", "shot-2.png"), "x".repeat(4096));
  await writeFile(join(root, ".env"), "SECRET=1");
  await writeFile(join(outside, "demo.mp4"), "x".repeat(1024));
  await writeFile(join(outside, ".ssh", "id_rsa"), "PRIVATE KEY");
  // The escape the containment rule exists for: a friendly name inside the space folder whose real
  // target is a private key outside it.
  await symlink(join(outside, ".ssh", "id_rsa"), join(root, "key.txt"));
  // And the benign one: a link inside the space to an ordinary file outside it.
  await symlink(join(outside, "demo.mp4"), join(root, "demo-link.mp4"));
});

const ok = async (paths: string[]) => {
  const r = await resolveUploadPaths(paths, root);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.files;
};
const failure = async (paths: string[], r = root as string | null) => {
  const res = await resolveUploadPaths(paths, r);
  if (res.ok) throw new Error("expected a refusal");
  return res.error;
};

describe("resolveUploadPaths", () => {
  it("resolves files inside the space folder with name, size, and no outside flag", async () => {
    const files = await ok([join(root, "gallery", "hero.png"), join(root, "gallery", "shot-2.png")]);
    expect(files.map((f) => f.name)).toEqual(["hero.png", "shot-2.png"]);
    expect(files.map((f) => f.bytes)).toEqual([2048, 4096]);
    expect(files.every((f) => !f.outsideRoot)).toBe(true);
  });

  it("marks a file outside the space folder, and carries its resolved path for the card to quote", async () => {
    const [file] = await ok([join(outside, "demo.mp4")]);
    expect(file!.outsideRoot).toBe(true);
    expect(file!.path).toBe(join(outside, "demo.mp4"));
  });

  it("refuses an ssh key and NAMES the path — the mutant: a prompt the user could approve", async () => {
    const error = await failure([join(outside, ".ssh", "id_rsa")]);
    expect(error).toContain(join(outside, ".ssh", "id_rsa"));
    expect(error).toMatch(/refused/);
  });

  it("refuses a symlink whose TARGET is a key, by the target's name", async () => {
    // The mutant this kills: containment and the secret check applied to the requested path rather
    // than to the resolved one. `key.txt` is inside the space folder and looks like a text file.
    const error = await failure([join(root, "key.txt")]);
    expect(error).toContain(".ssh");
  });

  it("follows a benign symlink out of the space folder and reports it as outside, under its real name", async () => {
    const [file] = await ok([join(root, "demo-link.mp4")]);
    expect(file!.outsideRoot).toBe(true);
    expect(file!.name).toBe("demo.mp4");
    expect(file!.requested).toBe(join(root, "demo-link.mp4"));
  });

  it("refuses a .env inside the space folder — approval of the directory does not reach it", async () => {
    expect(await failure([join(root, ".env")])).toMatch(/refused/);
  });

  it("refuses a path that does not exist, as a missing file rather than a permission problem", async () => {
    expect(await failure([join(root, "nope.png")])).toContain("no such file");
  });

  it("refuses a directory", async () => {
    expect(await failure([join(root, "gallery")])).toContain("not a file");
  });

  it("refuses ~/.ssh/id_rsa as a KEY, not as a syntax error — a tilde is not a spelling correction", async () => {
    const error = await failure(["~/.ssh/id_rsa"]);
    expect(error).toContain("~/.ssh/id_rsa");
    expect(error).toMatch(/refused/);
    expect(error).not.toContain("absolute");
  });

  it("refuses a relative path", async () => {
    expect(await failure(["gallery/hero.png"])).toContain("absolute");
  });

  it("refuses the same file listed twice", async () => {
    const p = join(root, "gallery", "hero.png");
    expect(await failure([p, p])).toContain("twice");
  });

  it("is all-or-nothing: one bad path refuses the whole call", async () => {
    // The mutant: a best-effort resolve that uploads four of the five the user approved.
    const error = await failure([join(root, "gallery", "hero.png"), join(outside, ".ssh", "id_rsa")]);
    expect(error).toMatch(/refused/);
  });

  it("caps the number of files in one call", async () => {
    const many = Array.from({ length: 21 }, (_, i) => join(root, "gallery", `f${i}.png`));
    expect(await failure(many)).toContain("at most");
  });

  it("with no space folder, every path counts as outside — more shown, not less", async () => {
    const r = await resolveUploadPaths([join(root, "gallery", "hero.png")], null);
    expect(r.ok && r.files[0]!.outsideRoot).toBe(true);
  });

  it("a space folder reached through a symlink still contains its own files", async () => {
    // macOS's /tmp is a symlink to /private/tmp; comparing a resolved file against an unresolved
    // root is how every file in a space reports itself as outside it.
    const linkedRoot = join(root, "..", "space-link");
    await symlink(root, linkedRoot).catch(() => {});
    const r = await resolveUploadPaths([join(root, "gallery", "hero.png")], linkedRoot);
    expect(r.ok && r.files[0]!.outsideRoot).toBe(false);
  });
});
