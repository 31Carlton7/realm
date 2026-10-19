import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TeamReviewSummary } from "@realm/contracts";
import { GROUP_LABEL, type InboxGroupKey } from "./review-model";

/** How long a row that left its group stays to fold away: `--dur-swap`, the rung `rl-rv-row-out` runs on. */
const LEAVE_MS = 160;
/** How long a row counts as just arrived: past `--dur-enter`, so a re-render inside the entrance
 *  never takes the mark (and the animation) off halfway. */
const ARRIVED_MS = 600;

export type InboxRow = { review: TeamReviewSummary; leaving: boolean; arrived: boolean };
type Group = { key: InboxGroupKey; label: string; rows: TeamReviewSummary[] };

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/**
 * The inbox's rows as they move. A decision takes a row out of "Waiting for you" and puts it under
 * the group it now belongs to: the one it left folds away where it stood, and the one it joins rises
 * in, so the eye can follow it. The inbox as first drawn arrives whole — only what moves while it is
 * on screen is animated. Under Reduce motion a row simply moves.
 */
export function useMovingRows(groups: Group[]): { key: InboxGroupKey; label: string; rows: InboxRow[] }[] {
  const prev = useRef<Group[] | null>(null);
  const arrivedAt = useRef(new Map<string, number>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const [gone, setGone] = useState<{ key: InboxGroupKey; review: TeamReviewSummary; at: number }[]>([]);

  useLayoutEffect(() => {
    const was = prev.current;
    prev.current = groups;
    if (!was || reducedMotion()) return;
    const left: { key: InboxGroupKey; review: TeamReviewSummary; at: number }[] = [];
    for (const w of was) {
      const after = groups.find((g) => g.key === w.key)?.rows ?? [];
      w.rows.forEach((r, at) => { if (!after.some((a) => a.id === r.id)) left.push({ key: w.key, review: r, at }); });
    }
    if (left.length === 0) return;
    for (const l of left) arrivedAt.current.delete(`${l.key}:${l.review.id}`);
    setGone((g) => [...g.filter((x) => !left.some((l) => l.key === x.key && l.review.id === x.review.id)), ...left]);
    // Not cleared when the groups change again — a second move inside the fold would otherwise strand
    // the first row's ghost for good. Only an unmount takes them.
    const t = setTimeout(() => { timers.current.delete(t); setGone((g) => g.filter((x) => !left.includes(x))); }, LEAVE_MS);
    timers.current.add(t);
  }, [groups]);
  useEffect(() => () => { for (const t of timers.current) clearTimeout(t); }, []);

  // A row is marked as it is first drawn in a group it was not in, so the mark is there on the frame
  // the row mounts — an effect would add it a render late, after the row had already been painted.
  const now = Date.now();
  const was = prev.current;
  if (was && !reducedMotion()) {
    for (const g of groups) {
      const before = was.find((w) => w.key === g.key)?.rows ?? [];
      for (const r of g.rows) if (!before.some((b) => b.id === r.id) && !arrivedAt.current.has(`${g.key}:${r.id}`)) arrivedAt.current.set(`${g.key}:${r.id}`, now);
    }
  }
  const keys = new Set<InboxGroupKey>([...groups.map((g) => g.key), ...gone.map((g) => g.key)]);
  const order: InboxGroupKey[] = ["waiting", "underway", "recent"];
  return order.filter((k) => keys.has(k)).map((key) => {
    const g = groups.find((x) => x.key === key);
    const rows: InboxRow[] = (g?.rows ?? []).map((review) => {
      const t = arrivedAt.current.get(`${key}:${review.id}`);
      return { review, leaving: false, arrived: t !== undefined && now - t < ARRIVED_MS };
    });
    for (const x of [...gone].filter((x) => x.key === key).sort((a, b) => a.at - b.at)) {
      if (!rows.some((r) => r.review.id === x.review.id)) rows.splice(Math.min(x.at, rows.length), 0, { review: x.review, leaving: true, arrived: false });
    }
    return { key, label: GROUP_LABEL[key], rows };
  });
}
