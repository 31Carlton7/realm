# Realm Plan 2 — Arc-style UI overhaul + Agent Sessions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (A) Replace the Plan 1 sidebar with an Arc-style shell — one space visible at a time, spaces as icons in a bottom strip, two-finger swipe to switch, space color drives an adaptive light/dark theme, content renders as a floating card. (B) Add agent sessions: a normalized `SessionEvent` stream, an `AgentAdapter` interface, a **Claude adapter** on `@anthropic-ai/claude-agent-sdk`, and a T3-style transcript pane + composer with permissions, interrupt, and resume.

**Architecture:** Contracts gain `Space.color`, `Session`/`SessionEvent`, and new RPC methods/events. Server gains a `SessionService` that owns adapter handles, persists events with a per-session `seq`, and broadcasts `session.event`. `packages/adapters` holds the adapter interface, a scripted `FakeAdapter` for tests, and `ClaudeAdapter` (SDK streaming-input mode; `canUseTool` → permission events). Desktop: new sidebar components + `SpaceSwiper` gesture; theme tokens derived from the space color; `SessionPane` (transcript + composer) registered in the pane registry; store gains sessions/events slices. Spec amendment: `docs/superpowers/specs/2026-08-17-realm-v1-design.md` §"Amendment 2026-08-17".

**Tech Stack:** as Plan 1 plus `@anthropic-ai/claude-agent-sdk` (server), `marked` + `dompurify` (renderer markdown), Hugeicons.

**Conventions:** repo root `/Users/carltonaikins/Desktop/Home/Work/Projects/realm`; branch `feat/plan-02-arc-sessions` off `main`; pnpm only; TDD per task; commit per task with the given message. Existing code to build on: `packages/contracts/src/{entities,layout,rpc,ids}.ts`, `apps/server/src/{app.ts,rpc/methods.ts,store/*,terminals/*}`, `apps/desktop/src/renderer/src/{state/store.ts,state/live-api.ts,components/*,panes/*}`.

---

## File structure (new / changed)

```
packages/contracts/src/
  entities.ts            + Space.color, Session, SessionStatus, AgentKind
  session-events.ts      SessionEvent schemas (new)
  rpc.ts                 + spaces.list(global)/reorder, settings.*, sessions.*, agents.probe; + events
  presets.ts             SPACE_COLORS, SPACE_ICONS, AGENT_MODELS (new)
packages/adapters/       (new package @realm/adapters)
  src/types.ts           AgentAdapter, AgentHandle, StartOptions
  src/event-queue.ts     AsyncQueue helper
  src/fake/fake-adapter.ts
  src/claude/claude-adapter.ts, src/claude/map-sdk-message.ts, src/claude/probe.ts
  src/*.test.ts, src/claude/fixtures/*.json
apps/server/src/
  db/migrations.ts       + v2 (spaces.color), v3 (sessions, session_events)
  store/spaces.ts        + color, global list, reorder
  store/settings.ts      (new)
  store/sessions.ts      (new) SessionsStore + SessionEventsStore
  sessions/service.ts    (new) SessionService
  rpc/methods.ts         + new methods
  app.ts                 + adapters registry, SessionService
packages/ui/src/theme.ts (new) paletteFromColor, applyTheme
apps/desktop/src/renderer/src/
  state/store.ts         reworked: spaces global, activeSpaceId, sessions slice
  state/live-api.ts      + new api methods
  state/gesture.ts       swipe reducer (new)
  theme/useTheme.ts      (new)
  components/sidebar/{Sidebar,SearchField,SpaceHeader,PinnedGrid,ItemList,NewItemMenu,SpaceStrip,SpaceSwiper,SpaceSettingsSheet}.tsx
  components/CommandPalette.tsx (new)
  panes/session/{SessionPane,Transcript,ToolCard,PermissionCard,Composer,NewSessionSheet}.tsx
  panes/session/transcript-model.ts  (pure reducer: events → view model)
  styles.css             rewritten around tokens
```

---

## Part A — Arc-style spaces UI + adaptive theme

### Task 1: Contracts + server — `Space.color`, global space list, reorder, settings

**Files:**
- Modify: `packages/contracts/src/entities.ts`, `packages/contracts/src/rpc.ts`
- Create: `packages/contracts/src/presets.ts`, `packages/contracts/src/presets.test.ts`
- Modify: `apps/server/src/db/migrations.ts`, `apps/server/src/store/spaces.ts`, `apps/server/src/store/store.test.ts`, `apps/server/src/rpc/methods.ts`, `apps/server/src/rpc/methods.test.ts`, `apps/server/src/app.ts`
- Create: `apps/server/src/store/settings.ts`, `apps/server/src/store/settings.test.ts`

- [ ] **Step 1: Failing tests**

`packages/contracts/src/presets.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { SPACE_COLORS, SPACE_ICONS, pickSpaceColor } from "./presets";
describe("presets", () => {
  it("has at least 8 colors and icons", () => { expect(SPACE_COLORS.length).toBeGreaterThanOrEqual(8); expect(SPACE_ICONS.length).toBeGreaterThanOrEqual(8); });
  it("pickSpaceColor cycles by index", () => { expect(pickSpaceColor(0)).toBe(SPACE_COLORS[0]); expect(pickSpaceColor(SPACE_COLORS.length)).toBe(SPACE_COLORS[0]); });
});
```

Append to `apps/server/src/store/store.test.ts` (inside `describe("SpacesStore")`):
```ts
  it("assigns a color on create, lists globally in sort order, reorders", () => {
    const profiles = new ProfilesStore(db); const spaces = new SpacesStore(db, home);
    const p = profiles.create({ name: "W", icon: "x", color: "#000" });
    const a = spaces.create({ profileId: p.id, name: "A", icon: "f" });
    const b = spaces.create({ profileId: p.id, name: "B", icon: "f" });
    expect(a.color).toMatch(/^#/);
    expect(spaces.listAll().map((s) => s.id)).toEqual([a.id, b.id]);
    spaces.reorder([b.id, a.id]);
    expect(spaces.listAll().map((s) => s.id)).toEqual([b.id, a.id]);
    expect(spaces.update({ id: a.id, color: "#ff0000" }).color).toBe("#ff0000");
  });
```

`apps/server/src/store/settings.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { openDatabase } from "../db/database"; import { SettingsStore } from "./settings";
describe("SettingsStore", () => {
  it("get returns null for missing, set/get roundtrips JSON", () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), "realm-")), "realm.db"));
    const s = new SettingsStore(db);
    expect(s.get("ui.activeSpaceId")).toBeNull();
    s.set("ui.theme", { mode: "system" });
    expect(s.get("ui.theme")).toEqual({ mode: "system" });
    s.set("ui.theme", "dark"); expect(s.get("ui.theme")).toBe("dark");
  });
});
```

Append to `apps/server/src/rpc/methods.test.ts` a test:
```ts
  it("spaces.list is global and spaces.reorder + settings work over rpc", async () => {
    const home = mkdtempSync(join(tmpdir(), "realm-home-")); app = await createApp({ home, port: 0 });
    const c = await client(app.port);
    const p1 = (await c.call("profiles.create", { name: "Work" })).result;
    const p2 = (await c.call("profiles.create", { name: "School" })).result;
    const a = (await c.call("spaces.create", { profileId: p1.id, name: "A" })).result;
    const b = (await c.call("spaces.create", { profileId: p2.id, name: "B" })).result;
    expect((await c.call("spaces.list", {})).result.map((s: { id: string }) => s.id)).toEqual([a.id, b.id]);
    await c.call("spaces.reorder", { ids: [b.id, a.id] });
    expect((await c.call("spaces.list", {})).result.map((s: { id: string }) => s.id)).toEqual([b.id, a.id]);
    await c.call("settings.set", { key: "ui.activeSpaceId", value: b.id });
    expect((await c.call("settings.get", { key: "ui.activeSpaceId" })).result).toEqual({ value: b.id });
    c.close();
  });
```

- [ ] **Step 2: Run to verify fail** — `pnpm test` → failures for missing `presets`, `color`, `listAll`, `reorder`, `SettingsStore`, `spaces.list` params.

- [ ] **Step 3: Implement**

`packages/contracts/src/presets.ts`:
```ts
export const SPACE_COLORS = ["#7c6cff", "#3ddc97", "#ffb454", "#ff6b8b", "#4cc9f0", "#f4a261", "#a3e635", "#c084fc", "#38bdf8", "#fb7185"] as const;
export const SPACE_ICONS = ["briefcase", "cap", "home", "folder", "terminal", "browser", "session", "artifact", "context", "layout"] as const;
export const pickSpaceColor = (i: number): string => SPACE_COLORS[i % SPACE_COLORS.length]!;
```

`packages/contracts/src/entities.ts` — in `SpaceSchema` add `color: z.string(),` after `icon`. Also add at the bottom (used in Part B but harmless now):
```ts
export const AgentKindSchema = z.enum(["claude", "codex", "acp:gemini", "acp:cursor", "fake"]);
export type AgentKind = z.infer<typeof AgentKindSchema>;
export const SessionStatusSchema = z.enum(["idle", "running", "waiting_permission", "error", "ended"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export const SessionSchema = z.object({
  id: IdSchema, spaceId: IdSchema, projectId: IdSchema.nullable(), agentKind: AgentKindSchema,
  model: z.string().nullable(), effort: z.string().nullable(), permissionMode: z.string(),
  cwd: z.string(), status: SessionStatusSchema, providerSessionId: z.string().nullable(),
  title: z.string(), lastEventSeq: z.number().int(), ...Timestamps,
});
export type Session = z.infer<typeof SessionSchema>;
```
Export presets from `index.ts`: `export * from "./presets";`.

`packages/contracts/src/rpc.ts` — change/add in `Methods`:
```ts
  "spaces.list":   { params: z.object({}), result: z.array(SpaceSchema) },
  "spaces.create": { params: z.object({ profileId: IdSchema, name: z.string().min(1), icon: z.string().default("folder"), color: z.string().optional() }), result: SpaceSchema },
  "spaces.update": { params: z.object({ id: IdSchema, name: z.string().min(1).optional(), icon: z.string().optional(), color: z.string().optional(), profileId: IdSchema.optional(), sortOrder: z.number().int().optional(), activeItemId: IdSchema.nullable().optional() }), result: SpaceSchema },
  "spaces.reorder": { params: z.object({ ids: z.array(IdSchema) }), result: z.object({ ok: z.literal(true) }) },
  "settings.get": { params: z.object({ key: z.string() }), result: z.object({ value: z.unknown() }) },
  "settings.set": { params: z.object({ key: z.string(), value: z.unknown() }), result: z.object({ ok: z.literal(true) }) },
```
and change `Events["spaces.changed"]` payload to `z.object({})`.

`apps/server/src/db/migrations.ts` — append v2:
```ts
  `ALTER TABLE spaces ADD COLUMN color TEXT NOT NULL DEFAULT '#7c6cff';`,
```

`apps/server/src/store/spaces.ts` — `Row` gains `color: string`; `toSpace` maps `color: r.color`; `create(input: { profileId; name; icon; color?: string })` picks `input.color ?? pickSpaceColor(countAll)` where `countAll = (SELECT COUNT(*) FROM spaces)`; insert includes `color`. Add:
```ts
  listAll(): Space[] { return (this.db.prepare("SELECT * FROM spaces ORDER BY sort_order, created_at").all() as Row[]).map(toSpace); }
  reorder(ids: string[]): void {
    const stmt = this.db.prepare("UPDATE spaces SET sort_order = ?, updated_at = ? WHERE id = ?");
    this.db.exec("BEGIN"); try { ids.forEach((id, i) => stmt.run(i, now(), id)); this.db.exec("COMMIT"); } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
```
`update` accepts `color?` and `profileId?` (SQL adds `color = ?, profile_id = ?`). Keep `list(profileId)` for compatibility.

