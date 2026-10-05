import { beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tempDir } from "@realm/test-utils";
import { join } from "node:path";
import { InstalledApps, dockBundleIds, icnsPng, parseBinaryPlist, parsePlist, parseXmlPlist, scanApplications } from "./installed-apps";

/**
 * The scan, against bundles laid out on disk the way macOS lays them out — never against this Mac,
 * whose Applications folder is nobody's fixture. What must die here: a background daemon or a
 * forbidden app in the list, a helper from inside a bundle, the binary plist going unread, the
 * wrong PNG cut from an `.icns`, and an icon read for a path the scan never found.
 */

/** A minimal `bplist00` writer — enough to stand in for what `plutil -convert binary1` writes. */
function bplist(root: unknown): Uint8Array {
  const objects: number[][] = [];
  const header = (marker: number, n: number) => (n < 15 ? [marker | n] : [marker | 0x0f, 0x10, n]);
  const add = (v: unknown): number => {
    const at = objects.length;
    objects.push([]);
    let bytes: number[];
    if (typeof v === "boolean") bytes = [v ? 0x09 : 0x08];
    else if (typeof v === "number") bytes = [0x11, (v >> 8) & 0xff, v & 0xff];
    else if (typeof v === "string") {
      if (/^[\x00-\x7f]*$/.test(v)) bytes = [...header(0x50, v.length), ...[...v].map((c) => c.charCodeAt(0))];
      else bytes = [...header(0x60, v.length), ...[...v].flatMap((c) => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 0xff])];
    } else if (Array.isArray(v)) {
      const refs = v.map(add);
      bytes = [...header(0xa0, refs.length), ...refs];
    } else {
      const entries = Object.entries(v as Record<string, unknown>);
      const keys = entries.map(([k]) => add(k));
      const vals = entries.map(([, x]) => add(x));
      bytes = [...header(0xd0, entries.length), ...keys, ...vals];
    }
    objects[at] = bytes;
    return at;
  };
  add(root);
  const out: number[] = [...Buffer.from("bplist00")];
  const offsets: number[] = [];
  for (const o of objects) { offsets.push(out.length); out.push(...o); }
  const table = out.length;
  for (const off of offsets) out.push((off >> 8) & 0xff, off & 0xff);
  const u64 = (n: number) => [0, 0, 0, 0, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  out.push(0, 0, 0, 0, 0, 0, 2, 1, ...u64(objects.length), ...u64(0), ...u64(table));
  return Uint8Array.from(out);
}

