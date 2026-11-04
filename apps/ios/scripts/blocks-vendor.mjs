// KaTeX and Mermaid for the phone's transcript, vendored from the exact releases the desktop locks
// (pnpm-lock.yaml), into apps/ios/Realm/Blocks/vendor/ beside the page that draws with them.
//
//   node apps/ios/scripts/blocks-vendor.mjs
//
// KaTeX ships as built: its script, its stylesheet and its WOFF2 faces (WebKit never falls through to
// the WOFF and TTF copies the stylesheet also names). Mermaid's one-file build is 5.5 MB, nearly all of
// it diagram kinds a transcript rarely draws, so it is bundled again from its own ES chunks with only
// the kinds kept in `DIAGRAMS`: every other kind's chunk is a stub that fails to load, which Mermaid
// reports as an error, and the block stays its code — as a diagram Mermaid cannot draw does anywhere.
// The tarballs are checked against the registry's integrity before anything is read out of them.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "../Realm/Blocks/vendor");

const KATEX = { name: "katex", version: "0.16.47", integrity: "sha512-Eeo8Ys1doU1z+x8AZsPpQu+p/QcZBI5PeOo7QGQdy2x2m0MU/hYagBbGOmXwr5KVbEfVuWv9LpnQWeehogurjg==" };
const MERMAID = { name: "mermaid", version: "12.1.0", integrity: "sha512-wlVCp+8eTupfCeeFvoZNNiTuHrvag0P2jz/ILgb/f/6jkVokUefOcujefi8qUe/j2asHiSePncVsz/xzzA80LQ==" };
const ESBUILD = "esbuild@0.27.7";

/** The diagram kinds the phone draws, by the name each chunk starts with. Layout helpers they need
 *  (dagre, sizeCapture, the shared chunks) are kept whole. */
const DIAGRAMS = ["flowDiagram", "sequenceDiagram", "classDiagram-v2", "stateDiagram-v2", "erDiagram"];
/** Chunks no kept kind reaches but which the entry or a shared chunk imports lazily: the grammar
 *  parsers of the kinds left out. */
const DROPPED = ["architecture-", "cynefin-", "eventmodeling-", "gitGraph-", "info-", "packet-", "pie-", "radar-", "railroad-",
  "treeView-", "treemap-", "wardley-"];
/** Layouts no kept kind is laid out with, and KaTeX for maths in labels: left empty rather than
 *  failing, since Mermaid registers them all up front. ELK stays: it is Mermaid 12's default layout,
 *  and the desktop's flowcharts are laid out with it. */
const EMPTIED = ["cose-bilkent-", "katex-"];

function fetchPackage({ name, version, integrity }, into) {
  const file = execFileSync("npm", ["pack", `${name}@${version}`, "--silent", "--pack-destination", into], { encoding: "utf8" }).trim().split("\n").at(-1);
  const tarball = join(into, file);
  const digest = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
  if (digest !== integrity) throw new Error(`${name}@${version} does not match its integrity: ${digest}`);
  const dir = join(into, name);
  mkdirSync(dir);
  execFileSync("tar", ["-xzf", tarball, "-C", dir]);
  return join(dir, "package");
}

const work = mkdtempSync(join(tmpdir(), "realm-blocks-"));
try {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, "fonts"), { recursive: true });

  const katex = fetchPackage(KATEX, work);
  copyFileSync(join(katex, "dist/katex.min.js"), join(OUT, "katex.min.js"));
  copyFileSync(join(katex, "dist/katex.min.css"), join(OUT, "katex.min.css"));
  for (const font of readdirSync(join(katex, "dist/fonts")).filter((f) => f.endsWith(".woff2"))) {
    copyFileSync(join(katex, "dist/fonts", font), join(OUT, "fonts", font));
  }
  copyFileSync(join(katex, "LICENSE"), join(OUT, "LICENSE-katex.txt"));

  const mermaid = fetchPackage(MERMAID, work);
  const chunks = join(mermaid, "dist/chunks/mermaid.esm.min");
  const kept = [];
  for (const file of readdirSync(chunks).filter((f) => f.endsWith(".mjs"))) {
    const isDiagram = /Diagram|-definition-/.test(file) && !file.startsWith("chunk-");
    const drop = DROPPED.some((prefix) => file.startsWith(prefix)) || (isDiagram && !DIAGRAMS.some((d) => file.startsWith(`${d}-`)));
    if (EMPTIED.some((prefix) => file.startsWith(prefix))) writeFileSync(join(chunks, file), "export {};\n");
    else if (drop) writeFileSync(join(chunks, file), `throw new Error("This kind of diagram is not drawn on the phone (${file})");\n`);
    else if (isDiagram) kept.push(file);
  }
  if (kept.length !== DIAGRAMS.length) throw new Error(`expected ${DIAGRAMS.length} diagram chunks, kept ${kept.join(", ")}`);
  writeFileSync(join(work, "entry.mjs"), `import mermaid from ${JSON.stringify(join(mermaid, "dist/mermaid.esm.min.mjs"))};\nglobalThis.mermaid = mermaid;\n`);
  execFileSync("npx", ["--yes", ESBUILD, join(work, "entry.mjs"), "--bundle", "--minify", "--format=iife", "--target=safari18",
    "--legal-comments=none", "--log-override:equals-negative-zero=silent", `--outfile=${join(OUT, "mermaid.min.js")}`, "--log-level=warning"], { stdio: "inherit" });
  copyFileSync(join(mermaid, "LICENSE"), join(OUT, "LICENSE-mermaid.txt"));

  const size = (f) => readFileSync(join(OUT, f)).length;
  const fonts = readdirSync(join(OUT, "fonts")).reduce((n, f) => n + size(join("fonts", f)), 0);
  console.log(`mermaid.min.js ${size("mermaid.min.js")} B, katex.min.js ${size("katex.min.js")} B, katex fonts ${fonts} B`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
