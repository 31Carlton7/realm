import { open, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * The newest plan reading Codex wrote to disk, wherever it ran.
 *
 * Every `token_count` event in a rollout (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`) carries the
 * account's `rate_limits` snapshot beside the tokens — the same snapshot the app-server pushes as
 * `account/rateLimits/updated`, in snake_case. Reading it costs a directory listing and the tail of
 * one file: no process, no request, nothing billed. It is also the only reading that covers Codex
 * run OUTSIDE Realm, which is usage the account's bars include and Realm otherwise never hears of.
 *
 * Read-only, like every other reader of `~/.codex` in this app.
 */
export type CodexRolloutReading = { ts: number; rateLimits: Record<string, unknown> };

/** How much of a rollout's end is read. A token_count lands after every model round trip, so the
 *  last one is never far from the end; rollouts themselves run to tens of megabytes. */
const TAIL_BYTES = 256 * 1024;
/** How many of the newest rollouts are tried before giving up — a rollout can end before its first
 *  turn (a session opened and closed), and then holds no reading at all. */
const FILES_TRIED = 8;

export async function latestCodexRateLimits(codexHome: string): Promise<CodexRolloutReading | null> {
  for (const file of await newestRollouts(join(codexHome, "sessions"), FILES_TRIED)) {
    const reading = await lastReadingIn(file);
    if (reading) return reading;
  }
  return null;
}

/** The newest rollout paths, newest first. Walks the date directories from the end, so a home with
 *  years of history costs a handful of listings rather than one of everything. */
async function newestRollouts(root: string, limit: number): Promise<string[]> {
  const out: string[] = [];
  const desc = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).filter((n) => !n.startsWith(".")).sort().reverse();
  for (const y of await desc(root)) {
    for (const m of await desc(join(root, y))) {
      for (const d of await desc(join(root, y, m))) {
        for (const f of await desc(join(root, y, m, d))) {
          if (f.startsWith("rollout-") && f.endsWith(".jsonl")) out.push(join(root, y, m, d, f));
          if (out.length >= limit) return out;
        }
      }
    }
  }
  return out;
}

async function lastReadingIn(path: string): Promise<CodexRolloutReading | null> {
  let text: string;
  try {
    const fh = await open(path, "r");
    try {
      const { size } = await fh.stat();
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      text = buf.toString("utf8");
    } finally { await fh.close(); }
  } catch { return null; }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes("\"rate_limits\"")) continue;
    let rec: { timestamp?: unknown; payload?: { type?: unknown; rate_limits?: unknown } };
    try { rec = JSON.parse(line); } catch { continue; } // the first line of a tail is usually cut
    const limits = rec.payload?.type === "token_count" ? rec.payload.rate_limits : null;
    const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
    if (!limits || typeof limits !== "object" || Number.isNaN(ts)) continue;
    return { ts, rateLimits: camelSnapshot(limits as Record<string, unknown>) };
  }
  return null;
}

/** The rollout's snake_case snapshot in the app-server's camelCase, so one mapper reads both. */
export function camelSnapshot(s: Record<string, unknown>): Record<string, unknown> {
  const win = (v: unknown) => {
    if (!v || typeof v !== "object") return v ?? null;
    const w = v as Record<string, unknown>;
    return { usedPercent: w.used_percent, windowDurationMins: w.window_minutes, resetsAt: w.resets_at };
  };
  return {
    limitId: s.limit_id ?? null, planType: s.plan_type ?? null,
    rateLimitReachedType: s.rate_limit_reached_type ?? null,
    primary: win(s.primary), secondary: win(s.secondary),
  };
}