`apps/server/src/store/settings.ts`:
```ts
import type { Db } from "../db/database";
export class SettingsStore {
  constructor(private db: Db) {}
  get(key: string): unknown { const r = this.db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as { value_json: string } | undefined; return r ? JSON.parse(r.value_json) : null; }
  set(key: string, value: unknown): void { this.db.prepare("INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run(key, JSON.stringify(value)); }
}
```

`apps/server/src/rpc/methods.ts` — `Deps` gains `settings: SettingsStore`; register:
```ts
  reg("spaces.list", () => d.spaces.listAll());
  reg("spaces.reorder", (p) => { d.spaces.reorder(p.ids); rpc.broadcast("spaces.changed", {}); return { ok: true as const }; });
  reg("settings.get", (p) => ({ value: d.settings.get(p.key) }));
  reg("settings.set", (p) => { d.settings.set(p.key, p.value); return { ok: true as const }; });
```
and all `spaces.changed` broadcasts become `{}`. `app.ts` constructs `new SettingsStore(db)`.

- [ ] **Step 4: Run** — `pnpm test && pnpm typecheck` green (fix desktop compile errors from `spaces.list` params by updating `live-api.ts`: `listSpaces: () => rpc().call("spaces.list", {})` and `Api.listSpaces(): Promise<Space[]>`; store's `refreshSpaces` ignores profileId for now — full rework in Task 4).

- [ ] **Step 5: Commit** — `git commit -m "feat: space color, global space list/reorder, settings store"`

---

### Task 2: Theme engine — palette from space color, adaptive light/dark

**Files:**
- Create: `packages/ui/src/theme.ts`, `packages/ui/src/theme.test.ts`; Modify: `packages/ui/src/index.ts`, `packages/ui/package.json` (add vitest config `packages/ui/vitest.config.ts` + `"test"` not needed; root projects glob already includes `packages/*/vitest.config.ts`).

- [ ] **Step 1: Failing test** — `packages/ui/vitest.config.ts`: `import { defineConfig } from "vitest/config"; export default defineConfig({ test: { name: "ui", environment: "node" } });`

`packages/ui/src/theme.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { hexToHsl, hslToHex, paletteFromColor, themeToCssVars } from "./theme";
describe("theme", () => {
  it("hex/hsl roundtrip", () => { expect(hslToHex(hexToHsl("#7c6cff"))).toBe("#7c6cff"); });
  it("light palette has pale sidebar tint and near-white surface; dark has deep tint and near-black surface", () => {
    const l = paletteFromColor("#7c6cff", "light"); const d = paletteFromColor("#7c6cff", "dark");
    expect(hexToHsl(l.sidebarBg).l).toBeGreaterThan(80); expect(hexToHsl(l.surface).l).toBeGreaterThan(95);
    expect(hexToHsl(d.sidebarBg).l).toBeLessThan(25); expect(hexToHsl(d.surface).l).toBeLessThan(12);
    expect(l.accent).toBe("#7c6cff");
  });
  it("themeToCssVars emits --rl-* variables", () => {
    const vars = themeToCssVars(paletteFromColor("#3ddc97", "light"));
    expect(vars["--rl-accent"]).toBe("#3ddc97"); expect(Object.keys(vars).every((k) => k.startsWith("--rl-"))).toBe(true);
  });
});
```

- [ ] **Step 2: Fail** — `pnpm vitest run packages/ui`.

- [ ] **Step 3: Implement** `packages/ui/src/theme.ts`:
```ts
export type Mode = "light" | "dark";
export type Hsl = { h: number; s: number; l: number };
export function hexToHsl(hex: string): Hsl {
  const m = hex.replace("#", ""); const n = parseInt(m.length === 3 ? m.split("").map((c) => c + c).join("") : m, 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b); const l = (max + min) / 2; let h = 0, s = 0;
  if (max !== min) { const d = max - min; s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}
export function hslToHex({ h, s, l }: Hsl): string {
  const S = s / 100, L = l / 100; const k = (n: number) => (n + h / 30) % 12; const a = S * Math.min(L, 1 - L);
  const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}
const at = (base: Hsl, s: number, l: number) => hslToHex({ h: base.h, s, l });
export type Palette = {
  mode: Mode; accent: string; sidebarBg: string; sidebarBg2: string; sidebarFg: string; sidebarMuted: string; sidebarItemHover: string; sidebarItemActive: string;
  surface: string; surface2: string; border: string; fg: string; muted: string; cardShadow: string; toolBg: string; userBubble: string; danger: string; success: string; warning: string;
};
export function paletteFromColor(hex: string, mode: Mode): Palette {
  const b = hexToHsl(hex);
  if (mode === "light") return {
    mode, accent: hex, sidebarBg: at(b, 70, 90), sidebarBg2: at({ h: (b.h + 40) % 360, s: 60, l: 92 }, 60, 92), sidebarFg: "#1d1d1f", sidebarMuted: "#5c5c66",
    sidebarItemHover: "rgba(255,255,255,0.45)", sidebarItemActive: "rgba(255,255,255,0.85)", surface: "#ffffff", surface2: "#f6f6f8", border: "#e6e6ec", fg: "#1d1d1f", muted: "#6b6b76",
    cardShadow: "0 8px 30px rgba(20,20,40,0.12)", toolBg: "#fafafb", userBubble: "#f1f1f5", danger: "#dc2626", success: "#16a34a", warning: "#d97706",
  };
  return {
    mode, accent: hex, sidebarBg: at(b, 45, 16), sidebarBg2: at({ h: (b.h + 40) % 360, s: 40, l: 12 }, 40, 12), sidebarFg: "#ecebf3", sidebarMuted: "#a7a5b8",
    sidebarItemHover: "rgba(255,255,255,0.08)", sidebarItemActive: "rgba(255,255,255,0.16)", surface: "#141416", surface2: "#1b1b1f", border: "#2a2a30", fg: "#e8e8ea", muted: "#8b8f98",
    cardShadow: "0 8px 30px rgba(0,0,0,0.45)", toolBg: "#1a1a1e", userBubble: "#1e1e22", danger: "#f87171", success: "#6ee7a0", warning: "#fbbf24",
  };
}
export function themeToCssVars(p: Palette): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p)) if (k !== "mode") out[`--rl-${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`] = String(v);
  return out;
}
export function applyTheme(p: Palette, root: HTMLElement = document.documentElement): void {
  for (const [k, v] of Object.entries(themeToCssVars(p))) root.style.setProperty(k, v);
  root.dataset.mode = p.mode;
}
```
Export from `packages/ui/src/index.ts`. Note `themeToCssVars` keys: `--rl-accent`, `--rl-sidebar-bg`, `--rl-sidebar-bg2`, `--rl-sidebar-fg`, `--rl-sidebar-muted`, `--rl-sidebar-item-hover`, `--rl-sidebar-item-active`, `--rl-surface`, `--rl-surface2`, `--rl-border`, `--rl-fg`, `--rl-muted`, `--rl-card-shadow`, `--rl-tool-bg`, `--rl-user-bubble`, `--rl-danger`, `--rl-success`, `--rl-warning`.

- [ ] **Step 4: Pass + commit** — `git commit -m "feat(ui): palette-from-color theme engine"`

---

### Task 3: Desktop — swipe gesture reducer + theme hook

**Files:**
- Create: `apps/desktop/src/renderer/src/state/gesture.ts`, `apps/desktop/src/renderer/src/state/gesture.test.ts`, `apps/desktop/src/renderer/src/theme/useTheme.ts`

- [ ] **Step 1: Failing test** `gesture.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createSwipeTracker } from "./gesture";
describe("swipe tracker", () => {
  it("emits next after horizontal deltas exceed threshold, ignores vertical, and re-arms after idle", () => {
    const t = createSwipeTracker({ threshold: 80, idleMs: 120 });
    let now = 0; const out: string[] = [];
    const feed = (dx: number, dy: number) => { const r = t.wheel(dx, dy, now); if (r) out.push(r); };
    feed(30, 2); feed(30, 0); expect(out).toEqual([]);
    feed(30, 0); expect(out).toEqual(["next"]);          // 90 > 80
    feed(50, 0); expect(out).toEqual(["next"]);          // locked until idle
    now = 200; feed(-90, 0); expect(out).toEqual(["next", "prev"]);
    now = 400; feed(10, 100); feed(100, 400); expect(out).toEqual(["next", "prev"]); // vertical-dominant ignored
    expect(t.progress()).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Fail** — module missing.

- [ ] **Step 3: Implement**

`state/gesture.ts`:
```ts
export type SwipeDir = "next" | "prev";
/** Two-finger horizontal swipe detection from wheel events (trackpad). Pure; time is injected. */
export function createSwipeTracker(opts: { threshold: number; idleMs: number }) {
  let acc = 0, lastTs = -Infinity, locked = false;
  return {
    wheel(dx: number, dy: number, ts: number): SwipeDir | null {
      if (ts - lastTs > opts.idleMs) { acc = 0; locked = false; }
      lastTs = ts;
      if (Math.abs(dy) > Math.abs(dx)) return null;
      if (locked) return null;
      acc += dx;
      if (Math.abs(acc) >= opts.threshold) { locked = true; const d: SwipeDir = acc > 0 ? "next" : "prev"; acc = 0; return d; }
      return null;
    },
    /** 0..1 how far towards a switch we are (for the drag preview). */
    progress(): number { return Math.min(1, Math.abs(acc) / opts.threshold); },
    offset(): number { return acc; },
  };
}
```

`theme/useTheme.ts`:
```ts
import { useEffect, useState } from "react";
import { applyTheme, paletteFromColor, type Mode } from "@realm/ui";
export type ThemePref = "system" | "light" | "dark";
export function useSystemMode(): Mode {
  const mq = () => window.matchMedia?.("(prefers-color-scheme: dark)");
  const [mode, setMode] = useState<Mode>(() => (mq()?.matches ? "dark" : "light"));
  useEffect(() => { const m = mq(); if (!m) return; const fn = () => setMode(m.matches ? "dark" : "light"); m.addEventListener("change", fn); return () => m.removeEventListener("change", fn); }, []);
  return mode;
}
export function useApplyTheme(color: string | null, pref: ThemePref): Mode {
  const sys = useSystemMode(); const mode: Mode = pref === "system" ? sys : pref;
  useEffect(() => { applyTheme(paletteFromColor(color ?? "#7c6cff", mode)); }, [color, mode]);
  return mode;
}
```

- [ ] **Step 4: Pass + commit** — `git commit -m "feat(desktop): swipe gesture tracker and theme hook"`

---

### Task 4: Desktop store rework — global spaces, active space, theme pref, space CRUD

**Files:**
- Modify: `apps/desktop/src/renderer/src/state/store.ts`, `state/live-api.ts`, `state/store.test.ts`, `components/sidebar.test.tsx` (delete old ProfileStrip/SpacesSidebar tests — replaced in Task 5)

- [ ] **Step 1: Failing tests** — rewrite `store.test.ts` fakes: `listSpaces()` returns all spaces (with `color`), plus new Api methods `updateSpace`, `reorderSpaces`, `deleteSpace`, `getSetting`, `setSetting`, `listProfiles`. New tests:
```ts
  it("boot selects the setting-persisted active space, else the first", async () => {
    const store = createAppStore({ ...api, getSetting: async (k) => (k === "ui.activeSpaceId" ? "s2" : null) });
    await store.getState().boot();
    expect(store.getState().activeSpaceId).toBe("s2");
  });
  it("nextSpace/prevSpace cycle with clamping and persist the choice", async () => {
    const set: string[] = [];
    const store = createAppStore({ ...api, setSetting: async (k, v) => { set.push(`${k}=${v}`); } });
    await store.getState().boot();                 // s1 active (first)
    await store.getState().nextSpace(); expect(store.getState().activeSpaceId).toBe("s2");
    await store.getState().nextSpace(); expect(store.getState().activeSpaceId).toBe("s2"); // clamp
    await store.getState().prevSpace(); expect(store.getState().activeSpaceId).toBe("s1");
    expect(set).toContain("ui.activeSpaceId=s2");
  });
  it("createSpace appends and activates; updateSpace merges; deleteSpace moves to neighbor", async () => {
    const store = createAppStore(api); await store.getState().boot();
    await store.getState().createSpace({ name: "New", icon: "folder", profileId: "p1" });
    expect(store.getState().activeSpace()?.name).toBe("New");
    await store.getState().updateSpace({ id: store.getState().activeSpaceId!, color: "#ff0000" });
    expect(store.getState().activeSpace()?.color).toBe("#ff0000");
    await store.getState().deleteSpace(store.getState().activeSpaceId!);
    expect(store.getState().activeSpaceId).toBe("s2");
  });
  it("themePref persists", async () => {
    const set: string[] = []; const store = createAppStore({ ...api, setSetting: async (k, v) => { set.push(`${k}=${v}`); } });
    await store.getState().boot(); await store.getState().setThemePref("dark");
    expect(store.getState().themePref).toBe("dark"); expect(set).toContain("ui.theme=dark");
  });
```
(fake spaces: `s1` in `p1`, `s2` in `p2`, both with `color`.) Keep existing tests for items/terminals/layout/races; adapt them (no `selectProfile`; use `selectSpace`).

- [ ] **Step 2: Fail** — run store tests.

- [ ] **Step 3: Implement** — `store.ts` changes:
  - `Api` adds: `listProfiles()`, `updateSpace(input)`, `reorderSpaces(ids)`, `deleteSpace(id)`, `getSetting(key)`, `setSetting(key,value)`, and `createSpace(input: {name, icon, profileId, color?})`; `listSpaces()` no args.
  - State: `spaces: Space[]` (all), `profiles: Profile[]`, `activeSpaceId`, `themePref: ThemePref`, `activeSpace(): Space | undefined`, `activeIndex(): number`.
  - `boot()`: `[profiles, spaces, saved, theme] = await Promise.all([...])`; `themePref = theme ?? "system"`; pick `saved` if present in spaces else `spaces[0]`; `selectSpace(id)`.
  - `selectSpace(id)`: existing behavior (flush persist, seed layout, refresh items/projects), plus `setSetting("ui.activeSpaceId", id)` (fire-and-forget via `run`), staleness guard kept.
  - `nextSpace/prevSpace`: index ±1 clamped; no-op at ends.
  - `createSpace(input)`, `updateSpace(input)` (merge returned space into `spaces`), `deleteSpace(id)` (api.deleteSpace, remove; if it was active select neighbor: index-1 or 0), `reorderSpaces(ids)` (optimistic reorder + api).
  - `setThemePref(pref)`.
  - Remove `selectProfile`, `createProfile` (profiles are edited later in Settings; keep `profiles` for the pill).
  - `refreshSpaces()` → `spaces = await api.listSpaces()`.
  - `live-api.ts`: wire to `spaces.update`, `spaces.reorder`, `spaces.delete`, `settings.get` (`(await rpc().call("settings.get",{key})).value`), `settings.set`, `profiles.list`.
  - `App.tsx`: subscribe `spaces.changed` → `refreshSpaces()`; call `useApplyTheme(activeSpace?.color ?? null, themePref)` inside a `ThemeBridge` component under the store provider.

- [ ] **Step 4: Pass** — `pnpm vitest run apps/desktop/src/renderer/src/state && pnpm typecheck` (sidebar components will break typecheck — stub them by deleting `ProfileStrip.tsx` and `SpacesSidebar.tsx` and their test now; Task 5 replaces them. `Sidebar.tsx` temporarily renders `<aside className="sidebar" />`).

- [ ] **Step 5: Commit** — `git commit -m "refactor(desktop): global spaces model, active space, theme pref"`

---

### Task 5: Desktop — Arc sidebar (search field, space header, pinned grid, item list, new-item menu, space strip, swiper)

**Files:**
- Create: `apps/desktop/src/renderer/src/components/sidebar/{Sidebar,SearchField,SpaceHeader,PinnedGrid,ItemList,NewItemMenu,SpaceStrip,SpaceSwiper}.tsx`, `components/sidebar/sidebar.test.tsx`
- Modify: `components/Sidebar.tsx` (delete; import from `components/sidebar/Sidebar`), `App.tsx`, `styles.css`

- [ ] **Step 1: Failing test** `components/sidebar/sidebar.test.tsx`:
```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Sidebar } from "./Sidebar";
import { StoreContext, createAppStore, type Api } from "../../state/store";
import { fakeApi } from "../../state/store.test-fakes";  // export the fake from a shared test file (create it in Task 4 by moving fakeApi out of store.test.ts)

describe("Arc sidebar", () => {
  it("shows only the active space's items, the space strip with all spaces, and switches on strip click", async () => {
    const api = fakeApi(); const store = createAppStore(api); await store.getState().boot();
    render(<StoreContext.Provider value={store}><Sidebar /></StoreContext.Provider>);
    expect(screen.getByRole("heading", { name: /Versed/ })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /switch to space/i })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /switch to space Homework/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /Homework/ })).toBeInTheDocument());
  });
  it("pinned items render as tiles, unpinned in the list", async () => {
    const api = fakeApi({ items: { s1: [item("i1", "s1", { pinned: true, title: "GitHub" }), item("i2", "s1", { title: "Terminal" })] } });
    const store = createAppStore(api); await store.getState().boot();
    render(<StoreContext.Provider value={store}><Sidebar /></StoreContext.Provider>);
    expect(screen.getByRole("button", { name: /GitHub/ })).toHaveAttribute("data-tile", "true");
    expect(screen.getByRole("button", { name: /Terminal/ })).not.toHaveAttribute("data-tile");
  });
  it("two-finger horizontal wheel on the sidebar switches spaces", async () => {
    const api = fakeApi(); const store = createAppStore(api); await store.getState().boot();
    const { container } = render(<StoreContext.Provider value={store}><Sidebar /></StoreContext.Provider>);
    const swiper = container.querySelector("[data-swiper]")!;
    fireEvent.wheel(swiper, { deltaX: 50, deltaY: 0 }); fireEvent.wheel(swiper, { deltaX: 50, deltaY: 0 });
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
  });
});
```
(`item()` helper and `fakeApi(overrides)` live in `state/store.test-fakes.ts`, exported for reuse; not a test file itself — name it `store.test-fakes.ts` and exclude from test globbing by not matching `*.test.ts(x)`.)

- [ ] **Step 2: Fail**.

- [ ] **Step 3: Implement**

`SpaceSwiper.tsx` — wraps sidebar body; listens `onWheel`, feeds `createSwipeTracker({threshold: 90, idleMs: 150})` with `performance.now()`; on `next`/`prev` calls store; renders a horizontal track of one "page" per space using CSS `transform: translateX(-index*100%)` with `transition: transform 220ms cubic-bezier(.2,.8,.2,1)`; while accumulating, adds `offset()` px preview (clamped ±40px, rubber-band at ends). Each page renders `<SpacePage spaceId>` (header, pinned grid, item list) — only the active page subscribes to items (others render header only). Attribute `data-swiper`.

`SearchField.tsx` — `<button className="search" onClick={openPalette}><Icon name="search"/><span>Ask or search…</span><kbd>⌘K</kbd></button>` (palette in Task 6; for now `onClick` sets `paletteOpen` in store).

`SpaceHeader.tsx` — `<h2><Icon name={space.icon}/> {space.name}</h2>` + profile pill `<button className="pill">{profile.name}</button>` (opens SpaceSettingsSheet, Task 6) + `⋯` menu button.

`PinnedGrid.tsx` — pinned items → grid of tiles (`button[data-tile=true]` with icon and `title`), click → activateTab.

`ItemList.tsx` — unpinned items, `.item` rows: icon, title, status dot (`data-status`; sessions get `running`/`waiting` from `sessionStatus[itemRefId]` — added in Part B; until then omitted), close on hover; right-click → context menu (Pin/Unpin, Rename, Close) using a tiny `Menu` component.

`NewItemMenu.tsx` — divider + row `＋ New…` → menu: `Session…` (opens NewSessionSheet — Part B; disabled for now with tooltip), `Terminal` (newTerminal), `Browser tab` (disabled, plan 4).

`SpaceStrip.tsx` — bottom bar: left `settings` icon button (opens Settings later — noop), center: one `button[aria-label="Switch to space <name>"]` per space with its icon, active one highlighted with a small dot underneath and `--rl-accent` tint; right `＋` opens `createSpace` inline sheet (name field, auto icon/color, profile default = active space's). Space icons are draggable to reorder (HTML5 drag; on drop → `reorderSpaces`).

`Sidebar.tsx` — `<aside className="sidebar"><div className="sb-top">(traffic-light spacer)<SearchField/></div><SpaceSwiper/><SpaceStrip/></aside>`.

`styles.css` — sidebar uses tokens: `background: linear-gradient(160deg, var(--rl-sidebar-bg), var(--rl-sidebar-bg2)); color: var(--rl-sidebar-fg)`, glass `backdrop-filter: blur(20px)` when `document.body.dataset.vibrancy` (Electron `vibrancy: 'sidebar'` set on the BrowserWindow with `visualEffectState: 'active'` and `transparent` sidebar bg at 0.55 alpha; keep an opaque fallback). Main content: `.main` → `.content-card { margin: 8px 8px 8px 0; border-radius: 12px; background: var(--rl-surface); box-shadow: var(--rl-card-shadow); overflow: hidden }`. Remove Plan-1 `.profile-*`, `.spaces`, `.space-row` styles.

Also `main/index.ts`: `new BrowserWindow({ ..., vibrancy: "sidebar", visualEffectState: "active", backgroundColor: "#00000000" })` — guarded `if (process.platform === "darwin")`.

- [ ] **Step 4: Tests + typecheck + live check** — `pnpm test`, `pnpm typecheck`; `pnpm dev`: sidebar shows one space; strip switches; two-finger swipe slides; theme follows macOS appearance and space color; content is a floating card.

- [ ] **Step 5: Commit** — `git commit -m "feat(desktop): arc-style sidebar with space strip and swipe"`

---

### Task 6: Desktop — space settings sheet, command palette, layout menu relocation

**Files:**
- Create: `components/sidebar/SpaceSettingsSheet.tsx`, `components/CommandPalette.tsx`, `components/Sheet.tsx` (generic modal), `components/command-palette.test.tsx`
- Modify: `App.tsx`, `state/store.ts` (`paletteOpen`, `sheet: null | {kind:'space-settings', spaceId} | {kind:'new-space'} | {kind:'new-session'}`), `styles.css`

- [ ] **Step 1: Failing test** `command-palette.test.tsx`:
```tsx
it("filters spaces and items and runs actions", async () => {
  const api = fakeApi(); const store = createAppStore(api); await store.getState().boot(); store.setState({ paletteOpen: true });
  render(<StoreContext.Provider value={store}><CommandPalette /></StoreContext.Provider>);
  const input = screen.getByRole("combobox"); fireEvent.change(input, { target: { value: "home" } });
  expect(screen.getByRole("option", { name: /Homework/ })).toBeInTheDocument();
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
  expect(store.getState().paletteOpen).toBe(false);
});
it("⌘K toggles the palette", () => { /* mount App-level keydown hook: usePaletteHotkey(store) — dispatch keydown metaKey+k on window and assert paletteOpen */ });
```

- [ ] **Step 2: Fail**.

- [ ] **Step 3: Implement**
  - `Sheet.tsx`: fixed overlay + centered panel, `Escape` closes, focus trap minimal, `role="dialog"`.
  - `SpaceSettingsSheet`: name input, icon picker (SPACE_ICONS grid), color swatches (SPACE_COLORS + custom hex), profile `<select>` (from `profiles`), Delete space (confirm inline). Calls `updateSpace`/`deleteSpace`.
  - `CommandPalette`: `role="combobox"` input, list of `role="option"`: spaces (`Switch to …`), items of active space (`Open …`), actions (`New terminal`, `New session…` [enabled in Part B], `Toggle theme: system/light/dark`); ↑/↓/Enter/Esc; fuzzy = case-insensitive substring; `usePaletteHotkey()` window keydown `metaKey && key==='k'`.
  - Move `LayoutMenu` into the content card's top bar (`.card-topbar`) alongside a breadcrumb `<space icon> <space name> / <active tab title>`.

- [ ] **Step 4: Pass + live check + commit** — `git commit -m "feat(desktop): space settings sheet and command palette"`

---

## Part B — Agent sessions

### Task 7: Contracts — SessionEvent, session RPC methods/events, agent presets

**Files:**
- Create: `packages/contracts/src/session-events.ts`, `packages/contracts/src/session-events.test.ts`
- Modify: `packages/contracts/src/rpc.ts`, `packages/contracts/src/presets.ts`, `packages/contracts/src/index.ts`

- [ ] **Step 1: Failing test**
```ts
import { describe, expect, it } from "vitest";
import { SessionEventSchema, sessionEvent } from "./session-events";
describe("session events", () => {
  it("parses each variant", () => {
    const evs = [
      sessionEvent("user_message", { text: "hi", attachments: [] }),
      sessionEvent("assistant_text", { messageId: "m1", text: "hello" }),
      sessionEvent("assistant_delta", { messageId: "m1", delta: "he" }),
      sessionEvent("thinking", { messageId: "m1", text: "..." }),
      sessionEvent("tool_call", { toolUseId: "t1", name: "Read", input: { file_path: "a" }, parentToolUseId: null }),
      sessionEvent("tool_result", { toolUseId: "t1", content: "ok", isError: false }),
      sessionEvent("permission_request", { requestId: "r1", toolName: "Bash", input: { command: "ls" }, title: "Run ls?", suggestions: [] }),
      sessionEvent("permission_response", { requestId: "r1", decision: "allow" }),
      sessionEvent("status", { status: "running" }),
      sessionEvent("error", { message: "boom" }),
      sessionEvent("usage", { costUsd: 0.01, inputTokens: 10, outputTokens: 5, numTurns: 1 }),
      sessionEvent("init", { providerSessionId: "abc", model: "claude-opus-5", tools: ["Read"], cwd: "/x" }),
    ];
    for (const e of evs) expect(SessionEventSchema.parse(e).type).toBe(e.type);
  });
  it("rejects unknown type", () => { expect(SessionEventSchema.safeParse({ type: "nope", ts: 1, payload: {} }).success).toBe(false); });
});
```

- [ ] **Step 2: Fail**.

- [ ] **Step 3: Implement** `session-events.ts`:
```ts
import { z } from "zod";
const P = {
  user_message: z.object({ text: z.string(), attachments: z.array(z.object({ path: z.string(), mime: z.string() })) }),
  assistant_text: z.object({ messageId: z.string(), text: z.string() }),
  assistant_delta: z.object({ messageId: z.string(), delta: z.string() }),
  thinking: z.object({ messageId: z.string(), text: z.string() }),
  tool_call: z.object({ toolUseId: z.string(), name: z.string(), input: z.record(z.unknown()), parentToolUseId: z.string().nullable() }),
  tool_result: z.object({ toolUseId: z.string(), content: z.string(), isError: z.boolean() }),
  permission_request: z.object({ requestId: z.string(), toolName: z.string(), input: z.record(z.unknown()), title: z.string(), suggestions: z.array(z.unknown()) }),
  permission_response: z.object({ requestId: z.string(), decision: z.enum(["allow", "allow_always", "deny"]) }),
  status: z.object({ status: z.enum(["idle", "running", "waiting_permission", "error", "ended"]) }),
  error: z.object({ message: z.string() }),
  usage: z.object({ costUsd: z.number(), inputTokens: z.number(), outputTokens: z.number(), numTurns: z.number() }),
  init: z.object({ providerSessionId: z.string(), model: z.string(), tools: z.array(z.string()), cwd: z.string() }),
} as const;
export type SessionEventType = keyof typeof P;
export const SessionEventSchema = z.discriminatedUnion("type", (Object.keys(P) as SessionEventType[]).map((t) =>
  z.object({ type: z.literal(t), ts: z.number(), payload: P[t] })) as unknown as [z.ZodObject<z.ZodRawShape>, ...z.ZodObject<z.ZodRawShape>[]]);
