import { it } from "vitest";
import { writeFileSync } from "node:fs";
import { openDatabase } from "../db/database";
import { SettingsStore } from "../store/settings";
import { UsageService } from "./service";
import { parseModelCatalog } from "@realm/contracts";

// Scratch probe, never committed: prints what the Usage page would show for a COPY of a real home.
it.skipIf(!process.env.USAGE_PROBE_DB)("probe", async () => {
  const db = openDatabase(process.env.USAGE_PROBE_DB!);
  const settings = new SettingsStore(db);
  const cat = settings.get("models.catalog") as { rows: unknown[] } | undefined;
  const rows = (cat?.rows ?? []) as never[];
  const svc = new UsageService({ db, settings, catalog: { list: async () => rows }, now: () => Date.now() });
  const now = Date.now();
  const oct = new Date(2026, 9, 1).getTime();
  const out: Record<string, unknown> = {};
  for (const [name, from] of [["october", oct], ["last30", now - 30 * 86400000], ["all", 0]] as const) {
    const s = await svc.summary({ from, to: now, bucket: "day", spaceId: null, profileId: null });
    out[name] = { totals: s.totals, byAgent: s.breakdowns.agent!.map((r) => ({ k: r.key, t: r.totals })), top: s.sessions.slice(0, 5).map((x) => ({ t: x.title, k: x.agentKind, c: x.totals.costUsd, tok: x.totals.inputTokens + x.totals.outputTokens })), budget: s.budget, unpriced: s.unpricedModels };
  }
  out.records = svc.records().tokens;
  writeFileSync(process.env.USAGE_PROBE_OUT!, JSON.stringify(out, null, 2));
  void parseModelCatalog;
}, 600_000);
