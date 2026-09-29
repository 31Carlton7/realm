/**
 * Builds Laya's benchmark (`resources/laya/benchmark/`) from a crawl and the authored cases.
 *
 *   pnpm --filter @realm/server exec tsx scripts/laya/bench-build.ts [crawl dir]
 *
 * The crawl dir (default /tmp/laya-train/crawl) is what `sim.mjs` wrote: `screens/*.json` and
 * `pairs/*.json`. Only the reads the cases use are kept, cleaned by `dropElement`. Every case is checked
 * as it is built — an element that does not resolve to exactly one element on its screen, a target
 * with no label (Assist never offers one), a repeated case — and the build fails on any of them rather
 * than writing a benchmark with holes in it.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HELDOUT_APPS, HELDOUT_SHARE, SCREENS, VALIDATION_APPS, VALIDATION_SHARE, dropElement } from "./bench/screens";
import { SENSITIVE } from "./bench/sensitive";
import { TARGET } from "./bench/target";
import { VERIFY } from "./bench/verify";
import { BENCHMARK_VERSION, labelCopies, splitOf, type BenchElement, type BenchPair, type BenchScreen, type SensitiveBenchCase, type Split, type TargetBenchCase, type VerifyBenchCase } from "../../src/laya/benchmark";

const here = dirname(fileURLToPath(import.meta.url));
const crawl = resolve(process.argv[2] ?? "/tmp/laya-train/crawl");
const out = resolve(here, "../../../../resources/laya/benchmark");

type Raw = { path?: string; id?: string | null; role: string; label: string; value?: string; frame?: unknown };
const errors: string[] = [];
const fail = (msg: string) => errors.push(msg);

function elementsOf(app: string, raw: Raw[]): BenchElement[] {
  return raw
    .filter((e) => !dropElement(app, e))
    .map((e) => {
      const id = e.path ?? String(e.id);
      const f = e.frame as { x: number; y: number; width: number; height: number } | number[] | undefined;
      const frame = Array.isArray(f) ? f : f ? [f.x, f.y, f.width, f.height].map(Math.round) : undefined;
      return { id, role: e.role, label: e.label, ...(e.value ? { value: e.value } : {}), ...(frame ? { frame } : {}) };
    });
}

function readJson(file: string): any {
  return JSON.parse(readFileSync(join(crawl, `${file}.json`), "utf8"));
}

/* ---------------------------------- screens ---------------------------------- */

const screens = new Map<string, BenchScreen>();
for (const s of SCREENS) {
  const [file, side] = s.from.split("#");
  const raw = readJson(file!);
  const elements = side ? elementsOf(s.app, raw[side]) : elementsOf(s.app, raw.elements);
  screens.set(s.id, { id: s.id, app: s.app, from: s.from, elements });
}

/** `Label`, `~start of label`, `Label#2`, `@path`; the first alternative of `a | b` is the element. */
function resolveOne(screen: BenchScreen, selector: string): BenchElement | null {
  const tidy = (s: string) => s.replace(/￼/g, "").replace(/\s+/g, " ").trim();
  let sel = selector.trim();
  if (sel.startsWith("@")) return screen.elements.find((e) => e.id === sel.slice(1)) ?? null;
  let nth = 1;
  const m = /^(.*)#(\d+)$/.exec(sel);
  if (m && !sel.startsWith("#")) { sel = m[1]!; nth = Number(m[2]); }
  const prefix = sel.startsWith("~");
  const want = tidy(prefix ? sel.slice(1) : sel);
  const hits = screen.elements.filter((e) => (prefix ? tidy(e.label).startsWith(want) : tidy(e.label) === want));
  if (hits.length === 0) return null;
  if (m) return hits[nth - 1] ?? null;
  if (hits.length > 1) { fail(`${screen.id}: "${selector}" names ${hits.length} elements; say which with #n`); return null; }
  return hits[0]!;
}

function resolveAll(screenId: string, selector: string): BenchElement[] {
  const screen = screens.get(screenId);
  if (!screen) { fail(`no screen ${screenId}`); return []; }
  const found = selector.split(" | ").map((s) => resolveOne(screen, s));
  if (found.some((e) => !e)) { fail(`${screenId}: "${selector}" does not resolve`); return []; }
  return found as BenchElement[];
}

function split(app: string, key: string): Split {
  return splitOf(app, key, { heldoutApps: HELDOUT_APPS, validationApps: VALIDATION_APPS, heldoutShare: HELDOUT_SHARE, validationShare: VALIDATION_SHARE });
}

/* ---------------------------------- cases ---------------------------------- */

const seen = new Set<string>();
const once = (key: string) => { if (seen.has(key)) fail(`repeated case: ${key}`); seen.add(key); };

const target: TargetBenchCase[] = [];
for (const [screenId, byElement] of Object.entries(TARGET)) {
  for (const [selector, intents] of Object.entries(byElement)) {
    const [el, ...also] = resolveAll(screenId, selector);
    if (!el) continue;
    if (!el.label.trim()) fail(`${screenId}: "${selector}" has no label; Assist never offers an unlabelled element`);
    const app = screens.get(screenId)!.app;
    for (const intent of intents) {
      const key = `target:${screenId}:${el.id}:${intent}`;
      once(key);
      target.push({
        id: `t${String(target.length + 1).padStart(4, "0")}`, split: split(app, key), app, screen: screenId, element: el.id,
        ...(also.length ? { alsoRight: also.map((e) => e.id) } : {}), intent, copies: labelCopies(intent, el.label),
      });
    }
  }
}