export type SessionEvent = { [T in SessionEventType]: { type: T; ts: number; payload: z.infer<(typeof P)[T]> } }[SessionEventType];
export type SessionEventOf<T extends SessionEventType> = Extract<SessionEvent, { type: T }>;
export function sessionEvent<T extends SessionEventType>(type: T, payload: z.infer<(typeof P)[T]>, ts = Date.now()): SessionEventOf<T> {
  return { type, ts, payload } as SessionEventOf<T>;
}
export const PERSISTED_EVENT_TYPES: SessionEventType[] = ["user_message", "assistant_text", "thinking", "tool_call", "tool_result", "permission_request", "permission_response", "status", "error", "usage", "init"];
export const StoredSessionEventSchema = z.object({ seq: z.number().int(), sessionId: z.string(), event: SessionEventSchema });
export type StoredSessionEvent = { seq: number; sessionId: string; event: SessionEvent };
```
(If the discriminatedUnion cast fights the compiler, build the array explicitly with one `z.object` per type — same result.)

`presets.ts` add:
```ts
export const AGENT_MODELS = {
  claude: [{ id: "claude-opus-5", label: "Claude Opus 5" }, { id: "claude-sonnet-5", label: "Claude Sonnet 5" }, { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" }],
  codex: [], "acp:gemini": [], "acp:cursor": [], fake: [{ id: "fake", label: "Fake" }],
} as const;
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export const PERMISSION_MODES = [{ id: "default", label: "Ask" }, { id: "acceptEdits", label: "Accept edits" }, { id: "plan", label: "Plan" }, { id: "bypassPermissions", label: "Full access" }] as const;
```

`rpc.ts` add methods:
```ts
  "agents.probe": { params: z.object({}), result: z.array(z.object({ kind: AgentKindSchema, available: z.boolean(), version: z.string().nullable(), loggedIn: z.boolean().nullable(), reason: z.string().nullable() })) },
  "sessions.list":   { params: z.object({ spaceId: IdSchema }), result: z.array(SessionSchema) },
  "sessions.get":    { params: z.object({ id: IdSchema }), result: SessionSchema },
  "sessions.create": { params: z.object({ spaceId: IdSchema, agentKind: AgentKindSchema, projectId: IdSchema.nullable().default(null), model: z.string().nullable().default(null), effort: z.string().nullable().default(null), permissionMode: z.string().default("default"), title: z.string().optional() }), result: z.object({ session: SessionSchema, itemId: IdSchema }) },
  "sessions.send":   { params: z.object({ id: IdSchema, text: z.string().min(1), attachments: z.array(z.object({ path: z.string(), mime: z.string() })).default([]) }), result: z.object({ ok: z.literal(true) }) },
  "sessions.interrupt": { params: z.object({ id: IdSchema }), result: z.object({ ok: z.literal(true) }) },
  "sessions.respondPermission": { params: z.object({ id: IdSchema, requestId: z.string(), decision: z.enum(["allow", "allow_always", "deny"]) }), result: z.object({ ok: z.literal(true) }) },
  "sessions.setOptions": { params: z.object({ id: IdSchema, model: z.string().optional(), effort: z.string().optional(), permissionMode: z.string().optional() }), result: SessionSchema },
  "sessions.events":  { params: z.object({ id: IdSchema, afterSeq: z.number().int().default(0), limit: z.number().int().default(2000) }), result: z.array(StoredSessionEventSchema) },
  "sessions.delete":  { params: z.object({ id: IdSchema }), result: z.object({ ok: z.literal(true) }) },
```
Events add: `"session.event": StoredSessionEventSchema.extend({ ephemeral: z.boolean() })` (ephemeral = not persisted, seq = -1), `"session.status": z.object({ sessionId: IdSchema, status: SessionStatusSchema })`.

- [ ] **Step 4: Pass + commit** — `git commit -m "feat(contracts): session events, session rpc, agent presets"`

---

### Task 8: `@realm/adapters` — interface, AsyncQueue, FakeAdapter, SDK message mapper

**Files:**
- Create: `packages/adapters/{package.json,tsconfig.json,vitest.config.ts}`, `src/index.ts`, `src/types.ts`, `src/event-queue.ts`, `src/event-queue.test.ts`, `src/fake/fake-adapter.ts`, `src/fake/fake-adapter.test.ts`, `src/claude/map-sdk-message.ts`, `src/claude/map-sdk-message.test.ts`, `src/claude/fixtures/turn.json`

- [ ] **Step 1: Package**

`packages/adapters/package.json`:
```json
{ "name": "@realm/adapters", "version": "0.0.1", "private": true, "type": "module", "main": "./src/index.ts", "types": "./src/index.ts",
  "scripts": { "typecheck": "tsc -p tsconfig.json --noEmit" },
  "dependencies": { "@realm/contracts": "workspace:*", "@anthropic-ai/claude-agent-sdk": "^0.3.233" } }
```
`tsconfig.json`: extends base, include src. `vitest.config.ts`: name "adapters", node env.

- [ ] **Step 2: Failing tests**

`src/event-queue.test.ts`:
```ts
import { describe, expect, it } from "vitest"; import { AsyncQueue } from "./event-queue";
describe("AsyncQueue", () => {
  it("yields pushed values in order and ends on close", async () => {
    const q = new AsyncQueue<number>(); const out: number[] = [];
    const p = (async () => { for await (const v of q) out.push(v); })();
    q.push(1); q.push(2); await Promise.resolve(); q.push(3); q.close(); await p;
    expect(out).toEqual([1, 2, 3]);
  });
  it("awaits when empty", async () => {
    const q = new AsyncQueue<string>(); const it = q[Symbol.asyncIterator](); const next = it.next();
    q.push("x"); expect((await next).value).toBe("x"); q.close(); expect((await it.next()).done).toBe(true);
  });
});
```

`src/fake/fake-adapter.test.ts`:
```ts
import { describe, expect, it } from "vitest"; import { FakeAdapter } from "./fake-adapter";
describe("FakeAdapter", () => {
  it("scripts a turn: text, tool call needing permission, result", async () => {
    const a = new FakeAdapter({ script: [
      { on: "hi", emit: [{ kind: "text", text: "Hello!" }, { kind: "tool", name: "Bash", input: { command: "ls" }, needsPermission: true, result: "a b" }, { kind: "text", text: "Done." }] },
    ] });
    const h = a.start({ cwd: "/tmp", mcpServers: [] });
    const got: string[] = []; const collect = (async () => { for await (const e of h.events) { got.push(e.type); if (e.type === "permission_request") h.respondPermission(e.payload.requestId, "allow"); if (e.type === "status" && e.payload.status === "idle" && got.includes("tool_result")) break; } })();
    h.send({ text: "hi", attachments: [] });
    await collect;
    expect(got).toEqual(expect.arrayContaining(["init", "status", "assistant_text", "tool_call", "permission_request", "permission_response", "tool_result", "usage"]));
    expect(got.indexOf("permission_request")).toBeLessThan(got.indexOf("tool_result"));
    await h.dispose();
  });
  it("deny skips tool result and reports error text", async () => {
    const a = new FakeAdapter({ script: [{ on: "x", emit: [{ kind: "tool", name: "Bash", input: {}, needsPermission: true, result: "never" }] }] });
    const h = a.start({ cwd: "/tmp", mcpServers: [] }); const types: string[] = [];
    const c = (async () => { for await (const e of h.events) { types.push(e.type); if (e.type === "permission_request") h.respondPermission(e.payload.requestId, "deny"); if (e.type === "status" && e.payload.status === "idle" && types.includes("permission_response")) break; } })();
    h.send({ text: "x", attachments: [] }); await c;
    expect(types).not.toContain("tool_result"); await h.dispose();
  });
});
```

`src/claude/map-sdk-message.test.ts` (fixture-driven):
```ts
import { describe, expect, it } from "vitest"; import { readFileSync } from "node:fs"; import { join, dirname } from "node:path"; import { fileURLToPath } from "node:url";
import { createSdkMapper } from "./map-sdk-message";
const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "fixtures", "turn.json"), "utf8")) as unknown[];
describe("map-sdk-message", () => {
  it("maps a recorded turn to normalized events", () => {
    const m = createSdkMapper(); const out = fixture.flatMap((msg) => m.map(msg as never));
    const types = out.map((e) => e.type);
    expect(types[0]).toBe("init");
    expect(types).toContain("assistant_delta"); expect(types).toContain("assistant_text"); expect(types).toContain("tool_call"); expect(types).toContain("tool_result"); expect(types).toContain("usage");
    const call = out.find((e) => e.type === "tool_call")!; expect(call.type === "tool_call" && call.payload.name).toBe("Read");
    const res = out.find((e) => e.type === "tool_result")!; expect(res.type === "tool_result" && res.payload.toolUseId).toBe("toolu_01");
    const usage = out.find((e) => e.type === "usage")!; expect(usage.type === "usage" && usage.payload.numTurns).toBe(2);
  });
});
```

`src/claude/fixtures/turn.json` (hand-authored, shaped like real SDK messages):
```json
[
  {"type":"system","subtype":"init","session_id":"sess_1","model":"claude-opus-5","cwd":"/tmp/x","tools":["Read","Bash"],"mcp_servers":[],"permissionMode":"default","apiKeySource":"none","claude_code_version":"2.0","slash_commands":[],"output_style":"default","skills":[],"plugins":[]},
  {"type":"stream_event","session_id":"sess_1","parent_tool_use_id":null,"uuid":"u1","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}},
  {"type":"stream_event","session_id":"sess_1","parent_tool_use_id":null,"uuid":"u2","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me look."}}},
  {"type":"assistant","session_id":"sess_1","parent_tool_use_id":null,"uuid":"a1","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"Let me look."},{"type":"tool_use","id":"toolu_01","name":"Read","input":{"file_path":"/tmp/x/a.txt"}}],"stop_reason":"tool_use","usage":{"input_tokens":10,"output_tokens":5}}},
  {"type":"user","session_id":"sess_1","parent_tool_use_id":null,"uuid":"r1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"file contents"}]}},
  {"type":"assistant","session_id":"sess_1","parent_tool_use_id":null,"uuid":"a2","message":{"id":"msg_2","type":"message","role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"It says: file contents"}],"stop_reason":"end_turn","usage":{"input_tokens":20,"output_tokens":8}}},
  {"type":"result","subtype":"success","session_id":"sess_1","uuid":"res1","duration_ms":100,"duration_api_ms":90,"is_error":false,"num_turns":2,"result":"It says: file contents","stop_reason":"end_turn","total_cost_usd":0.0123,"usage":{"input_tokens":30,"output_tokens":13,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"modelUsage":{},"permission_denials":[]}
]
```

- [ ] **Step 3: Fail** — `pnpm install && pnpm vitest run packages/adapters`.

- [ ] **Step 4: Implement**

`src/event-queue.ts`:
```ts
export class AsyncQueue<T> implements AsyncIterable<T> {
  private buf: T[] = []; private waiters: Array<(r: IteratorResult<T>) => void> = []; private closed = false;
  push(v: T): void { if (this.closed) return; const w = this.waiters.shift(); if (w) w({ value: v, done: false }); else this.buf.push(v); }
  close(): void { this.closed = true; for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true }); }
  get isClosed(): boolean { return this.closed; }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => {
      if (this.buf.length) return Promise.resolve({ value: this.buf.shift()!, done: false });
      if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
      return new Promise((res) => this.waiters.push(res));
    } };
  }
}
```

`src/types.ts`:
```ts
import type { AgentKind, SessionEvent } from "@realm/contracts";
export type McpStdioConfig = { name: string; command: string; args?: string[]; env?: Record<string, string> };
export type StartOptions = {
  cwd: string; model?: string | null; effort?: string | null; permissionMode?: string; systemContext?: string;
  mcpServers: McpStdioConfig[]; resume?: string | null; env?: Record<string, string>;
};
export type UserMessage = { text: string; attachments: { path: string; mime: string }[] };
export type PermissionDecision = "allow" | "allow_always" | "deny";
export interface AgentHandle {
  readonly events: AsyncIterable<SessionEvent>;
  send(message: UserMessage): void;
  respondPermission(requestId: string, decision: PermissionDecision): void;
  interrupt(): Promise<void>;
  setOptions(opts: { model?: string; permissionMode?: string }): Promise<void>;
  dispose(): Promise<void>;
}
export type ProbeResult = { kind: AgentKind; available: boolean; version: string | null; loggedIn: boolean | null; reason: string | null };
export interface AgentAdapter {
  readonly kind: AgentKind;
  probe(): Promise<ProbeResult>;
  start(opts: StartOptions): AgentHandle;
}
export type AdapterRegistry = Partial<Record<AgentKind, AgentAdapter>>;
```

`src/fake/fake-adapter.ts`:
```ts
import { newId, sessionEvent, type SessionEvent } from "@realm/contracts";
import { AsyncQueue } from "../event-queue";
import type { AgentAdapter, AgentHandle, PermissionDecision, StartOptions, UserMessage } from "../types";
export type FakeStep = { kind: "text"; text: string } | { kind: "tool"; name: string; input: Record<string, unknown>; needsPermission?: boolean; result: string };
export type FakeScript = { on: string; emit: FakeStep[] }[];
export class FakeAdapter implements AgentAdapter {
  readonly kind = "fake" as const;
  constructor(private cfg: { script: FakeScript; delayMs?: number } = { script: [] }) {}
  async probe() { return { kind: this.kind, available: true, version: "fake", loggedIn: true, reason: null }; }
  start(opts: StartOptions): AgentHandle {
    const q = new AsyncQueue<SessionEvent>(); const pending = new Map<string, (d: PermissionDecision) => void>(); const delay = this.cfg.delayMs ?? 0;
    const sleep = () => new Promise((r) => setTimeout(r, delay));
    q.push(sessionEvent("init", { providerSessionId: `fake-${newId()}`, model: opts.model ?? "fake", tools: ["Bash", "Read"], cwd: opts.cwd }));
    q.push(sessionEvent("status", { status: "idle" }));
    const run = async (msg: UserMessage) => {
      q.push(sessionEvent("status", { status: "running" }));
      const step = this.cfg.script.find((s) => msg.text.includes(s.on));
      for (const st of step?.emit ?? [{ kind: "text", text: `echo: ${msg.text}` } as FakeStep]) {
        await sleep();
        if (st.kind === "text") { const id = newId(); for (const ch of st.text) q.push(sessionEvent("assistant_delta", { messageId: id, delta: ch })); q.push(sessionEvent("assistant_text", { messageId: id, text: st.text })); }
        else {
          const toolUseId = newId(); q.push(sessionEvent("tool_call", { toolUseId, name: st.name, input: st.input, parentToolUseId: null }));
          if (st.needsPermission) {
            const requestId = newId(); q.push(sessionEvent("status", { status: "waiting_permission" }));
            q.push(sessionEvent("permission_request", { requestId, toolName: st.name, input: st.input, title: `Allow ${st.name}?`, suggestions: [] }));
            const decision = await new Promise<PermissionDecision>((res) => pending.set(requestId, res));
            q.push(sessionEvent("permission_response", { requestId, decision })); q.push(sessionEvent("status", { status: "running" }));
            if (decision === "deny") { q.push(sessionEvent("assistant_text", { messageId: newId(), text: "Okay, I won't run that." })); continue; }
          }
          q.push(sessionEvent("tool_result", { toolUseId, content: st.result, isError: false }));
        }
      }
      q.push(sessionEvent("usage", { costUsd: 0.001, inputTokens: 10, outputTokens: 10, numTurns: 1 }));
      q.push(sessionEvent("status", { status: "idle" }));
    };
    let chain = Promise.resolve();
    return {
      events: q,
      send: (m) => { chain = chain.then(() => run(m)); },
      respondPermission: (id, d) => { pending.get(id)?.(d); pending.delete(id); },
      interrupt: async () => { q.push(sessionEvent("status", { status: "idle" })); },
      setOptions: async () => {},
      dispose: async () => { q.push(sessionEvent("status", { status: "ended" })); q.close(); },
    };
  }
}
```

`src/claude/map-sdk-message.ts` — pure mapper from SDK messages to SessionEvents (streaming text deltas coalesced by message id):
```ts
import { sessionEvent, type SessionEvent } from "@realm/contracts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
type Block = { type: string; [k: string]: unknown };
export function createSdkMapper() {
  let streamMsgId: string | null = null; // synthetic id for the currently streaming assistant message
  const emittedText = new Set<string>();
  return {
    map(msg: SDKMessage): SessionEvent[] {
      const out: SessionEvent[] = [];
      switch (msg.type) {
        case "system":
          if (msg.subtype === "init") out.push(sessionEvent("init", { providerSessionId: msg.session_id, model: msg.model, tools: msg.tools, cwd: msg.cwd }));
          break;
        case "stream_event": {
          const ev = msg.event as { type: string; index?: number; content_block?: Block; delta?: Block };
          if (ev.type === "message_start") streamMsgId = msg.uuid;
          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") out.push(sessionEvent("assistant_delta", { messageId: streamMsgId ?? msg.uuid, delta: String(ev.delta.text) }));
          break;
        }
        case "assistant": {
          const m = msg.message as { id: string; content: Block[] };
          const messageId = streamMsgId ?? m.id; streamMsgId = null;
          for (const b of m.content) {
            if (b.type === "text" && !emittedText.has(messageId + ":" + String(b.text))) { emittedText.add(messageId + ":" + String(b.text)); out.push(sessionEvent("assistant_text", { messageId, text: String(b.text) })); }
            else if (b.type === "thinking" && String(b.thinking)) out.push(sessionEvent("thinking", { messageId, text: String(b.thinking) }));
            else if (b.type === "tool_use") out.push(sessionEvent("tool_call", { toolUseId: String(b.id), name: String(b.name), input: (b.input as Record<string, unknown>) ?? {}, parentToolUseId: msg.parent_tool_use_id }));
          }
          break;
        }
        case "user": {
          const m = msg.message as { content: string | Block[] };
          if (Array.isArray(m.content)) for (const b of m.content) if (b.type === "tool_result") {
            const c = b.content as string | Block[] | undefined;
            const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (x.type === "text" ? String(x.text) : `[${x.type}]`)).join("\n") : "";
            out.push(sessionEvent("tool_result", { toolUseId: String(b.tool_use_id), content: text, isError: Boolean(b.is_error) }));
          }
          break;
        }
        case "result": {
          const r = msg as { subtype: string; is_error: boolean; num_turns: number; total_cost_usd: number; usage?: { input_tokens: number; output_tokens: number }; result?: string };
          out.push(sessionEvent("usage", { costUsd: r.total_cost_usd, inputTokens: r.usage?.input_tokens ?? 0, outputTokens: r.usage?.output_tokens ?? 0, numTurns: r.num_turns }));
          if (r.subtype !== "success" || r.is_error) out.push(sessionEvent("error", { message: r.result ?? r.subtype }));
          break;
        }
        default: break; // other SDK notices ignored in v1
      }
      return out;
    },
  };
}
```
`src/index.ts` exports types, AsyncQueue, FakeAdapter, createSdkMapper (ClaudeAdapter added in Task 9).

- [ ] **Step 5: Pass + commit** — `git commit -m "feat(adapters): adapter interface, fake adapter, sdk message mapper"`

---

### Task 9: `ClaudeAdapter` on the Claude Agent SDK (+ probe)

**Files:**
- Create: `packages/adapters/src/claude/claude-adapter.ts`, `packages/adapters/src/claude/probe.ts`, `packages/adapters/src/claude/claude-adapter.test.ts`
- Modify: `packages/adapters/src/index.ts`

- [ ] **Step 1: Failing test** (unit-tests the adapter's wiring with an injected fake `query` — no network):
```ts
import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "./claude-adapter";
import { readFileSync } from "node:fs"; import { join, dirname } from "node:path"; import { fileURLToPath } from "node:url";
const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "turn.json"), "utf8")) as unknown[];

