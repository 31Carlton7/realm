import { readFileSync } from "node:fs";
import { contentWords } from "../../src/laya/benchmark";
const lex = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as { labels: Record<string, string[]> };
const more = JSON.parse(readFileSync(process.argv[3]!, "utf8")) as Record<string, Record<string, string[]>>;
const taught = [...Object.values(lex.labels).flat(), ...Object.keys(lex.labels).flatMap((l) => { const p = l.replace(/^[^:]+:/, "").split(", ")[0]!; return [p, `open ${p}`, `tap ${p}`, `go to ${p}`]; })].map((p) => ({ p, w: new Set(contentWords(p)) }));
for (const [screen, byEl] of Object.entries(more)) for (const [el, intents] of Object.entries(byEl)) for (const i of intents) {
  const w = new Set(contentWords(i));
  let worst = 0, who = "";
  for (const t of taught) { let both = 0; for (const x of w) if (t.w.has(x)) both++; const j = both / (w.size + t.w.size - both); if (j > worst) { worst = j; who = t.p; } }
  if (worst >= 0.75) console.log(`LEAK ${screen} / ${el} / "${i}" ~ "${who}" (${worst.toFixed(2)})`);
}