const sensitive: SensitiveBenchCase[] = [];
for (const c of SENSITIVE) {
  const [el] = resolveAll(c.screen, c.element);
  if (!el) continue;
  const app = screens.get(c.screen)!.app;
  const key = `sensitive:${c.screen}:${el.id}:${c.tool}:${c.intent}`;
  once(key);
  sensitive.push({ id: `s${String(sensitive.length + 1).padStart(4, "0")}`, split: split(app, key), app, screen: c.screen, element: el.id, tool: c.tool, intent: c.intent, sensitive: c.sensitive, part: c.part });
}

const PAIR_APP: [RegExp, string][] = [
  [/^v-safari-clear$/, "Settings"], [/^v-cal-/, "Calendar"], [/^v-contacts-/, "Contacts"], [/^v-files-/, "Files"], [/^v-fit-/, "Fitness"],
  [/^v-health-/, "Health"], [/^v-maps-/, "Maps"], [/^v-msg-/, "Messages"], [/^v-news-/, "News"], [/^v-photos-/, "Photos"],
  [/^v-pw-/, "Passwords"], [/^v-rem-/, "Reminders"], [/^v-remote-/, "Remote"], [/^v-safari-/, "Safari"], [/^v-sc-/, "Shortcuts"],
  [/^v-wallet-/, "Wallet"], [/^v-watch-/, "Watch"],
];
const appOfPair = (id: string) => PAIR_APP.find(([re]) => re.test(id))?.[1] ?? "Settings";

const pairs = new Map<string, BenchPair>();
const verify: VerifyBenchCase[] = [];
for (const c of VERIFY) {
  if (!existsSync(join(crawl, "pairs", `${c.pair}.json`))) { fail(`no pair ${c.pair}`); continue; }
  if (!pairs.has(c.pair)) {
    const raw = readJson(`pairs/${c.pair}`);
    const app = appOfPair(c.pair);
    const action = String(raw.action);
    const tool = action.startsWith("type:") ? "simulator_type" : action.startsWith("swipe:") ? "simulator_swipe" : "simulator_tap";
    pairs.set(c.pair, {
      id: c.pair, app, tool, action: action.startsWith("type:") ? `type "${action.slice(5)}"` : action.startsWith("swipe:") ? `swipe ${action.slice(6)}` : "tap",
      ...(raw.target ? { target: { id: raw.target.id, role: raw.target.role, label: raw.target.label, ...(raw.target.value ? { value: raw.target.value } : {}) } } : {}),
      before: elementsOf(app, raw.before), after: elementsOf(app, raw.after),
    });
  }
  const p = pairs.get(c.pair)!;
  const key = `verify:${c.pair}:${c.intent}`;
  once(key);
  verify.push({ id: `v${String(verify.length + 1).padStart(4, "0")}`, split: split(p.app, key), app: p.app, pair: c.pair, tool: p.tool, intent: c.intent, achieved: c.achieved, kind: c.kind });
}

if (errors.length) {
  console.error(errors.map((e) => `  ${e}`).join("\n"));
  console.error(`\n${errors.length} problem(s); nothing written.`);
  process.exit(1);
}

/* ---------------------------------- write ---------------------------------- */

const used = new Set([...target.map((c) => c.screen), ...sensitive.map((c) => c.screen)]);
rmSync(join(out, "screens"), { recursive: true, force: true });
rmSync(join(out, "pairs"), { recursive: true, force: true });
mkdirSync(join(out, "screens"), { recursive: true });
mkdirSync(join(out, "pairs"), { recursive: true });
mkdirSync(join(out, "cases"), { recursive: true });
for (const s of screens.values()) if (used.has(s.id)) writeFileSync(join(out, "screens", `${s.id}.json`), JSON.stringify(s) + "\n");
for (const p of pairs.values()) writeFileSync(join(out, "pairs", `${p.id}.json`), JSON.stringify(p) + "\n");
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
writeFileSync(join(out, "cases", "target.jsonl"), jsonl(target));
writeFileSync(join(out, "cases", "sensitive.jsonl"), jsonl(sensitive));
writeFileSync(join(out, "cases", "verify.jsonl"), jsonl(verify));

const count = <T extends { split: Split }>(rows: T[]) => ({ train: rows.filter((r) => r.split === "train").length, validation: rows.filter((r) => r.split === "validation").length, heldout: rows.filter((r) => r.split === "heldout").length });
const apps = [...new Set([...screens.values()].filter((s) => used.has(s.id)).map((s) => s.app).concat([...pairs.values()].map((p) => p.app)))].sort();
const manifest = {
  version: BENCHMARK_VERSION,
  device: "iPhone 17 Pro Max simulator, iOS 27",
  apps,
  split: { heldoutApps: HELDOUT_APPS, validationApps: VALIDATION_APPS, heldoutShare: HELDOUT_SHARE, validationShare: VALIDATION_SHARE },
  counts: {
    screens: used.size, pairs: pairs.size,
    target: { ...count(target), all: target.length, notCopying: target.filter((c) => !c.copies).length },
    sensitive: { ...count(sensitive), all: sensitive.length, positive: sensitive.filter((c) => c.sensitive).length },
    verify: { ...count(verify), all: verify.length, achieved: verify.filter((c) => c.achieved).length },
  },
};
writeFileSync(join(out, "benchmark.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest.counts, null, 2));
console.log(`apps: ${apps.join(", ")}`);
console.log(`wrote ${out}`);