function fakeQuery(opts: { onCanUseTool?: (name: string) => Promise<unknown>; permissionOnTool?: string }) {
  return ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    const gen = (async function* () {
      // consume the first user message before emitting the fixture turn
      const it = prompt[Symbol.asyncIterator](); await it.next();
      for (const m of fixture) {
        if ((m as { type: string }).type === "assistant" && opts.permissionOnTool && (options.canUseTool as Function)) {
          const r = await (options.canUseTool as (n: string, i: unknown, o: unknown) => Promise<{ behavior: string }>)(opts.permissionOnTool, { file_path: "a" }, { signal: new AbortController().signal, title: "Read a?" });
          if (r.behavior === "deny") { yield { type: "result", subtype: "success", session_id: "sess_1", uuid: "r", duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, result: "denied", stop_reason: "end_turn", total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {}, permission_denials: [] }; return; }
        }
        yield m;
      }
    })();
    return Object.assign(gen, { interrupt: async () => undefined, setPermissionMode: async () => {}, setModel: async () => {} });
  };
}
describe("ClaudeAdapter", () => {
  it("streams normalized events for a turn and marks idle at result", async () => {
    const a = new ClaudeAdapter({ query: fakeQuery({}) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [] }); const types: string[] = [];
    const c = (async () => { for await (const e of h.events) { types.push(e.type); if (e.type === "status" && e.payload.status === "idle" && types.includes("usage")) break; } })();
    h.send({ text: "hi", attachments: [] }); await c; await h.dispose();
    expect(types).toEqual(expect.arrayContaining(["init", "status", "assistant_delta", "assistant_text", "tool_call", "tool_result", "usage"]));
  });
  it("routes canUseTool through permission_request/response", async () => {
    const a = new ClaudeAdapter({ query: fakeQuery({ permissionOnTool: "Read" }) as never });
    const h = a.start({ cwd: "/tmp", mcpServers: [] }); const types: string[] = [];
    const c = (async () => { for await (const e of h.events) { types.push(e.type); if (e.type === "permission_request") h.respondPermission(e.payload.requestId, "deny"); if (e.type === "status" && e.payload.status === "idle" && types.includes("permission_response")) break; } })();
    h.send({ text: "hi", attachments: [] }); await c; await h.dispose();
    expect(types).toContain("permission_request"); expect(types).toContain("permission_response");
    expect(types.filter((t) => t === "status")).toContain("status");
  });
});
```

- [ ] **Step 2: Fail**.

- [ ] **Step 3: Implement**

`src/claude/probe.ts`:
```ts
import { execFile } from "node:child_process"; import { promisify } from "node:util"; import { existsSync } from "node:fs"; import { join } from "node:path"; import { homedir } from "node:os";
const run = promisify(execFile);
export async function probeClaude(bin = process.env.REALM_CLAUDE_BIN ?? "claude"): Promise<{ available: boolean; version: string | null; loggedIn: boolean | null; reason: string | null }> {
  try {
    const { stdout } = await run(bin, ["--version"], { timeout: 5000 });
    const loggedIn = existsSync(join(homedir(), ".claude", ".credentials.json")) || Boolean(process.env.ANTHROPIC_API_KEY) || null;
    return { available: true, version: stdout.trim() || null, loggedIn, reason: null };
  } catch (e) { return { available: false, version: null, loggedIn: null, reason: (e as Error).message }; }
}
```

`src/claude/claude-adapter.ts`:
```ts
import { query as sdkQuery, type Options, type PermissionResult, type SDKUserMessage, type Query } from "@anthropic-ai/claude-agent-sdk";
import { newId, sessionEvent, type SessionEvent } from "@realm/contracts";
import { AsyncQueue } from "../event-queue";
import { createSdkMapper } from "./map-sdk-message";
import { probeClaude } from "./probe";
import type { AgentAdapter, AgentHandle, PermissionDecision, StartOptions, UserMessage } from "../types";

