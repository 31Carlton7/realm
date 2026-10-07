import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { FontsService, parseCatalog, parseFaces } from "./service";
import { RpcError } from "../store/rows";

let home: string;
afterEach(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => { home = tempDir("realm-fonts-"); });

/** The shape css2 really answers with: every weight repeated once per unicode subset, each block
 *  preceded by the subset's name, and NOT in a helpful order — JetBrains Mono leads with Cyrillic. */
const CSS = `
/* cyrillic-ext */
@font-face { font-family: 'Inter'; font-weight: 400; src: url(https://x/400-cyrillic-ext.woff2) format('woff2'); }
/* cyrillic */
@font-face { font-family: 'Inter'; font-weight: 400; src: url(https://x/400-cyrillic.woff2) format('woff2'); }
/* latin-ext */
@font-face { font-family: 'Inter'; font-weight: 400; src: url(https://x/400-latin-ext.woff2) format('woff2'); }
/* latin */
@font-face { font-family: 'Inter'; font-weight: 400; src: url(https://x/400-latin.woff2) format('woff2'); }
/* latin */
@font-face { font-family: 'Inter'; font-weight: 500; src: url(https://x/500-latin.woff2) format('woff2'); }
`;

/** A fetch that answers the css2 request with `CSS` and every file request with bytes. */
const fakeFetch = (over: Partial<Record<string, () => Response>> = {}) =>
  vi.fn(async (url: string | URL) => {
    const u = String(url);
    const hit = Object.entries(over).find(([k]) => u.includes(k))?.[1];
    if (hit) return hit();
    if (u.includes("css2")) return new Response(CSS, { status: 200 });
    if (u.includes("metadata/fonts")) return new Response(JSON.stringify({ familyMetadataList: [
      { family: "Inter", category: "Sans Serif" }, { family: "Fira Code", category: "Monospace" },
    ] }), { status: 200 });
    return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
  }) as unknown as typeof fetch;

describe("parseFaces", () => {
  it("takes the LATIN file per weight, not the first one", () => {
    /* THE MUTANT, and the one that shipped: take the first block per weight. css2 does not lead with
       latin — JetBrains Mono leads with `cyrillic-ext` — so this downloaded a 1.6KB slice of Cyrillic
       and called it the font. The app then rendered the chosen face with a few dozen glyphs and the
       fallback stack for everything else. Only a real download shows it; the byte count gave it away. */
    expect(parseFaces(CSS)).toEqual([
      { weight: 400, url: "https://x/400-latin.woff2" },
      { weight: 500, url: "https://x/500-latin.woff2" },
    ]);
  });

  it("still finds faces in a response with no subset comments at all", () => {
    // Some families answer without them, and a parser that needed them would import nothing.
    expect(parseFaces(`@font-face { font-weight: 400; src: url(https://x/a.woff2); }`))
      .toEqual([{ weight: 400, url: "https://x/a.woff2" }]);
  });

  it("is empty rather than wrong for a response with no faces in it", () => {
    expect(parseFaces("<!doctype html><h1>Not found</h1>")).toEqual([]);
  });
});

describe("parseCatalog", () => {
  it("cuts two thousand entries down to what a picker needs, and marks the mono ones", () => {
    /* The code-face picker must not offer a proportional family: a monospace layout in a display
       face is unreadable in a way the user cannot undo without finding this setting again. */
    const out = parseCatalog(JSON.stringify({ familyMetadataList: [
      { family: "Fira Code", category: "Monospace" }, { family: "Inter", category: "Sans Serif" },
    ] }));
    expect(out).toEqual([
      { family: "Fira Code", category: "Monospace", mono: true },
      { family: "Inter", category: "Sans Serif", mono: false },
    ]);
  });

  it("drops a family whose name could not go in a CSS stack or a path", () => {
    expect(parseCatalog(JSON.stringify({ familyMetadataList: [{ family: 'a"; x', category: "" }] }))).toEqual([]);
  });

  it("survives the anti-hijacking prefix Google puts on some routes", () => {
    expect(parseCatalog(`)]}'\n{"familyMetadataList":[{"family":"Inter","category":"Sans Serif"}]}`))
      .toHaveLength(1);
  });
});