const xmlPlist = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>
`;
const keys = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `\t<key>${k}</key>\n\t<string>${v}</string>`).join("\n");

const PNG = (tag: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tag)]);
/** An `.icns`: the magic, the total length, then each chunk as type, length (header included), data. */
function icns(chunks: [string, Buffer][]): Buffer {
  const parts = chunks.map(([type, data]) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, "latin1");
    head.writeUInt32BE(8 + data.length, 4);
    return Buffer.concat([head, data]);
  });
  const head = Buffer.alloc(8);
  head.write("icns", 0, "latin1");
  head.writeUInt32BE(8 + parts.reduce((n, p) => n + p.length, 0), 4);
  return Buffer.concat([head, ...parts]);
}

let root: string;
const at = (...p: string[]) => join(root, ...p);
function bundle(dir: string, name: string, plist: string | Uint8Array, resources: Record<string, Buffer> = {}) {
  const contents = join(dir, `${name}.app`, "Contents");
  mkdirSync(join(contents, "Resources"), { recursive: true });
  writeFileSync(join(contents, "Info.plist"), plist);
  for (const [file, bytes] of Object.entries(resources)) writeFileSync(join(contents, "Resources", file), bytes);
  return join(dir, `${name}.app`);
}

beforeEach(() => {
  root = tempDir("realm-apps-");
  const apps = at("Applications");
  mkdirSync(apps, { recursive: true });
  // An XML plist with everything a real one carries around the keys that matter: a comment, a date,
  // data, and a nested array of dicts whose own keys must not leak to the top.
  bundle(apps, "Sketchpad", xmlPlist(`${keys({ CFBundleIdentifier: "com.example.sketchpad", CFBundleName: "Sketch Pad", CFBundleDisplayName: "Sketchpad", CFBundleIconFile: "AppIcon", CFBundlePackageType: "APPL" })}
	<!-- a comment build tools leave -->
	<key>BuildDate</key>
	<date>2026-01-01T00:00:00Z</date>
	<key>Blob</key>
	<data>AAEC</data>
	<key>CFBundleDocumentTypes</key>
	<array><dict><key>CFBundleIdentifier</key><string>com.example.not-me</string><key>LSBackgroundOnly</key><true/></dict></array>
	<key>LSUIElement</key>
	<true/>`), { "AppIcon.icns": icns([["ic04", Buffer.from("argb")], ["ic11", PNG("32px")], ["ic07", PNG("128px")]]) });
  // App Store builds write binary plists (Keynote's is one). Its icon file carries its extension.
  bundle(apps, "Keyed", bplist({ CFBundleIdentifier: "com.example.keyed", CFBundleName: "Keyed", CFBundleIconFile: "keyed.icns", CFBundlePackageType: "APPL" }),
    { "keyed.icns": icns([["ic07", PNG("only-128")]]) });
  // An asset-catalog app names only CFBundleIconName; Xcode writes an .icns of that name beside it.
  bundle(apps, "Catalog", xmlPlist(keys({ CFBundleIdentifier: "com.example.catalog", CFBundleIconName: "AppIcon" })), { "AppIcon.icns": icns([["ic12", PNG("64px")]]) });
  bundle(apps, "NoIcon", xmlPlist(keys({ CFBundleIdentifier: "com.example.noicon" })));
  bundle(at("Applications", "Utilities"), "Helper", xmlPlist(keys({ CFBundleIdentifier: "com.example.helper" })));
  // Never apps a person mentions: a daemon in a bundle, a framework, an app no agent may drive, a
  // bundle with no plist, and the helper an app carries inside its own Contents.
  bundle(apps, "Daemon", xmlPlist(`${keys({ CFBundleIdentifier: "com.example.daemon" })}\n\t<key>LSBackgroundOnly</key>\n\t<true/>`));
  bundle(apps, "Framework", xmlPlist(keys({ CFBundleIdentifier: "com.example.fw", CFBundlePackageType: "FMWK" })));
  bundle(apps, "Terminal", xmlPlist(keys({ CFBundleIdentifier: "com.apple.Terminal" })));
  mkdirSync(at("Applications", "Broken.app", "Contents"), { recursive: true });
  bundle(at("Applications", "Sketchpad.app", "Contents", "Helpers"), "Inner", xmlPlist(keys({ CFBundleIdentifier: "com.example.inner" })));
  // The same bundle id in the user's own folder: the first folder scanned keeps it.
  bundle(at("User", "Applications"), "Sketchpad copy", xmlPlist(keys({ CFBundleIdentifier: "com.example.sketchpad" })));
});

const dirs = () => [at("Applications"), at("User", "Applications")];

describe("finding the apps on this Mac", () => {
  it("lists every launchable app once, by the name the Finder shows, sorted", async () => {
    const apps = await scanApplications(dirs());
    expect(apps.map((a) => [a.name, a.bundleId])).toEqual([
      ["Catalog", "com.example.catalog"], ["Helper", "com.example.helper"], ["Keyed", "com.example.keyed"],
      ["NoIcon", "com.example.noicon"], ["Sketchpad", "com.example.sketchpad"],
    ]);
    // THE inside-a-bundle mutant (`Inner`), the daemon, the framework, the forbidden Terminal, the
    // plist-less bundle and the duplicate id are all absent from the line above.
    expect(apps.find((a) => a.bundleId === "com.example.sketchpad")?.path).toBe(at("Applications", "Sketchpad.app"));
  });

  it("keeps the other names an app answers to, and only the ones that differ", async () => {
    const sketch = (await scanApplications(dirs())).find((a) => a.name === "Sketchpad")!;
    expect(sketch.aliases).toEqual(["Sketch Pad"]);
  });

  it("finds the icon file whether the plist names it with its extension, without, or only as an asset", async () => {
    const icons = Object.fromEntries((await scanApplications(dirs())).map((a) => [a.name, a.icon]));
    expect(icons.Sketchpad).toBe(at("Applications", "Sketchpad.app", "Contents", "Resources", "AppIcon.icns"));
    expect(icons.Keyed).toBe(at("Applications", "Keyed.app", "Contents", "Resources", "keyed.icns"));
    expect(icons.Catalog).toBe(at("Applications", "Catalog.app", "Contents", "Resources", "AppIcon.icns"));
    expect(icons.NoIcon).toBeNull();
  });

  it("orders by the Dock where it is given one", async () => {
    const apps = await scanApplications(dirs(), ["com.example.keyed", "com.apple.Terminal", "com.example.sketchpad"]);
    expect(Object.fromEntries(apps.map((a) => [a.name, a.dock]))).toEqual({ Catalog: null, Helper: null, Keyed: 0, NoIcon: null, Sketchpad: 2 });
  });
});

describe("reading property lists", () => {
  it("reads the binary encoding, nesting and UTF-16 included", () => {
    expect(parseBinaryPlist(bplist({ a: "x", list: [true, false, 7], nested: { name: "Café" } })))
      .toEqual({ a: "x", list: [true, false, 7], nested: { name: "Café" } });
  });

  it("keeps the top-level keys of an XML plist and nothing from the dicts nested under it", () => {
    const p = parseXmlPlist(xmlPlist(`${keys({ CFBundleIdentifier: "com.a &amp; b" })}\n<key>Inner</key><array><dict><key>CFBundleIdentifier</key><string>nope</string></dict></array>`));
    expect(p).toMatchObject({ CFBundleIdentifier: "com.a & b", Inner: [{ CFBundleIdentifier: "nope" }] });
  });

  it("answers null rather than throwing for a file that is neither encoding", () => {
    expect(parsePlist(Buffer.from("not a plist"))).toBeNull();
    expect(parsePlist(Buffer.from("bplist00 truncated"))).toBeNull();
  });

  it("reads the Dock's apps in its order", () => {
    const dock = bplist({ "persistent-apps": [{ "tile-data": { "bundle-identifier": "com.apple.MobileSMS" } }, { "tile-data": {} }, { "tile-data": { "bundle-identifier": "com.apple.mail" } }] });
    expect(dockBundleIds(parseBinaryPlist(dock))).toEqual(["com.apple.MobileSMS", "com.apple.mail"]);
  });
});

describe("cutting a PNG out of an .icns", () => {
  it("takes the smallest PNG big enough, skipping the chunks that are not PNG", async () => {
    const cut = await icnsPng(at("Applications", "Sketchpad.app", "Contents", "Resources", "AppIcon.icns"), 32);
    expect(cut?.px).toBe(32);
    expect(Buffer.from(cut!.png).subarray(8).toString()).toBe("32px");
  });

  it("falls back to the biggest there is when none is big enough", async () => {
    const cut = await icnsPng(at("Applications", "Keyed.app", "Contents", "Resources", "keyed.icns"), 256);
    expect(cut?.px).toBe(128);
  });

  it("answers null for a file with no PNG in it, or no icns magic at all", async () => {
    const rle = at("rle.icns");
    writeFileSync(rle, icns([["is32", Buffer.from("rle")], ["s8mk", Buffer.from("mask")]]));
    expect(await icnsPng(rle, 32)).toBeNull();
    writeFileSync(at("fake.icns"), "not an icon");
    expect(await icnsPng(at("fake.icns"), 32)).toBeNull();
  });
});

describe("the kept scan", () => {
  let clock = 1_000_000;
  const make = (over: { fallback?: (p: string) => Promise<string | null> } = {}) => {
    const converted: { tag: string; px: number }[] = [];
    const apps = new InstalledApps({
      dirs, dockPlist: () => null, now: () => clock,
      toDataUrl: (png, px) => { const tag = Buffer.from(png).subarray(8).toString(); converted.push({ tag, px }); return `data:${tag}`; },
      ...(over.fallback ? { fallbackIcon: over.fallback } : {}),
    });
    return { apps, converted };
  };

  it("hands out icons only for bundles its own scan found", async () => {
    const { apps } = make();
    const sketch = at("Applications", "Sketchpad.app");
    // THE trusting mutant: read whatever path the renderer names.
    const out = await apps.icons([sketch, "/etc/passwd", at("Applications", "Daemon.app")]);
    expect(out).toEqual({ [sketch]: "data:32px" });
  });

  it("reads each icon once, and asks the system only for a bundle with no .icns", async () => {
    const asked: string[] = [];
    const { apps, converted } = make({ fallback: async (p) => { asked.push(p); return "data:catalog"; } });
    const noIcon = at("Applications", "NoIcon.app"), sketch = at("Applications", "Sketchpad.app");
    expect(await apps.icons([noIcon, sketch])).toEqual({ [noIcon]: "data:catalog", [sketch]: "data:32px" });
    await apps.icons([noIcon, sketch]);
    expect(asked).toEqual([noIcon]);
    expect(converted).toEqual([{ tag: "32px", px: 32 }]);
  });

  it("lists a newly installed app once its folder changes", async () => {
    const { apps } = make();
    expect((await apps.list()).map((a) => a.name)).not.toContain("Fresh");
    bundle(at("Applications"), "Fresh", xmlPlist(keys({ CFBundleIdentifier: "com.example.fresh" })));
    // The folder's mtime is what the cache keys on — set it plainly later, in case the write landed
    // in the same millisecond — and the clock past the window in which a scan is trusted unasked.
    const later = new Date(Date.now() + 60_000);
    utimesSync(at("Applications"), later, later);
    expect((await apps.list()).map((a) => a.name)).not.toContain("Fresh");
    clock += 5_000;
    expect((await apps.list()).map((a) => a.name)).toContain("Fresh");
  });
});