type QueryFn = typeof sdkQuery;
export class ClaudeAdapter implements AgentAdapter {
  readonly kind = "claude" as const;
  private queryFn: QueryFn;
  constructor(deps: { query?: QueryFn } = {}) { this.queryFn = deps.query ?? sdkQuery; }
  async probe() { const p = await probeClaude(); return { kind: this.kind, ...p }; }

  start(opts: StartOptions): AgentHandle {
    const events = new AsyncQueue<SessionEvent>();
    const input = new AsyncQueue<SDKUserMessage>();
    const pending = new Map<string, (r: PermissionResult) => void>();
    const abort = new AbortController();
    const mapper = createSdkMapper();
    let q: Query | null = null; let running = false;

    const canUseTool: Options["canUseTool"] = async (toolName, toolInput, o) => {
      const requestId = newId();
      events.push(sessionEvent("status", { status: "waiting_permission" }));
      events.push(sessionEvent("permission_request", { requestId, toolName, input: toolInput, title: o.title ?? `Allow ${toolName}?`, suggestions: (o.suggestions ?? []) as unknown[] }));
      const result = await new Promise<PermissionResult>((res) => {
        pending.set(requestId, res);
        o.signal.addEventListener("abort", () => { if (pending.delete(requestId)) res({ behavior: "deny", message: "aborted" }); }, { once: true });
      });
      events.push(sessionEvent("status", { status: "running" }));
      return result;
    };

    const options: Options = {
      cwd: opts.cwd, model: opts.model ?? undefined, effort: (opts.effort ?? undefined) as Options["effort"],
      permissionMode: (opts.permissionMode ?? "default") as Options["permissionMode"],
      canUseTool, includePartialMessages: true, abortController: abort,
      resume: opts.resume ?? undefined,
      systemPrompt: opts.systemContext ? { type: "preset", preset: "claude_code", append: opts.systemContext } : undefined,
      mcpServers: Object.fromEntries(opts.mcpServers.map((s) => [s.name, { type: "stdio" as const, command: s.command, args: s.args, env: s.env }])),
      env: { ...process.env, ...opts.env } as Record<string, string>,
      stderr: (d) => { if (d.trim()) events.push(sessionEvent("error", { message: d.trim() })); },
      pathToClaudeCodeExecutable: process.env.REALM_CLAUDE_BIN,
    };

    const pump = async () => {
      try {
        q = this.queryFn({ prompt: input, options });
        for await (const msg of q) {
          if (msg.type === "system" && (msg as { subtype?: string }).subtype === "init") { for (const e of mapper.map(msg)) events.push(e); events.push(sessionEvent("status", { status: "idle" })); continue; }
          if (msg.type === "result") { for (const e of mapper.map(msg)) events.push(e); running = false; events.push(sessionEvent("status", { status: "idle" })); continue; }
          for (const e of mapper.map(msg)) events.push(e);
        }
      } catch (e) {
        events.push(sessionEvent("error", { message: (e as Error).message ?? String(e) }));
      } finally {
        events.push(sessionEvent("status", { status: "ended" })); events.close();
      }
    };
    void pump();

    return {
      events,
      send: (m: UserMessage) => {
        running = true; events.push(sessionEvent("user_message", { text: m.text, attachments: m.attachments })); events.push(sessionEvent("status", { status: "running" }));
        const content: Array<Record<string, unknown>> = [{ type: "text", text: m.text }];
        for (const a of m.attachments) if (a.mime.startsWith("image/")) content.push({ type: "image", source: { type: "base64", media_type: a.mime, data: require("node:fs").readFileSync(a.path).toString("base64") } });
        input.push({ type: "user", message: { role: "user", content: content as never }, parent_tool_use_id: null, session_id: "" } as SDKUserMessage);
      },
      respondPermission: (requestId: string, d: PermissionDecision) => {
        const res = pending.get(requestId); if (!res) return; pending.delete(requestId);
        events.push(sessionEvent("permission_response", { requestId, decision: d }));
        res(d === "deny" ? { behavior: "deny", message: "User denied" } : { behavior: "allow" });
      },
      interrupt: async () => { await q?.interrupt(); if (running) { running = false; events.push(sessionEvent("status", { status: "idle" })); } },
      setOptions: async (o) => { if (o.model) await q?.setModel(o.model); if (o.permissionMode) await q?.setPermissionMode(o.permissionMode as never); },
      dispose: async () => { input.close(); abort.abort(); },
    };
  }
}
```
Notes: replace the inline `require("node:fs")` with a top-level `import { readFileSync } from "node:fs"`. `allow_always` maps to `{behavior:"allow", updatedPermissions: suggestions}` — implement by keeping the `suggestions` per request in a second map and returning them when decision is `allow_always`.

`src/index.ts` add exports for `ClaudeAdapter`, `probeClaude`.

- [ ] **Step 4: Pass + typecheck** — `pnpm vitest run packages/adapters && pnpm --filter @realm/adapters typecheck`.

- [ ] **Step 5: Manual smoke (real SDK, needs your Claude login)** — create `packages/adapters/scripts/smoke-claude.ts` (not committed to tests): starts `new ClaudeAdapter().start({cwd: os.tmpdir(), mcpServers: []})`, sends "Reply with exactly: REALM_OK", prints events, exits at idle. Run with `pnpm --filter @realm/adapters exec tsx scripts/smoke-claude.ts` (add `tsx` devDependency). Expect `assistant_text` containing `REALM_OK`. If auth fails, the `error` event shows why (login with `claude` first).

- [ ] **Step 6: Commit** — `git commit -m "feat(adapters): claude adapter on the agent sdk"`

---

### Task 10: Server — sessions store, migrations, SessionService, RPC

**Files:**
- Modify: `apps/server/src/db/migrations.ts` (+v3), `apps/server/src/app.ts`, `apps/server/src/rpc/methods.ts`, `apps/server/package.json` (dep `@realm/adapters`)
- Create: `apps/server/src/store/sessions.ts`, `apps/server/src/store/sessions.test.ts`, `apps/server/src/sessions/service.ts`, `apps/server/src/sessions/service.test.ts`

- [ ] **Step 1: Failing tests**

`store/sessions.test.ts`:
```ts
it("creates a session, appends events with increasing seq, lists after seq, updates status/lastEventSeq", () => {
  const { db, home } = fresh(); const spaces = seedSpace(db, home); const s = new SessionsStore(db); const ev = new SessionEventsStore(db);
  const sess = s.create({ spaceId: spaces.id, projectId: null, agentKind: "fake", model: null, effort: null, permissionMode: "default", cwd: "/tmp", title: "New session" });
  expect(sess.status).toBe("idle"); expect(sess.lastEventSeq).toBe(0);
  const a = ev.append(sess.id, sessionEvent("status", { status: "running" })); const b = ev.append(sess.id, sessionEvent("assistant_text", { messageId: "m", text: "hi" }));
  expect(b.seq).toBe(a.seq + 1);
  expect(ev.listAfter(sess.id, a.seq, 100).map((e) => e.seq)).toEqual([b.seq]);
  s.update({ id: sess.id, status: "running", lastEventSeq: b.seq, providerSessionId: "p1" });
  expect(s.get(sess.id)?.status).toBe("running"); expect(s.get(sess.id)?.providerSessionId).toBe("p1");
});
```

`sessions/service.test.ts` (uses FakeAdapter through `createApp({ adapters })`):
```ts
it("create → send → permission → respond → idle, all persisted and broadcast", async () => {
  const home = mkdtempSync(join(tmpdir(), "realm-")); const fake = new FakeAdapter({ script: [{ on: "go", emit: [{ kind: "text", text: "ok" }, { kind: "tool", name: "Bash", input: { command: "ls" }, needsPermission: true, result: "x" }] }] });
  app = await createApp({ home, port: 0, adapters: { fake } }); const c = await client(app.port);
  const p = (await c.call("profiles.create", { name: "W" })).result; const sp = (await c.call("spaces.create", { profileId: p.id, name: "S" })).result;
  const { session, itemId } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
  expect(itemId).toBeTruthy();
  await c.call("sessions.send", { id: session.id, text: "go" });
  await waitFor(() => c.events.some((e) => e.event === "session.event" && e.payload.event.type === "permission_request"));
  const req = c.events.find((e) => e.event === "session.event" && e.payload.event.type === "permission_request")!.payload.event.payload.requestId;
  await c.call("sessions.respondPermission", { id: session.id, requestId: req, decision: "allow" });
  await waitFor(() => c.events.some((e) => e.event === "session.status" && e.payload.status === "idle" && c.events.some((x) => x.event === "session.event" && x.payload.event.type === "tool_result")));
  const stored = (await c.call("sessions.events", { id: session.id })).result;
  expect(stored.map((s: { event: { type: string } }) => s.event.type)).toEqual(expect.arrayContaining(["user_message", "assistant_text", "tool_call", "permission_request", "permission_response", "tool_result", "usage"]));
  expect(stored.some((s: { event: { type: string } }) => s.event.type === "assistant_delta")).toBe(false); // deltas are ephemeral
  const got = (await c.call("sessions.get", { id: session.id })).result; expect(got.status).toBe("idle"); expect(got.lastEventSeq).toBeGreaterThan(0);
  await c.call("sessions.delete", { id: session.id });
  expect((await c.call("items.list", { spaceId: sp.id })).result).toEqual([]);
});
it("agents.probe lists registered adapters", async () => { /* create app with fake; expect [{kind:'fake', available:true}] */ });
```

- [ ] **Step 2: Fail**.

- [ ] **Step 3: Implement**

`migrations.ts` v3:
```ts
  `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, project_id TEXT,
    agent_kind TEXT NOT NULL, model TEXT, effort TEXT, permission_mode TEXT NOT NULL DEFAULT 'default', cwd TEXT NOT NULL,
    status TEXT NOT NULL, provider_session_id TEXT, title TEXT NOT NULL, last_event_seq INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX sessions_space ON sessions(space_id);
  CREATE TABLE session_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL);
  CREATE INDEX session_events_session ON session_events(session_id, seq);
  `,