describe("FontsService", () => {
  it("is empty, not an error, before anything is installed", () => {
    expect(new FontsService({ home }).list()).toEqual([]);
  });

  it("downloads a family's files and keeps them on this Mac", async () => {
    /* The point of the whole service: one network call when you pick a family, and then never again.
       An app that re-fetches its own typeface from Google every launch has no text on a plane. */
    const svc = new FontsService({ home, fetch: fakeFetch() });
    const m = await svc.install("Inter");
    expect(m).toEqual({ family: "Inter", weights: [400, 500], bytes: 8 });
    expect(existsSync(join(home, "fonts", "inter", "400.woff2"))).toBe(true);
    expect(existsSync(join(home, "fonts", "inter", "500.woff2"))).toBe(true);
    expect(svc.list()).toEqual([m]);
  });

  it("writes the manifest LAST, so an interrupted download is skipped rather than half-offered", async () => {
    // THE MUTANT: write it first. `list` treats the manifest as "complete", so a download that died
    // after it would offer a family whose files are not there — a face that renders as nothing.
    const svc = new FontsService({ home, fetch: fakeFetch({ "500-latin": () => new Response("", { status: 500 }) }) });
    await expect(svc.install("Inter")).rejects.toThrow(RpcError);
    expect(existsSync(join(home, "fonts", "inter", "font.json"))).toBe(false);
    expect(svc.list()).toEqual([]);
  });

  it("replaces a family's files on reinstall rather than mixing two downloads", async () => {
    const svc = new FontsService({ home, fetch: fakeFetch() });
    await svc.install("Inter");
    writeFileSync(join(home, "fonts", "inter", "900.woff2"), "stale");
    await svc.install("Inter");
    expect(readdirSync(join(home, "fonts", "inter")).sort()).toEqual(["400.woff2", "500.woff2", "font.json"]);
  });

  it("refuses a family name that could escape the folder or the CSS stack", async () => {
    const svc = new FontsService({ home, fetch: fakeFetch() });
    for (const bad of ["../etc", 'a"; x', "a/b"]) {
      await expect(svc.install(bad), bad).rejects.toThrow(RpcError);
    }
  });

  it("hands the renderer the bytes to build @font-face from, newest weight order", async () => {
    const svc = new FontsService({ home, fetch: fakeFetch() });
    await svc.install("Inter");
    expect(svc.faces("Inter").map((f) => f.weight)).toEqual([400, 500]);
    expect(svc.faces("Inter")[0]!.base64).toBe(Buffer.from([1, 2, 3, 4]).toString("base64"));
    expect(svc.faces("Nothing")).toEqual([]);
  });

  it("caches the catalog, so opening the picker is not a 2.7MB download every time", async () => {
    const f = fakeFetch();
    const svc = new FontsService({ home, fetch: f });
    expect(await svc.catalog()).toHaveLength(2);
    expect(await svc.catalog()).toHaveLength(2);
    const calls = (f as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter((c) => String(c[0]).includes("metadata/fonts"));
    expect(calls).toHaveLength(1);
  });

  it("serves a STALE catalog rather than an empty one when the network is gone", async () => {
    // A day-old list of font names is worth far more than no list; only a first run with no network
    // has nothing to fall back to.
    const svc = new FontsService({ home, fetch: fakeFetch() });
    await svc.catalog();
    const cache = join(home, "fonts", "catalog.json");
    writeFileSync(cache, JSON.stringify({ at: 0, fonts: [{ family: "Old", category: "Serif", mono: false }] }));
    const offline = new FontsService({ home, fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
    expect((await offline.catalog()).map((x) => x.family)).toEqual(["Old"]);
  });

  it("says so when there is no network AND no cache", async () => {
    const svc = new FontsService({ home, fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
    await expect(svc.catalog()).rejects.toThrow(RpcError);
  });

  it("removes a family's files", async () => {
    const svc = new FontsService({ home, fetch: fakeFetch() });
    await svc.install("Inter");
    svc.remove("Inter");
    expect(svc.list()).toEqual([]);
  });

  it("skips a folder with no manifest rather than offering a font with no files", async () => {
    const svc = new FontsService({ home, fetch: fakeFetch() });
    await svc.install("Inter");
    mkdirSync(join(home, "fonts", "half-done"), { recursive: true });
    expect(svc.list().map((f) => f.family)).toEqual(["Inter"]);
  });
});