```

`store/sessions.ts` — `SessionsStore` (`list(spaceId)`, `get`, `create`, `update({id, status?, providerSessionId?, lastEventSeq?, title?, model?, effort?, permissionMode?})`, `delete`, `listAll()`), `SessionEventsStore` (`append(sessionId, event) → StoredSessionEvent`, `listAfter(sessionId, afterSeq, limit)`), same row-mapping style as `spaces.ts`.

`sessions/service.ts`:
```ts
export class SessionService {
  private live = new Map<string, { handle: AgentHandle; pump: Promise<void> }>();
  constructor(private d: { rpc: RpcServer; sessions: SessionsStore; events: SessionEventsStore; items: ItemsStore; spaces: SpacesStore; projects: ProjectsStore; adapters: AdapterRegistry }) {}
  async probeAll(): Promise<ProbeResult[]> { return Promise.all(Object.values(this.d.adapters).map((a) => a!.probe())); }
  create(input: {...}): { session: Session; itemId: string } {
    const space = spaces.get(spaceId) ?? throw NotFound; const project = projectId ? projects.get(projectId) : null;
    const cwd = project?.rootPath ?? space.folderPath;
    const session = sessions.create({...input, cwd, title: input.title ?? `${label(agentKind)} session`});
    const item = items.create({ spaceId, kind: "session", title: session.title, refId: session.id });
    rpc.broadcast("items.changed", { spaceId }); return { session, itemId: item.id };
  }
  private ensureLive(id: string): AgentHandle {
    const existing = this.live.get(id); if (existing) return existing.handle;
    const s = sessions.get(id) ?? throw NotFound; const adapter = adapters[s.agentKind] ?? throw new RpcError("AGENT_UNAVAILABLE", `${s.agentKind} not registered`);
    const handle = adapter.start({ cwd: s.cwd, model: s.model, effort: s.effort, permissionMode: s.permissionMode, mcpServers: [], resume: s.providerSessionId });
    const pump = (async () => { for await (const ev of handle.events) this.onEvent(id, ev); this.live.delete(id); })();
    this.live.set(id, { handle, pump }); return handle;
  }
  private onEvent(id: string, ev: SessionEvent) {
    if (ev.type === "init") sessions.update({ id, providerSessionId: ev.payload.providerSessionId });
    if (ev.type === "status") { sessions.update({ id, status: ev.payload.status }); rpc.broadcast("session.status", { sessionId: id, status: ev.payload.status }); }
    if (PERSISTED_EVENT_TYPES.includes(ev.type)) { const stored = events.append(id, ev); sessions.update({ id, lastEventSeq: stored.seq }); rpc.broadcast("session.event", { ...stored, ephemeral: false }); }
    else rpc.broadcast("session.event", { seq: -1, sessionId: id, event: ev, ephemeral: true });
  }
  send(id, msg) { this.ensureLive(id).send(msg); }   // adapter emits user_message
  interrupt(id) { return this.live.get(id)?.handle.interrupt(); }
  respondPermission(id, requestId, decision) { this.live.get(id)?.handle.respondPermission(requestId, decision); }
  async setOptions(id, o) { const s = sessions.update({ id, ...o }); await this.live.get(id)?.handle.setOptions(o); return s; }
  events(id, afterSeq, limit) { return events.listAfter(id, afterSeq, limit); }
  async delete(id) { const l = this.live.get(id); if (l) await l.handle.dispose(); this.live.delete(id); const item = items.findByRefId(id); if (item) items.delete(item.id); sessions.delete(id); rpc.broadcast("items.changed", {...}); }
  async closeAll() { for (const [, l] of this.live) await l.handle.dispose(); this.live.clear(); }
  markStaleOnBoot() { for (const s of sessions.listAll()) if (s.status === "running" || s.status === "waiting_permission") sessions.update({ id: s.id, status: "idle" }); }
}
```
(Write it out fully — the sketch above shows the responsibilities; `throw NotFound` = `throw new NotFoundError("session", id)`.) The FakeAdapter's `send` also emits `user_message`? No — the **service** emits `user_message` for all adapters to keep it uniform: in `send()`, `this.onEvent(id, sessionEvent("user_message", msg))` before `handle.send(msg)`; remove the `user_message` push from `ClaudeAdapter.send`.

`items.delete` for kind `session` routes through `SessionService.delete` (like terminals). `spaces.delete` closes sessions in the space.

`app.ts`: `createApp(opts: { home; port; adapters?: AdapterRegistry })` — default registry `{ claude: new ClaudeAdapter() }` (plus `fake` only when `process.env.REALM_ENABLE_FAKE_AGENT === "1"`); construct `SessionService`; `markStaleOnBoot()`; `close()` calls `sessions.closeAll()`. `App` exposes `sessions: SessionService`.

`methods.ts` register: `agents.probe`, `sessions.*` (create → `svc.create`, send → `svc.send`, interrupt, respondPermission, setOptions, events, get, list, delete).

- [ ] **Step 4: Pass** — `pnpm test`, `pnpm typecheck`, `pnpm --filter @realm/server build` (tsup: keep `@anthropic-ai/claude-agent-sdk` external — add to `external` array).

- [ ] **Step 5: Commit** — `git commit -m "feat(server): sessions store and service, session rpc"`

---

### Task 11: Desktop — sessions state + transcript view-model

**Files:**
- Create: `apps/desktop/src/renderer/src/panes/session/transcript-model.ts`, `panes/session/transcript-model.test.ts`
- Modify: `state/store.ts` (sessions slice), `state/live-api.ts`, `state/store.test.ts`, `state/store.test-fakes.ts`, `App.tsx` (subscribe `session.event`, `session.status`)

- [ ] **Step 1: Failing tests**

`transcript-model.test.ts`:
```ts
import { describe, expect, it } from "vitest"; import { reduceTranscript, emptyTranscript } from "./transcript-model"; import { sessionEvent } from "@realm/contracts";
describe("transcript model", () => {
  it("builds blocks: user, assistant (deltas then final), tool with result, permission pending→resolved", () => {
    let t = emptyTranscript();
    t = reduceTranscript(t, sessionEvent("user_message", { text: "hi", attachments: [] }));
    t = reduceTranscript(t, sessionEvent("assistant_delta", { messageId: "m1", delta: "He" }));
    t = reduceTranscript(t, sessionEvent("assistant_delta", { messageId: "m1", delta: "llo" }));
    expect(t.blocks.at(-1)).toMatchObject({ kind: "assistant", text: "Hello", streaming: true });
    t = reduceTranscript(t, sessionEvent("assistant_text", { messageId: "m1", text: "Hello" }));
    expect(t.blocks.at(-1)).toMatchObject({ kind: "assistant", text: "Hello", streaming: false });
    t = reduceTranscript(t, sessionEvent("tool_call", { toolUseId: "t1", name: "Bash", input: { command: "ls" }, parentToolUseId: null }));
    t = reduceTranscript(t, sessionEvent("permission_request", { requestId: "r1", toolName: "Bash", input: { command: "ls" }, title: "Run ls?", suggestions: [] }));
    expect(t.pendingPermission?.requestId).toBe("r1");
    t = reduceTranscript(t, sessionEvent("permission_response", { requestId: "r1", decision: "allow" }));
    expect(t.pendingPermission).toBeNull();
    t = reduceTranscript(t, sessionEvent("tool_result", { toolUseId: "t1", content: "a b", isError: false }));
    const tool = t.blocks.find((b) => b.kind === "tool")!; expect(tool.kind === "tool" && tool.result?.content).toBe("a b");
    t = reduceTranscript(t, sessionEvent("usage", { costUsd: 0.5, inputTokens: 1, outputTokens: 2, numTurns: 1 }));
    expect(t.usage.costUsd).toBe(0.5);
  });
  it("assistant_delta after final text starts a new block", () => {
    let t = emptyTranscript();
    t = reduceTranscript(t, sessionEvent("assistant_text", { messageId: "m1", text: "A" }));
    t = reduceTranscript(t, sessionEvent("assistant_delta", { messageId: "m2", delta: "B" }));
    expect(t.blocks.filter((b) => b.kind === "assistant")).toHaveLength(2);
  });
});
```

Store tests (append): `openSession(sessionId)` fetches events after known seq via `api.sessionEvents` and reduces; incoming `applySessionEvent(stored)` appends only if `seq > lastSeq` or ephemeral; `newSession()` calls `api.createSession` and adds the tab; `sendMessage`, `interrupt`, `respondPermission` call api; `sessionStatus[sessionId]` updated by `applySessionStatus`.

- [ ] **Step 2: Fail**.

- [ ] **Step 3: Implement**

`transcript-model.ts`:
```ts
import type { SessionEvent } from "@realm/contracts";
export type Block =
  | { kind: "user"; text: string; ts: number }
  | { kind: "assistant"; messageId: string; text: string; streaming: boolean; ts: number }
  | { kind: "thinking"; messageId: string; text: string; ts: number }
  | { kind: "tool"; toolUseId: string; name: string; input: Record<string, unknown>; result: { content: string; isError: boolean } | null; ts: number }
  | { kind: "error"; message: string; ts: number };
export type Transcript = { blocks: Block[]; pendingPermission: { requestId: string; toolName: string; input: Record<string, unknown>; title: string } | null; usage: { costUsd: number; inputTokens: number; outputTokens: number; numTurns: number }; init: { model: string; tools: string[]; providerSessionId: string } | null };
export const emptyTranscript = (): Transcript => ({ blocks: [], pendingPermission: null, usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 }, init: null });
export function reduceTranscript(t: Transcript, e: SessionEvent): Transcript {
  const blocks = t.blocks.slice(); const last = blocks.at(-1);
  switch (e.type) {
    case "user_message": blocks.push({ kind: "user", text: e.payload.text, ts: e.ts }); return { ...t, blocks };
    case "assistant_delta": {
      if (last?.kind === "assistant" && last.messageId === e.payload.messageId && last.streaming) blocks[blocks.length - 1] = { ...last, text: last.text + e.payload.delta };
      else blocks.push({ kind: "assistant", messageId: e.payload.messageId, text: e.payload.delta, streaming: true, ts: e.ts });
      return { ...t, blocks };
    }
    case "assistant_text": {
      const i = blocks.findLastIndex((b) => b.kind === "assistant" && b.messageId === e.payload.messageId && b.streaming);
      if (i >= 0) blocks[i] = { kind: "assistant", messageId: e.payload.messageId, text: e.payload.text, streaming: false, ts: e.ts };
      else blocks.push({ kind: "assistant", messageId: e.payload.messageId, text: e.payload.text, streaming: false, ts: e.ts });
      return { ...t, blocks };
    }
    case "thinking": blocks.push({ kind: "thinking", messageId: e.payload.messageId, text: e.payload.text, ts: e.ts }); return { ...t, blocks };
    case "tool_call": blocks.push({ kind: "tool", toolUseId: e.payload.toolUseId, name: e.payload.name, input: e.payload.input, result: null, ts: e.ts }); return { ...t, blocks };
    case "tool_result": { const i = blocks.findLastIndex((b) => b.kind === "tool" && b.toolUseId === e.payload.toolUseId); if (i >= 0) { const b = blocks[i]!; if (b.kind === "tool") blocks[i] = { ...b, result: { content: e.payload.content, isError: e.payload.isError } }; } return { ...t, blocks }; }
    case "permission_request": return { ...t, pendingPermission: { requestId: e.payload.requestId, toolName: e.payload.toolName, input: e.payload.input, title: e.payload.title } };
    case "permission_response": return t.pendingPermission?.requestId === e.payload.requestId ? { ...t, pendingPermission: null } : t;
    case "error": blocks.push({ kind: "error", message: e.payload.message, ts: e.ts }); return { ...t, blocks };
    case "usage": return { ...t, usage: e.payload };
    case "init": return { ...t, init: { model: e.payload.model, tools: e.payload.tools, providerSessionId: e.payload.providerSessionId } };
    case "status": return t;
  }
}
```

Store slice: `sessions: Record<string, Session>` (by id, for the active space), `sessionStatus: Record<string, SessionStatus>`, `transcripts: Record<string, { lastSeq: number; t: Transcript }>`, `agentProbe: ProbeResult[]`. Actions: `refreshSessions()`, `openSession(id)` (fetch events after `lastSeq`, reduce), `applySessionEvent(stored)`, `applySessionStatus`, `newSession(input)` (create → add tab → openSession), `sendMessage(id, text)`, `interruptSession(id)`, `respondPermission(id, requestId, decision)`, `setSessionOptions(id, o)`, `probeAgents()`. `live-api.ts` wiring for all. `App.tsx`: `rpc().on("session.event", …)` / `("session.status", …)` → store.

- [ ] **Step 4: Pass + commit** — `git commit -m "feat(desktop): sessions state and transcript model"`

---

### Task 12: Desktop — SessionPane (transcript, tool cards, permission card, composer), NewSessionSheet

**Files:**
- Create: `panes/session/{SessionPane,Transcript,ToolCard,PermissionCard,Composer,NewSessionSheet,Markdown}.tsx`, `panes/session/session-pane.test.tsx`
- Modify: `panes/index.ts` (register "session"), `components/sidebar/NewItemMenu.tsx` (enable "Session…"), `components/CommandPalette.tsx` (enable "New session…"), `styles.css`, `apps/desktop/package.json` (`marked`, `dompurify`, `@types/dompurify`)

- [ ] **Step 1: Failing test** `session-pane.test.tsx`:
```tsx
it("renders transcript blocks, shows permission card, and sends composer text", async () => {
  const api = fakeApi(); const store = createAppStore(api); await store.getState().boot();
  const sess = session("se1", "s1"); store.setState({ sessions: { se1: sess }, sessionStatus: { se1: "waiting_permission" },
    transcripts: { se1: { lastSeq: 3, t: reduceAll([sessionEvent("user_message", { text: "hi", attachments: [] }), sessionEvent("assistant_text", { messageId: "m", text: "**bold** hello" }),
      sessionEvent("tool_call", { toolUseId: "t1", name: "Bash", input: { command: "ls" }, parentToolUseId: null }),
      sessionEvent("permission_request", { requestId: "r1", toolName: "Bash", input: { command: "ls" }, title: "Run ls?", suggestions: [] })]) } } });
  const sent: string[] = []; api.sendMessage = async (_id, text) => { sent.push(text); }; const decided: string[] = []; api.respondPermission = async (_i, r, d) => { decided.push(`${r}:${d}`); };
  render(<StoreContext.Provider value={store}><SessionPane item={item("i9", "s1", { kind: "session", refId: "se1" })} visible /></StoreContext.Provider>);
  expect(screen.getByText("hi")).toBeInTheDocument();
  expect(screen.getByText("bold").tagName).toBe("STRONG");
  expect(screen.getByText(/Bash/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /^Allow$/ }));
  expect(decided).toEqual(["r1:allow"]);
  const box = screen.getByRole("textbox", { name: /message/i }); fireEvent.change(box, { target: { value: "next" } }); fireEvent.keyDown(box, { key: "Enter", metaKey: true });
  await waitFor(() => expect(sent).toEqual(["next"]));
});
```

- [ ] **Step 2: Fail**.

- [ ] **Step 3: Implement**
  - `Markdown.tsx`: `marked.parse(text)` → `DOMPurify.sanitize` → `dangerouslySetInnerHTML`; code blocks get a copy button via CSS-only? keep simple: `<pre><code>`; links open externally (`onClick` → `window.open` blocked by CSP; use `rel="noopener"` and let `setWindowOpenHandler` in main hand it to the OS).
  - `ToolCard.tsx`: collapsed row `▸ <Icon> Name  <summary of input>  <status: running spinner | ✓ | ✕>`; click expands to show input JSON (pretty) and result (pre, max-height with scroll). Summaries: Bash → `command`; Read/Write/Edit → `file_path`; Glob/Grep → `pattern`; others → first string field.
  - `PermissionCard.tsx`: title, tool name, input preview, buttons `Allow`, `Allow always`, `Deny` → `respondPermission`.
  - `Transcript.tsx`: scroll container; renders blocks: user bubble (right-aligned, `--rl-user-bubble`), assistant Markdown (streaming cursor `▍` when `streaming`), thinking (collapsed "Thinking…" toggle), tool card, error row; auto-scroll to bottom when the user is within 80px of bottom (else show "↓ new messages" pill); `PermissionCard` at the end when `pendingPermission`.
  - `Composer.tsx`: `<textarea aria-label="Message">` auto-grow; ⌘/Ctrl+Enter sends (plain Enter inserts newline); toolbar: model select (from `AGENT_MODELS[agentKind]`), effort select, permission-mode select (→ `setSessionOptions`), right: Stop button while `running` (interrupt) or Send. Bottom-left chip: `<Icon folder/> cwd basename` and project name.
  - `SessionPane.tsx`: header strip (agent icon + title, status dot, cost `$0.012 · 3 turns`), `<Transcript/>`, `<Composer/>`; on mount `openSession(refId)`.
  - `NewSessionSheet.tsx`: agent list from `agentProbe` (unavailable ones disabled with reason), project select (space projects + "Space folder"), model select, permission mode; Create → `newSession()`; opened from `NewItemMenu` and palette. Call `probeAgents()` on open.
  - `panes/index.ts`: `registerPane("session", SessionPane)`.
  - Styles: T3-like transcript in dark, Universe-like in light — all via tokens: `.msg-user`, `.msg-assistant`, `.tool-card`, `.permission-card`, `.composer` (rounded 14px, border `--rl-border`, shadow), `.session-header`.

- [ ] **Step 4: Tests + typecheck + live check** — `pnpm test`, `pnpm typecheck`; `pnpm dev`: New → Session… → Claude → send "Say REALM_OK" → streamed reply; ask it to `ls` → permission card → Allow → tool card with output; Stop works; relaunch app → transcript restored (events fetched) and a follow-up message resumes via `providerSessionId`.

- [ ] **Step 5: Commit** — `git commit -m "feat(desktop): session pane with transcript, tool cards, permissions, composer"`

---

### Task 13: Sidebar status dots, item title from first message, cleanup, docs

**Files:**
- Modify: `components/sidebar/ItemList.tsx` (status dot from `sessionStatus[item.refId]` for kind session; pulse when `waiting_permission`), `apps/server/src/sessions/service.ts` (on first `user_message`, set session/item title to first 40 chars), `README.md`, `docs/dev/getting-started.md` (`REALM_ENABLE_FAKE_AGENT=1` for offline dev; `claude` login requirement), remove dead Plan-1 components/tests, `docs/superpowers/specs/...` no change.

- [ ] **Step 1: Tests** — service test: after `sessions.send`, `sessions.get(...).title` equals the message text (truncated) and `items.list` shows the same title. Sidebar test: `sessionStatus` waiting → dot has `data-status="waiting_permission"`.

- [ ] **Step 2: Implement + pass** — `pnpm test`, `pnpm typecheck`, `pnpm build`.

- [ ] **Step 3: Live verification checklist** — two spaces with different colors: swipe & strip switching, theme adapts (toggle macOS appearance), palette ⌘K, space settings sheet (rename/color/profile/delete), new session in a project cwd, streaming reply, permission flow, interrupt, relaunch restore + resume, terminals still work, layouts persist.

- [ ] **Step 4: Commit** — `git commit -m "feat: session status in sidebar, titles from first message, docs"`

---

## Self-review against spec

- Amendment (spaces-first nav, profile as attribute, flat list, projects out of sidebar, adaptive theme from space color, floating card): Tasks 1–6 ✔. Projects appear in NewSessionSheet ✔ (Task 12).
- §3 data model: `Session`/`SessionEvent` tables (v3) ✔; `Space.color` ✔; settings used for UI prefs ✔.
- §4 adapters: interface + Claude (Agent SDK, resume via `providerSessionId`, permissions via `canUseTool`, `mcpServers` plumbed for Plan 4) ✔; Codex/ACP → Plan 3; probe panel → NewSessionSheet shows probe results (Settings panel later).
- §8 error handling: adapter crash → `error` + `ended` events, service drops live handle; next `send` re-`ensureLive`s with `resume` ✔; stale `running` statuses reset on boot ✔.
- Type consistency: `SessionEvent` types used by adapters, service, store, transcript model all come from `@realm/contracts/session-events` ✔; `Api` additions mirrored in `store.test-fakes.ts` ✔.
- Deferred to Plan 3+: Codex/ACP adapters, MCP config into sessions (realm-mcp), browser panes, Settings window (profiles/theme), keyboard shortcuts beyond ⌘K.
