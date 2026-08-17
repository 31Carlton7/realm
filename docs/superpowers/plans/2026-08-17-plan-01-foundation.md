# Realm Plan 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running Realm desktop app where the user can create profiles and spaces, link projects, open terminals, arrange panes in a persisted split-tree layout with grid presets — with the full UI ↔ realm-server ↔ SQLite path in place for later plans to hang agents, browser, context, and MCP on.

**Architecture:** pnpm monorepo. `packages/contracts` holds zod schemas, TS types, the RPC envelope, and pure layout-tree operations. `apps/server` is a plain-Node realm-server: `node:sqlite` store, WebSocket RPC + event broadcast, terminal (node-pty) manager. `apps/desktop` is an Electron app (electron-vite + React) whose main process spawns realm-server as a Node child process and whose renderer talks to it **only** over WebSocket. Spec: `docs/superpowers/specs/2026-08-17-realm-v1-design.md`.

**Tech Stack:** TypeScript 5, pnpm 10, Node 22.13+ (`node:sqlite`), zod 3, `ws`, `ulid`, `node-pty`, Electron 37+, electron-vite, React 19, zustand, `react-resizable-panels`, `@xterm/xterm`, Hugeicons React (`@hugeicons/react` + `@hugeicons-pro/core-stroke-rounded`), Vitest, React Testing Library.

**Conventions for every task:** commits use `-c user.name="Carlton Aikins" -c user.email="carlton@charmtechnologies.co"` only if git identity is not globally set; otherwise plain `git commit`. All commands run from repo root `/Users/carltonaikins/Desktop/Home/Work/Projects/realm` unless stated. Never commit `.npmrc` (Hugeicons token) — it is gitignored.

---

## File structure (what this plan creates)

```
realm/
  package.json                    workspace root scripts
  pnpm-workspace.yaml
  tsconfig.base.json
  vitest.workspace.ts
  .npmrc                          (gitignored) Hugeicons registry token
  packages/contracts/
    package.json, tsconfig.json, vitest.config.ts
    src/index.ts                  re-exports
    src/ids.ts                    ulid + branded id types
    src/entities.ts               Profile/Space/Project/Item schemas
    src/layout.ts                 Layout schema + pure ops + presets
    src/rpc.ts                    RPC envelope + method/event maps
    src/*.test.ts
  apps/server/
    package.json, tsconfig.json, tsup.config.ts, vitest.config.ts
    src/main.ts                   entry: boot store + ws server, announce port
    src/paths.ts                  REALM_HOME resolution
    src/db/database.ts            open node:sqlite + migrations
    src/db/migrations.ts          SQL migration list
    src/store/profiles.ts         CRUD
    src/store/spaces.ts           CRUD + folder creation + layout
    src/store/projects.ts         CRUD
    src/store/items.ts            CRUD
    src/rpc/server.ts             ws server, dispatch, broadcast
    src/rpc/methods.ts            registers all methods
    src/terminals/manager.ts      node-pty lifecycle
    src/**/*.test.ts
  apps/desktop/
    package.json, tsconfig.json, electron.vite.config.ts, vitest.config.ts
    src/main/index.ts             BrowserWindow + spawn server
    src/main/server-process.ts    spawn node, wait for ready
    src/preload/index.ts          exposes realm.port
    src/renderer/index.html
    src/renderer/src/main.tsx
    src/renderer/src/App.tsx
    src/renderer/src/rpc/client.ts     WS client with typed call/on
    src/renderer/src/state/store.ts    zustand app state
    src/renderer/src/components/ProfileStrip.tsx
    src/renderer/src/components/SpacesSidebar.tsx
    src/renderer/src/components/TabBar.tsx
    src/renderer/src/components/PaneHost.tsx     renders Layout tree
    src/renderer/src/components/LayoutMenu.tsx   grid presets
    src/renderer/src/panes/TerminalPane.tsx
    src/renderer/src/panes/PlaceholderPane.tsx
    src/renderer/src/styles.css
    src/renderer/src/**/*.test.tsx
  packages/ui/
    package.json, src/index.ts, src/Icon.tsx      Hugeicons wrapper
```

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`, `.gitignore` (modify), `packages/contracts/package.json`, `packages/contracts/tsconfig.json`, `packages/contracts/vitest.config.ts`, `packages/contracts/src/index.ts`, `packages/contracts/src/smoke.test.ts`

- [ ] **Step 1: Root workspace files**

`package.json`:
```json
{
  "name": "realm",
  "private": true,
  "packageManager": "pnpm@10.21.0",
  "engines": { "node": ">=22.13" },
  "scripts": {
    "build": "pnpm -r --filter './packages/**' --filter './apps/**' build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "pnpm -r typecheck",
    "dev": "pnpm --filter @realm/server build && pnpm -r --parallel --filter @realm/server --filter @realm/desktop dev"
  },
  "devDependencies": {
    "@types/node": "^22.13.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUncheckedIndexedAccess": true,
    "types": ["node"]
  }
}
```

`vitest.workspace.ts`:
```ts
export default ["packages/*/vitest.config.ts", "apps/*/vitest.config.ts"];
```

Append to `.gitignore`:
```
out/
*.tsbuildinfo
```

- [ ] **Step 2: contracts package skeleton**

`packages/contracts/package.json`:
```json
{
  "name": "@realm/contracts",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": { "build": "tsc -p tsconfig.json --noEmit", "typecheck": "tsc -p tsconfig.json --noEmit" },
  "dependencies": { "zod": "^3.24.0", "ulid": "^2.3.0" }
}
```

`packages/contracts/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

`packages/contracts/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { name: "contracts", environment: "node" } });
```

`packages/contracts/src/index.ts`:
```ts
export const CONTRACTS_VERSION = 1;
```

`packages/contracts/src/smoke.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { CONTRACTS_VERSION } from "./index";
describe("contracts", () => { it("loads", () => expect(CONTRACTS_VERSION).toBe(1)); });
```

- [ ] **Step 3: Install and run**

Run: `pnpm install && pnpm test`
Expected: `✓ packages/contracts/src/smoke.test.ts (1)` and exit 0.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: pnpm monorepo scaffold with contracts package"
```

---

### Task 2: Contracts — ids and entity schemas

**Files:**
- Create: `packages/contracts/src/ids.ts`, `packages/contracts/src/entities.ts`, `packages/contracts/src/entities.test.ts`
- Modify: `packages/contracts/src/index.ts`

- [ ] **Step 1: Failing test**

`packages/contracts/src/entities.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { newId } from "./ids";
import { ProfileSchema, SpaceSchema, ItemSchema } from "./entities";

describe("entities", () => {
  it("newId returns 26-char ULID", () => {
    expect(newId()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
  it("ProfileSchema accepts a valid profile", () => {
    const p = ProfileSchema.parse({
      id: newId(), name: "Work", icon: "briefcase", color: "#3366ff", sortOrder: 0,
      createdAt: 1, updatedAt: 1,
    });
    expect(p.name).toBe("Work");
  });
  it("SpaceSchema requires folderPath and defaults layout to null", () => {
    const s = SpaceSchema.parse({
      id: newId(), profileId: newId(), name: "Versed", icon: "folder", sortOrder: 0,
      folderPath: "/tmp/x", layout: null, activeItemId: null, createdAt: 1, updatedAt: 1,
    });
    expect(s.layout).toBeNull();
  });
  it("ItemSchema rejects unknown kind", () => {
    expect(() => ItemSchema.parse({
      id: newId(), spaceId: newId(), kind: "nope", title: "x", sortOrder: 0, pinned: false,
      refId: newId(), createdAt: 1, updatedAt: 1,
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm vitest run packages/contracts`
Expected: FAIL — cannot resolve `./ids` / `./entities`.

- [ ] **Step 3: Implement**

`packages/contracts/src/ids.ts`:
```ts
import { ulid } from "ulid";
export type Id = string;
export const newId = (): Id => ulid();
```

`packages/contracts/src/entities.ts`:
```ts
import { z } from "zod";
import { LayoutSchema } from "./layout";

const Timestamps = { createdAt: z.number().int(), updatedAt: z.number().int() };
export const IdSchema = z.string().length(26);

export const ProfileSchema = z.object({
  id: IdSchema, name: z.string().min(1), icon: z.string(), color: z.string(),
  sortOrder: z.number().int(), ...Timestamps,
});
export type Profile = z.infer<typeof ProfileSchema>;

export const SpaceSchema = z.object({
  id: IdSchema, profileId: IdSchema, name: z.string().min(1), icon: z.string(),
  sortOrder: z.number().int(), folderPath: z.string(),
  layout: LayoutSchema.nullable(), activeItemId: IdSchema.nullable(), ...Timestamps,
});
export type Space = z.infer<typeof SpaceSchema>;

export const ProjectSchema = z.object({
  id: IdSchema, spaceId: IdSchema, name: z.string().min(1), rootPath: z.string(),
  defaultBranch: z.string().default("main"), ...Timestamps,
});
export type Project = z.infer<typeof ProjectSchema>;

export const ItemKindSchema = z.enum(["session", "terminal", "browser", "simulator", "artifact", "context"]);
export type ItemKind = z.infer<typeof ItemKindSchema>;

export const ItemSchema = z.object({
  id: IdSchema, spaceId: IdSchema, kind: ItemKindSchema, title: z.string(),
  sortOrder: z.number().int(), pinned: z.boolean(), refId: IdSchema, ...Timestamps,
});
export type Item = z.infer<typeof ItemSchema>;
```

`packages/contracts/src/layout.ts` (minimal for now; full ops in Task 3):
```ts
import { z } from "zod";

export type Layout =
  | { type: "split"; id: string; dir: "row" | "col"; sizes: number[]; children: Layout[] }
  | { type: "leaf"; id: string; tabs: string[]; activeTab: string | null };

export const LayoutSchema: z.ZodType<Layout> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("split"), id: z.string(), dir: z.enum(["row", "col"]),
      sizes: z.array(z.number()), children: z.array(LayoutSchema) }),
    z.object({ type: z.literal("leaf"), id: z.string(), tabs: z.array(z.string()),
      activeTab: z.string().nullable() }),
  ]),
);
```

`packages/contracts/src/index.ts`:
```ts
export const CONTRACTS_VERSION = 1;
export * from "./ids";
export * from "./entities";
export * from "./layout";
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/contracts`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(contracts): ids and entity schemas"
```

---

### Task 3: Contracts — layout tree operations and presets

**Files:**
- Modify: `packages/contracts/src/layout.ts`
- Create: `packages/contracts/src/layout.test.ts`

- [ ] **Step 1: Failing tests**

`packages/contracts/src/layout.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  emptyLayout, addTab, splitLeaf, removeTab, findLeafOfTab, allTabs, gridPreset, setActiveTab,
} from "./layout";

describe("layout ops", () => {
  it("emptyLayout is a single empty leaf", () => {
    const l = emptyLayout();
    expect(l.type).toBe("leaf");
    expect(allTabs(l)).toEqual([]);
  });

  it("addTab puts tab in target leaf and activates it", () => {
    const l = emptyLayout();
    const l2 = addTab(l, l.id, "A");
    expect(allTabs(l2)).toEqual(["A"]);
    expect(findLeafOfTab(l2, "A")?.activeTab).toBe("A");
  });

  it("addTab with no leafId uses first leaf", () => {
    const l2 = addTab(emptyLayout(), null, "A");
    expect(allTabs(l2)).toEqual(["A"]);
  });

  it("splitLeaf creates a split with old leaf and new leaf holding new tab", () => {
    const l = addTab(emptyLayout(), null, "A");
    const l2 = splitLeaf(l, l.id, "row", "B");
    expect(l2.type).toBe("split");
    if (l2.type !== "split") throw new Error();
    expect(l2.dir).toBe("row");
    expect(l2.children).toHaveLength(2);
    expect(l2.sizes).toEqual([50, 50]);
    expect(allTabs(l2)).toEqual(["A", "B"]);
  });

  it("removeTab removes tab; empty leaves collapse; single-child splits unwrap", () => {
    const l = addTab(emptyLayout(), null, "A");
    const l2 = splitLeaf(l, l.id, "row", "B");
    const l3 = removeTab(l2, "B");
    expect(l3.type).toBe("leaf");
    expect(allTabs(l3)).toEqual(["A"]);
  });

  it("removeTab never removes the last leaf", () => {
    const l = addTab(emptyLayout(), null, "A");
    const l2 = removeTab(l, "A");
    expect(l2.type).toBe("leaf");
    expect(allTabs(l2)).toEqual([]);
  });

  it("removeTab moves activeTab to a neighbor", () => {
    let l = addTab(emptyLayout(), null, "A");
    l = addTab(l, null, "B");
    l = removeTab(l, "B");
    expect(findLeafOfTab(l, "A")?.activeTab).toBe("A");
  });

  it("setActiveTab activates in the containing leaf", () => {
    let l = addTab(emptyLayout(), null, "A");
    l = addTab(l, null, "B");
    l = setActiveTab(l, "A");
    expect(findLeafOfTab(l, "A")?.activeTab).toBe("A");
  });

  it("gridPreset 2x2 distributes items across 4 leaves", () => {
    const l = gridPreset("grid-2x2", ["A", "B", "C", "D", "E"]);
    expect(l.type).toBe("split");
    if (l.type !== "split") throw new Error();
    expect(l.dir).toBe("col");
    expect(l.children).toHaveLength(2);
    expect(allTabs(l)).toEqual(["A", "B", "C", "D", "E"]);
    // 5th item lands in the first leaf as an extra tab
    expect(findLeafOfTab(l, "E")?.tabs).toEqual(["A", "E"]);
  });

  it("gridPreset 1-up puts everything in one leaf", () => {
    const l = gridPreset("one", ["A", "B"]);
    expect(l.type).toBe("leaf");
    expect(allTabs(l)).toEqual(["A", "B"]);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm vitest run packages/contracts/src/layout.test.ts`
Expected: FAIL — `emptyLayout` etc. not exported.

- [ ] **Step 3: Implement ops**

Add `import { newId } from "./ids";` to the top of `packages/contracts/src/layout.ts` (next to the zod import), then append:
```ts
export type LayoutLeaf = Extract<Layout, { type: "leaf" }>;
export type LayoutSplit = Extract<Layout, { type: "split" }>;
export type PresetName = "one" | "two-col" | "three-col" | "grid-2x2" | "grid-3x3";
export const PRESETS: PresetName[] = ["one", "two-col", "three-col", "grid-2x2", "grid-3x3"];

export const emptyLayout = (): LayoutLeaf => ({ type: "leaf", id: newId(), tabs: [], activeTab: null });

export function allTabs(l: Layout): string[] {
  return l.type === "leaf" ? [...l.tabs] : l.children.flatMap(allTabs);
}

export function firstLeaf(l: Layout): LayoutLeaf {
  return l.type === "leaf" ? l : firstLeaf(l.children[0]!);
}

export function findLeafOfTab(l: Layout, tabId: string): LayoutLeaf | null {
  if (l.type === "leaf") return l.tabs.includes(tabId) ? l : null;
  for (const c of l.children) { const f = findLeafOfTab(c, tabId); if (f) return f; }
  return null;
}

function mapLeaves(l: Layout, fn: (leaf: LayoutLeaf) => Layout): Layout {
  return l.type === "leaf" ? fn(l) : { ...l, children: l.children.map((c) => mapLeaves(c, fn)) };
}

export function addTab(l: Layout, leafId: string | null, tabId: string): Layout {
  const target = leafId ?? firstLeaf(l).id;
  return mapLeaves(l, (leaf) =>
    leaf.id === target && !leaf.tabs.includes(tabId)
      ? { ...leaf, tabs: [...leaf.tabs, tabId], activeTab: tabId }
      : leaf,
  );
}

export function setActiveTab(l: Layout, tabId: string): Layout {
  return mapLeaves(l, (leaf) => (leaf.tabs.includes(tabId) ? { ...leaf, activeTab: tabId } : leaf));
}

export function splitLeaf(l: Layout, leafId: string, dir: "row" | "col", newTabId: string): Layout {
  return mapLeaves(l, (leaf) => {
    if (leaf.id !== leafId) return leaf;
    const fresh: LayoutLeaf = { type: "leaf", id: newId(), tabs: [newTabId], activeTab: newTabId };
    return { type: "split", id: newId(), dir, sizes: [50, 50], children: [leaf, fresh] };
  });
}

/** Remove a tab everywhere; prune empty leaves (except the last one); unwrap single-child splits. */
export function removeTab(l: Layout, tabId: string): Layout {
  const pruned = prune(l);
  return pruned ?? emptyLayout();

  function prune(n: Layout): Layout | null {
    if (n.type === "leaf") {
      if (!n.tabs.includes(tabId)) return n;
      const tabs = n.tabs.filter((t) => t !== tabId);
      if (tabs.length === 0) return null;
      const idx = n.tabs.indexOf(tabId);
      const activeTab = n.activeTab === tabId ? (tabs[Math.min(idx, tabs.length - 1)] ?? null) : n.activeTab;
      return { ...n, tabs, activeTab };
    }
    const kept: Layout[] = []; const sizes: number[] = [];
    n.children.forEach((c, i) => { const p = prune(c); if (p) { kept.push(p); sizes.push(n.sizes[i] ?? 0); } });
    if (kept.length === 0) return null;
    if (kept.length === 1) return kept[0]!;
    const total = sizes.reduce((a, b) => a + b, 0) || 1;
    return { ...n, children: kept, sizes: sizes.map((s) => (s / total) * 100) };
  }
}

/** Build a preset layout from an ordered list of item ids. Extra items become tabs on leaves round-robin. */
export function gridPreset(name: PresetName, items: string[]): Layout {
  const shape: { rows: number; cols: number } =
    name === "one" ? { rows: 1, cols: 1 } : name === "two-col" ? { rows: 1, cols: 2 }
    : name === "three-col" ? { rows: 1, cols: 3 } : name === "grid-2x2" ? { rows: 2, cols: 2 }
    : { rows: 3, cols: 3 };
  const leafCount = shape.rows * shape.cols;
  const leaves: LayoutLeaf[] = Array.from({ length: leafCount }, () => emptyLayout());
  items.forEach((it, i) => { const leaf = leaves[i % leafCount]!; leaf.tabs.push(it); leaf.activeTab ??= it; });
  if (leafCount === 1) return leaves[0]!;
  const rows: Layout[] = [];
  for (let r = 0; r < shape.rows; r++) {
    const rowLeaves = leaves.slice(r * shape.cols, (r + 1) * shape.cols);
    rows.push(shape.cols === 1 ? rowLeaves[0]! :
      { type: "split", id: newId(), dir: "row", sizes: rowLeaves.map(() => 100 / shape.cols), children: rowLeaves });
  }
  return shape.rows === 1 ? rows[0]! :
    { type: "split", id: newId(), dir: "col", sizes: rows.map(() => 100 / shape.rows), children: rows };
}
```

Note: `layout.ts` imports `newId` from `./ids` and `entities.ts` imports `LayoutSchema` from `./layout` — no cycle since `ids.ts` imports nothing.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/contracts`
Expected: all pass (15 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(contracts): layout tree ops and grid presets"
```

---

### Task 4: Contracts — RPC envelope and method/event maps

**Files:**
- Create: `packages/contracts/src/rpc.ts`, `packages/contracts/src/rpc.test.ts`
- Modify: `packages/contracts/src/index.ts` (add `export * from "./rpc";`)

- [ ] **Step 1: Failing test**

`packages/contracts/src/rpc.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { RpcRequestSchema, RpcResponseSchema, RpcEventSchema, parseWireMessage } from "./rpc";

describe("rpc envelope", () => {
  it("parses a request", () => {
    const m = parseWireMessage(JSON.stringify({ id: "1", method: "profiles.list", params: {} }));
    expect(m.kind).toBe("request");
  });
  it("parses ok and error responses", () => {
    expect(RpcResponseSchema.parse({ id: "1", ok: true, result: [] }).ok).toBe(true);
    expect(RpcResponseSchema.parse({ id: "1", ok: false, error: { code: "NOT_FOUND", message: "x" } }).ok).toBe(false);
  });
  it("parses an event", () => {
    expect(RpcEventSchema.parse({ event: "spaces.changed", payload: {} }).event).toBe("spaces.changed");
  });
  it("rejects garbage", () => {
    expect(() => parseWireMessage("{}")).toThrow();
    expect(RpcRequestSchema.safeParse({ id: 1 }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm vitest run packages/contracts/src/rpc.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`packages/contracts/src/rpc.ts`:
```ts
import { z } from "zod";
import { ProfileSchema, SpaceSchema, ProjectSchema, ItemSchema, ItemKindSchema, IdSchema } from "./entities";
import { LayoutSchema } from "./layout";

export const RpcRequestSchema = z.object({ id: z.string(), method: z.string(), params: z.unknown() });
export const RpcErrorSchema = z.object({ code: z.string(), message: z.string() });
export const RpcResponseSchema = z.discriminatedUnion("ok", [
  z.object({ id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.string(), ok: z.literal(false), error: RpcErrorSchema }),
]);
export const RpcEventSchema = z.object({ event: z.string(), payload: z.unknown() });
export type RpcRequest = z.infer<typeof RpcRequestSchema>;
export type RpcResponse = z.infer<typeof RpcResponseSchema>;
export type RpcEvent = z.infer<typeof RpcEventSchema>;
export type RpcError = z.infer<typeof RpcErrorSchema>;

export type WireMessage =
  | { kind: "request"; msg: RpcRequest } | { kind: "response"; msg: RpcResponse } | { kind: "event"; msg: RpcEvent };

export function parseWireMessage(raw: string): WireMessage {
  const json: unknown = JSON.parse(raw);
  const req = RpcRequestSchema.safeParse(json); if (req.success) return { kind: "request", msg: req.data };
  const res = RpcResponseSchema.safeParse(json); if (res.success) return { kind: "response", msg: res.data };
  const ev = RpcEventSchema.safeParse(json); if (ev.success) return { kind: "event", msg: ev.data };
  throw new Error("Unrecognized wire message");
}

/** Method registry: params + result schemas. Server validates params; client types results. */
export const Methods = {
  "profiles.list":   { params: z.object({}), result: z.array(ProfileSchema) },
  "profiles.create": { params: z.object({ name: z.string().min(1), icon: z.string().default("user"), color: z.string().default("#6b7280") }), result: ProfileSchema },
  "profiles.update": { params: z.object({ id: IdSchema, name: z.string().min(1).optional(), icon: z.string().optional(), color: z.string().optional(), sortOrder: z.number().int().optional() }), result: ProfileSchema },
  "profiles.delete": { params: z.object({ id: IdSchema }), result: z.object({ ok: z.literal(true) }) },

  "spaces.list":   { params: z.object({ profileId: IdSchema }), result: z.array(SpaceSchema) },
  "spaces.create": { params: z.object({ profileId: IdSchema, name: z.string().min(1), icon: z.string().default("folder") }), result: SpaceSchema },
  "spaces.update": { params: z.object({ id: IdSchema, name: z.string().min(1).optional(), icon: z.string().optional(), sortOrder: z.number().int().optional(), activeItemId: IdSchema.nullable().optional() }), result: SpaceSchema },
  "spaces.setLayout": { params: z.object({ id: IdSchema, layout: LayoutSchema }), result: SpaceSchema },
  "spaces.delete": { params: z.object({ id: IdSchema }), result: z.object({ ok: z.literal(true) }) },

  "projects.list":   { params: z.object({ spaceId: IdSchema }), result: z.array(ProjectSchema) },
  "projects.create": { params: z.object({ spaceId: IdSchema, name: z.string().min(1), rootPath: z.string(), defaultBranch: z.string().default("main") }), result: ProjectSchema },
  "projects.delete": { params: z.object({ id: IdSchema }), result: z.object({ ok: z.literal(true) }) },

  "items.list":   { params: z.object({ spaceId: IdSchema }), result: z.array(ItemSchema) },
  "items.create": { params: z.object({ spaceId: IdSchema, kind: ItemKindSchema, title: z.string(), refId: IdSchema }), result: ItemSchema },
  "items.update": { params: z.object({ id: IdSchema, title: z.string().optional(), pinned: z.boolean().optional(), sortOrder: z.number().int().optional() }), result: ItemSchema },
  "items.delete": { params: z.object({ id: IdSchema }), result: z.object({ ok: z.literal(true) }) },

  "terminals.create": { params: z.object({ spaceId: IdSchema, cwd: z.string().optional(), cols: z.number().int().default(80), rows: z.number().int().default(24) }), result: z.object({ terminalId: IdSchema, itemId: IdSchema }) },
  "terminals.write":  { params: z.object({ terminalId: IdSchema, data: z.string() }), result: z.object({ ok: z.literal(true) }) },
  "terminals.resize": { params: z.object({ terminalId: IdSchema, cols: z.number().int(), rows: z.number().int() }), result: z.object({ ok: z.literal(true) }) },
  "terminals.close":  { params: z.object({ terminalId: IdSchema }), result: z.object({ ok: z.literal(true) }) },

  "system.info": { params: z.object({}), result: z.object({ realmHome: z.string(), version: z.string() }) },
} as const;

export type MethodName = keyof typeof Methods;
export type MethodParams<M extends MethodName> = z.input<(typeof Methods)[M]["params"]>;
export type MethodResult<M extends MethodName> = z.infer<(typeof Methods)[M]["result"]>;

export const Events = {
  "profiles.changed": z.object({}),
  "spaces.changed":   z.object({ profileId: IdSchema }),
  "items.changed":    z.object({ spaceId: IdSchema }),
  "terminal.data":    z.object({ terminalId: IdSchema, data: z.string() }),
  "terminal.exit":    z.object({ terminalId: IdSchema, exitCode: z.number().int() }),
} as const;
export type EventName = keyof typeof Events;
export type EventPayload<E extends EventName> = z.infer<(typeof Events)[E]>;
```

Add to `packages/contracts/src/index.ts`: `export * from "./rpc";`

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/contracts && pnpm --filter @realm/contracts typecheck`
Expected: pass, no type errors.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(contracts): rpc envelope, method and event registries"
```

---

### Task 5: Server — database and migrations

**Files:**
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/tsup.config.ts`, `apps/server/vitest.config.ts`, `apps/server/src/paths.ts`, `apps/server/src/db/migrations.ts`, `apps/server/src/db/database.ts`, `apps/server/src/db/database.test.ts`

- [ ] **Step 1: Package files**

`apps/server/package.json`:
```json
{
  "name": "@realm/server",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "start": "node dist/main.js",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@realm/contracts": "workspace:*",
    "node-pty": "^1.1.0",
    "ws": "^8.18.0",
    "zod": "^3.24.0"
  },
  "devDependencies": { "@types/ws": "^8.5.12", "tsup": "^8.3.0" }
}
```

`apps/server/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist" }, "include": ["src"] }
```

`apps/server/tsup.config.ts`:
```ts
import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/main.ts"], format: ["esm"], target: "node22", platform: "node",
  outDir: "dist", clean: true, sourcemap: true, external: ["node-pty"], noExternal: ["@realm/contracts"],
});
```

`apps/server/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { name: "server", environment: "node" } });
```

- [ ] **Step 2: Failing test**

`apps/server/src/db/database.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./database";

describe("database", () => {
  it("creates schema and records version", () => {
    const dir = mkdtempSync(join(tmpdir(), "realm-db-"));
    const db = openDatabase(join(dir, "realm.db"));
    const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
    expect(row.v).toBeGreaterThanOrEqual(1);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = tables.map((t) => t.name);
    for (const t of ["profiles", "spaces", "projects", "items", "terminals", "settings"]) expect(names).toContain(t);
    db.close();
  });
  it("is idempotent on reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "realm-db-"));
    const p = join(dir, "realm.db");
    openDatabase(p).close();
    expect(() => openDatabase(p).close()).not.toThrow();
  });
});
```

- [ ] **Step 3: Run to verify fail**

Run: `pnpm install && pnpm vitest run apps/server` — Expected: FAIL (module missing).

- [ ] **Step 4: Implement**

`apps/server/src/paths.ts`:
```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export function realmHome(): string {
  const h = process.env.REALM_HOME ?? join(homedir(), "Realm");
  mkdirSync(h, { recursive: true });
  return h;
}
export const dbPath = (home = realmHome()) => join(home, "realm.db");
```

`apps/server/src/db/migrations.ts`:
```ts
export const migrations: string[] = [
  // v1
  `
  CREATE TABLE profiles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL, color TEXT NOT NULL,
    sort_order INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    name TEXT NOT NULL, icon TEXT NOT NULL, sort_order INTEGER NOT NULL, folder_path TEXT NOT NULL,
    layout_json TEXT, active_item_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX spaces_profile ON spaces(profile_id);
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL, root_path TEXT NOT NULL, default_branch TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX projects_space ON projects(space_id);
  CREATE TABLE items (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, title TEXT NOT NULL, sort_order INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
    ref_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX items_space ON items(space_id);
  CREATE TABLE terminals (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    cwd TEXT NOT NULL, shell TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
  `,
];
```

`apps/server/src/db/database.ts`:
```ts
import { DatabaseSync } from "node:sqlite";
import { migrations } from "./migrations";

export type Db = DatabaseSync;

export function openDatabase(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_version").get() as { v: number };
  for (let v = row.v; v < migrations.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(migrations[v]!);
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(v + 1, Date.now());
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  }
  return db;
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run apps/server` — Expected: 2 pass.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(server): node:sqlite database with migrations"
```

---

### Task 6: Server — profiles, spaces, projects, items store

**Files:**
- Create: `apps/server/src/store/rows.ts`, `apps/server/src/store/profiles.ts`, `apps/server/src/store/spaces.ts`, `apps/server/src/store/projects.ts`, `apps/server/src/store/items.ts`, `apps/server/src/store/store.test.ts`

- [ ] **Step 1: Failing test**

`apps/server/src/store/store.test.ts`:
```ts
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Db } from "../db/database";
import { ProfilesStore } from "./profiles";
import { SpacesStore } from "./spaces";
import { ProjectsStore } from "./projects";
import { ItemsStore } from "./items";
import { emptyLayout } from "@realm/contracts";

let db: Db; let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "realm-home-"));
  db = openDatabase(join(home, "realm.db"));
});

describe("ProfilesStore", () => {
  it("creates, lists in sort order, updates, deletes", () => {
    const s = new ProfilesStore(db);
    const a = s.create({ name: "Work", icon: "briefcase", color: "#000" });
    const b = s.create({ name: "School", icon: "cap", color: "#111" });
    expect(s.list().map((p) => p.name)).toEqual(["Work", "School"]);
    expect(s.update({ id: b.id, sortOrder: -1 }).sortOrder).toBe(-1);
    expect(s.list()[0]!.name).toBe("School");
    s.delete(a.id);
    expect(s.list()).toHaveLength(1);
  });
});

describe("SpacesStore", () => {
  it("creates a space with a folder on disk under <home>/<profile>/<space>", () => {
    const profiles = new ProfilesStore(db); const spaces = new SpacesStore(db, home);
    const p = profiles.create({ name: "Work", icon: "x", color: "#000" });
    const sp = spaces.create({ profileId: p.id, name: "Versed", icon: "folder" });
    expect(sp.folderPath).toBe(join(home, "work", "versed"));
    expect(existsSync(sp.folderPath)).toBe(true);
    expect(sp.layout).toBeNull();
  });
  it("slugifies names and dedupes folder collisions", () => {
    const profiles = new ProfilesStore(db); const spaces = new SpacesStore(db, home);
    const p = profiles.create({ name: "My Work!", icon: "x", color: "#000" });
    const a = spaces.create({ profileId: p.id, name: "Cider App", icon: "f" });
    const b = spaces.create({ profileId: p.id, name: "Cider App", icon: "f" });
    expect(a.folderPath).toBe(join(home, "my-work", "cider-app"));
    expect(b.folderPath).toBe(join(home, "my-work", "cider-app-2"));
  });
  it("stores and returns layout", () => {
    const profiles = new ProfilesStore(db); const spaces = new SpacesStore(db, home);
    const p = profiles.create({ name: "W", icon: "x", color: "#000" });
    const sp = spaces.create({ profileId: p.id, name: "S", icon: "f" });
    const layout = emptyLayout();
    expect(spaces.setLayout(sp.id, layout).layout).toEqual(layout);
    expect(spaces.get(sp.id)?.layout).toEqual(layout);
  });
  it("delete cascades to projects and items", () => {
    const profiles = new ProfilesStore(db); const spaces = new SpacesStore(db, home);
    const projects = new ProjectsStore(db); const items = new ItemsStore(db);
    const p = profiles.create({ name: "W", icon: "x", color: "#000" });
    const sp = spaces.create({ profileId: p.id, name: "S", icon: "f" });
    projects.create({ spaceId: sp.id, name: "repo", rootPath: "/tmp/repo", defaultBranch: "main" });
    items.create({ spaceId: sp.id, kind: "terminal", title: "zsh", refId: sp.id });
    spaces.delete(sp.id);
    expect(projects.list(sp.id)).toEqual([]);
    expect(items.list(sp.id)).toEqual([]);
  });
});

describe("ItemsStore", () => {
  it("appends with increasing sortOrder and updates", () => {
    const profiles = new ProfilesStore(db); const spaces = new SpacesStore(db, home); const items = new ItemsStore(db);
    const p = profiles.create({ name: "W", icon: "x", color: "#000" });
    const sp = spaces.create({ profileId: p.id, name: "S", icon: "f" });
    const a = items.create({ spaceId: sp.id, kind: "terminal", title: "a", refId: sp.id });
    const b = items.create({ spaceId: sp.id, kind: "terminal", title: "b", refId: sp.id });
    expect(b.sortOrder).toBeGreaterThan(a.sortOrder);
    expect(items.update({ id: a.id, title: "renamed", pinned: true }).pinned).toBe(true);
    expect(items.get(a.id)?.title).toBe("renamed");
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm vitest run apps/server/src/store` — Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`apps/server/src/store/rows.ts`:
```ts
export const now = () => Date.now();
export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "space";
}
export class NotFoundError extends Error { code = "NOT_FOUND" as const; constructor(what: string, id: string) { super(`${what} ${id} not found`); } }
```

`apps/server/src/store/profiles.ts`:
```ts
import type { Db } from "../db/database";
import { newId, type Profile } from "@realm/contracts";
import { NotFoundError, now } from "./rows";

type Row = { id: string; name: string; icon: string; color: string; sort_order: number; created_at: number; updated_at: number };
const toProfile = (r: Row): Profile => ({ id: r.id, name: r.name, icon: r.icon, color: r.color, sortOrder: r.sort_order, createdAt: r.created_at, updatedAt: r.updated_at });

export class ProfilesStore {
  constructor(private db: Db) {}
  list(): Profile[] {
    return (this.db.prepare("SELECT * FROM profiles ORDER BY sort_order, created_at").all() as Row[]).map(toProfile);
  }
  get(id: string): Profile | null {
    const r = this.db.prepare("SELECT * FROM profiles WHERE id = ?").get(id) as Row | undefined;
    return r ? toProfile(r) : null;
  }
  create(input: { name: string; icon: string; color: string }): Profile {
    const max = (this.db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM profiles").get() as { m: number }).m;
    const id = newId(); const t = now();
    this.db.prepare("INSERT INTO profiles (id, name, icon, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.name, input.icon, input.color, max + 1, t, t);
    return this.get(id)!;
  }
  update(input: { id: string; name?: string; icon?: string; color?: string; sortOrder?: number }): Profile {
    const cur = this.get(input.id); if (!cur) throw new NotFoundError("profile", input.id);
    this.db.prepare("UPDATE profiles SET name = ?, icon = ?, color = ?, sort_order = ?, updated_at = ? WHERE id = ?")
      .run(input.name ?? cur.name, input.icon ?? cur.icon, input.color ?? cur.color, input.sortOrder ?? cur.sortOrder, now(), input.id);
    return this.get(input.id)!;
  }
  delete(id: string): void {
    if (!this.get(id)) throw new NotFoundError("profile", id);
    this.db.prepare("DELETE FROM profiles WHERE id = ?").run(id);
  }
}
```

`apps/server/src/store/spaces.ts`:
```ts
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db/database";
import { newId, LayoutSchema, type Layout, type Space } from "@realm/contracts";
import { NotFoundError, now, slugify } from "./rows";

type Row = { id: string; profile_id: string; name: string; icon: string; sort_order: number; folder_path: string;
  layout_json: string | null; active_item_id: string | null; created_at: number; updated_at: number };
const toSpace = (r: Row): Space => ({
  id: r.id, profileId: r.profile_id, name: r.name, icon: r.icon, sortOrder: r.sort_order, folderPath: r.folder_path,
  layout: r.layout_json ? LayoutSchema.parse(JSON.parse(r.layout_json)) : null,
  activeItemId: r.active_item_id, createdAt: r.created_at, updatedAt: r.updated_at,
});

export class SpacesStore {
  constructor(private db: Db, private home: string) {}
  list(profileId: string): Space[] {
    return (this.db.prepare("SELECT * FROM spaces WHERE profile_id = ? ORDER BY sort_order, created_at").all(profileId) as Row[]).map(toSpace);
  }
  get(id: string): Space | null {
    const r = this.db.prepare("SELECT * FROM spaces WHERE id = ?").get(id) as Row | undefined;
    return r ? toSpace(r) : null;
  }
  create(input: { profileId: string; name: string; icon: string }): Space {
    const prof = this.db.prepare("SELECT name FROM profiles WHERE id = ?").get(input.profileId) as { name: string } | undefined;
    if (!prof) throw new NotFoundError("profile", input.profileId);
    const folder = this.allocateFolder(slugify(prof.name), slugify(input.name));
    mkdirSync(folder, { recursive: true });
    const max = (this.db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM spaces WHERE profile_id = ?").get(input.profileId) as { m: number }).m;
    const id = newId(); const t = now();
    this.db.prepare(`INSERT INTO spaces (id, profile_id, name, icon, sort_order, folder_path, layout_json, active_item_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`).run(id, input.profileId, input.name, input.icon, max + 1, folder, t, t);
    return this.get(id)!;
  }
  update(input: { id: string; name?: string; icon?: string; sortOrder?: number; activeItemId?: string | null }): Space {
    const cur = this.get(input.id); if (!cur) throw new NotFoundError("space", input.id);
    this.db.prepare("UPDATE spaces SET name = ?, icon = ?, sort_order = ?, active_item_id = ?, updated_at = ? WHERE id = ?")
      .run(input.name ?? cur.name, input.icon ?? cur.icon, input.sortOrder ?? cur.sortOrder,
        input.activeItemId === undefined ? cur.activeItemId : input.activeItemId, now(), input.id);
    return this.get(input.id)!;
  }
  setLayout(id: string, layout: Layout): Space {
    if (!this.get(id)) throw new NotFoundError("space", id);
    this.db.prepare("UPDATE spaces SET layout_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(layout), now(), id);
    return this.get(id)!;
  }
  delete(id: string): void {
    if (!this.get(id)) throw new NotFoundError("space", id);
    this.db.prepare("DELETE FROM spaces WHERE id = ?").run(id);
    // Folder is intentionally left on disk (user data).
  }
  private allocateFolder(profileSlug: string, spaceSlug: string): string {
    const base = join(this.home, profileSlug, spaceSlug);
    if (!existsSync(base) && !this.folderInUse(base)) return base;
    for (let n = 2; ; n++) { const p = `${base}-${n}`; if (!existsSync(p) && !this.folderInUse(p)) return p; }
  }
  private folderInUse(p: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM spaces WHERE folder_path = ?").get(p);
  }
}
```

`apps/server/src/store/projects.ts`:
```ts
import type { Db } from "../db/database";
import { newId, type Project } from "@realm/contracts";
import { NotFoundError, now } from "./rows";

type Row = { id: string; space_id: string; name: string; root_path: string; default_branch: string; created_at: number; updated_at: number };
const toProject = (r: Row): Project => ({ id: r.id, spaceId: r.space_id, name: r.name, rootPath: r.root_path, defaultBranch: r.default_branch, createdAt: r.created_at, updatedAt: r.updated_at });

export class ProjectsStore {
  constructor(private db: Db) {}
  list(spaceId: string): Project[] {
    return (this.db.prepare("SELECT * FROM projects WHERE space_id = ? ORDER BY created_at").all(spaceId) as Row[]).map(toProject);
  }
  get(id: string): Project | null {
    const r = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined; return r ? toProject(r) : null;
  }
  create(input: { spaceId: string; name: string; rootPath: string; defaultBranch: string }): Project {
    const id = newId(); const t = now();
    this.db.prepare("INSERT INTO projects (id, space_id, name, root_path, default_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.spaceId, input.name, input.rootPath, input.defaultBranch, t, t);
    return this.get(id)!;
  }
  delete(id: string): void {
    if (!this.get(id)) throw new NotFoundError("project", id);
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }
}
```

`apps/server/src/store/items.ts`:
```ts
import type { Db } from "../db/database";
import { newId, type Item, type ItemKind } from "@realm/contracts";
import { NotFoundError, now } from "./rows";

type Row = { id: string; space_id: string; kind: ItemKind; title: string; sort_order: number; pinned: number; ref_id: string; created_at: number; updated_at: number };
const toItem = (r: Row): Item => ({ id: r.id, spaceId: r.space_id, kind: r.kind, title: r.title, sortOrder: r.sort_order, pinned: r.pinned === 1, refId: r.ref_id, createdAt: r.created_at, updatedAt: r.updated_at });

export class ItemsStore {
  constructor(private db: Db) {}
  list(spaceId: string): Item[] {
    return (this.db.prepare("SELECT * FROM items WHERE space_id = ? ORDER BY pinned DESC, sort_order, created_at").all(spaceId) as Row[]).map(toItem);
  }
  get(id: string): Item | null {
    const r = this.db.prepare("SELECT * FROM items WHERE id = ?").get(id) as Row | undefined; return r ? toItem(r) : null;
  }
  create(input: { spaceId: string; kind: ItemKind; title: string; refId: string }): Item {
    const max = (this.db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM items WHERE space_id = ?").get(input.spaceId) as { m: number }).m;
    const id = newId(); const t = now();
    this.db.prepare("INSERT INTO items (id, space_id, kind, title, sort_order, pinned, ref_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)")
      .run(id, input.spaceId, input.kind, input.title, max + 1, input.refId, t, t);
    return this.get(id)!;
  }
  update(input: { id: string; title?: string; pinned?: boolean; sortOrder?: number }): Item {
    const cur = this.get(input.id); if (!cur) throw new NotFoundError("item", input.id);
    this.db.prepare("UPDATE items SET title = ?, pinned = ?, sort_order = ?, updated_at = ? WHERE id = ?")
      .run(input.title ?? cur.title, (input.pinned ?? cur.pinned) ? 1 : 0, input.sortOrder ?? cur.sortOrder, now(), input.id);
    return this.get(input.id)!;
  }
  delete(id: string): void {
    if (!this.get(id)) throw new NotFoundError("item", id);
    this.db.prepare("DELETE FROM items WHERE id = ?").run(id);
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run apps/server` — Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(server): profiles/spaces/projects/items stores"
```

---

### Task 7: Server — WebSocket RPC server with method dispatch and broadcast

**Files:**
- Create: `apps/server/src/rpc/server.ts`, `apps/server/src/rpc/server.test.ts`

- [ ] **Step 1: Failing test**

`apps/server/src/rpc/server.test.ts`:
```ts
import { describe, expect, it, afterEach } from "vitest";
import WebSocket from "ws";
import { z } from "zod";
import { RpcServer } from "./server";

let server: RpcServer;
afterEach(async () => { await server?.close(); });

function connect(port: number): Promise<WebSocket> {
  return new Promise((res, rej) => { const ws = new WebSocket(`ws://127.0.0.1:${port}`); ws.once("open", () => res(ws)); ws.once("error", rej); });
}
function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((res) => ws.once("message", (d) => res(JSON.parse(d.toString()))));
}

describe("RpcServer", () => {
  it("dispatches a registered method and validates params", async () => {
    server = new RpcServer();
    server.register("echo", z.object({ text: z.string() }), async (p) => ({ echoed: p.text }));
    const port = await server.listen(0);
    const ws = await connect(port);
    ws.send(JSON.stringify({ id: "1", method: "echo", params: { text: "hi" } }));
    expect(await nextMessage(ws)).toEqual({ id: "1", ok: true, result: { echoed: "hi" } });
    ws.send(JSON.stringify({ id: "2", method: "echo", params: { text: 5 } }));
    const bad = (await nextMessage(ws)) as { ok: boolean; error: { code: string } };
    expect(bad.ok).toBe(false); expect(bad.error.code).toBe("INVALID_PARAMS");
    ws.send(JSON.stringify({ id: "3", method: "nope", params: {} }));
    expect(((await nextMessage(ws)) as { error: { code: string } }).error.code).toBe("METHOD_NOT_FOUND");
    ws.close();
  });

  it("maps thrown errors with a code and broadcasts events to all clients", async () => {
    server = new RpcServer();
    server.register("boom", z.object({}), async () => { throw Object.assign(new Error("nope"), { code: "NOT_FOUND" }); });
    const port = await server.listen(0);
    const a = await connect(port); const b = await connect(port);
    a.send(JSON.stringify({ id: "1", method: "boom", params: {} }));
    expect(((await nextMessage(a)) as { error: { code: string } }).error.code).toBe("NOT_FOUND");
    const pa = nextMessage(a); const pb = nextMessage(b);
    server.broadcast("spaces.changed", { profileId: "x" });
    expect(await pa).toEqual({ event: "spaces.changed", payload: { profileId: "x" } });
    expect(await pb).toEqual({ event: "spaces.changed", payload: { profileId: "x" } });
    a.close(); b.close();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm vitest run apps/server/src/rpc` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`apps/server/src/rpc/server.ts`:
```ts
import { WebSocketServer, WebSocket } from "ws";
import type { ZodTypeAny, z } from "zod";
import { parseWireMessage, type RpcResponse } from "@realm/contracts";

type Handler<S extends ZodTypeAny> = (params: z.infer<S>, ctx: { client: WebSocket }) => Promise<unknown>;

export class RpcServer {
  private wss: WebSocketServer | null = null;
  private methods = new Map<string, { schema: ZodTypeAny; handler: Handler<ZodTypeAny> }>();
  private clients = new Set<WebSocket>();

  register<S extends ZodTypeAny>(name: string, schema: S, handler: Handler<S>): void {
    this.methods.set(name, { schema, handler: handler as Handler<ZodTypeAny> });
  }

  listen(port: number, host = "127.0.0.1"): Promise<number> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port, host });
      this.wss = wss;
      wss.once("error", reject);
      wss.on("listening", () => { const addr = wss.address(); resolve(typeof addr === "object" && addr ? addr.port : port); });
      wss.on("connection", (ws) => {
        this.clients.add(ws);
        ws.on("close", () => this.clients.delete(ws));
        ws.on("message", (data) => void this.handle(ws, data.toString()));
      });
    });
  }

  broadcast(event: string, payload: unknown): void {
    const msg = JSON.stringify({ event, payload });
    for (const c of this.clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
  }

  async close(): Promise<void> {
    for (const c of this.clients) c.terminate();
    this.clients.clear();
    await new Promise<void>((res) => (this.wss ? this.wss.close(() => res()) : res()));
  }

  private async handle(ws: WebSocket, raw: string): Promise<void> {
    let id = "?";
    const send = (r: RpcResponse) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(r));
    try {
      const wire = parseWireMessage(raw);
      if (wire.kind !== "request") return;
      id = wire.msg.id;
      const m = this.methods.get(wire.msg.method);
      if (!m) return send({ id, ok: false, error: { code: "METHOD_NOT_FOUND", message: wire.msg.method } });
      const parsed = m.schema.safeParse(wire.msg.params);
      if (!parsed.success) return send({ id, ok: false, error: { code: "INVALID_PARAMS", message: parsed.error.message } });
      const result = await m.handler(parsed.data, { client: ws });
      send({ id, ok: true, result });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      send({ id, ok: false, error: { code: err.code ?? "INTERNAL", message: err.message ?? String(e) } });
    }
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run apps/server/src/rpc` — Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(server): websocket rpc server with dispatch and broadcast"
```

---

### Task 8: Server — terminal manager (node-pty)

**Files:**
- Create: `apps/server/src/terminals/manager.ts`, `apps/server/src/terminals/manager.test.ts`

- [ ] **Step 1: Failing test**

`apps/server/src/terminals/manager.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { TerminalManager } from "./manager";

describe("TerminalManager", () => {
  it("spawns a shell, streams output, resizes, and closes", async () => {
    const chunks: string[] = []; let exit: number | null = null;
    const tm = new TerminalManager({
      onData: (_id, d) => chunks.push(d),
      onExit: (_id, code) => { exit = code; },
    });
    const id = tm.create({ cwd: process.cwd(), cols: 80, rows: 24, shell: "/bin/sh" });
    tm.write(id, "echo REALM_OK\n");
    await new Promise((r) => setTimeout(r, 400));
    expect(chunks.join("")).toContain("REALM_OK");
    tm.resize(id, 100, 30);
    tm.close(id);
    await new Promise((r) => setTimeout(r, 300));
    expect(exit).not.toBeNull();
    expect(tm.has(id)).toBe(false);
  });
  it("throws NOT_FOUND for unknown terminal", () => {
    const tm = new TerminalManager({ onData: () => {}, onExit: () => {} });
    expect(() => tm.write("nope", "x")).toThrowError(/not found/);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm vitest run apps/server/src/terminals` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`apps/server/src/terminals/manager.ts`:
```ts
import * as pty from "node-pty";
import { newId } from "@realm/contracts";
import { NotFoundError } from "../store/rows";

export type TerminalCallbacks = { onData: (id: string, data: string) => void; onExit: (id: string, exitCode: number) => void };

export class TerminalManager {
  private terms = new Map<string, pty.IPty>();
  constructor(private cb: TerminalCallbacks) {}

  create(opts: { cwd: string; cols: number; rows: number; shell?: string; env?: Record<string, string> }): string {
    const id = newId();
    const shell = opts.shell ?? process.env.SHELL ?? "/bin/zsh";
    const p = pty.spawn(shell, [], {
      name: "xterm-256color", cwd: opts.cwd, cols: opts.cols, rows: opts.rows,
      env: { ...process.env, ...opts.env, TERM_PROGRAM: "Realm" } as Record<string, string>,
    });
    p.onData((d) => this.cb.onData(id, d));
    p.onExit(({ exitCode }) => { this.terms.delete(id); this.cb.onExit(id, exitCode); });
    this.terms.set(id, p);
    return id;
  }
  has(id: string): boolean { return this.terms.has(id); }
  write(id: string, data: string): void { this.get(id).write(data); }
  resize(id: string, cols: number, rows: number): void { this.get(id).resize(Math.max(2, cols), Math.max(1, rows)); }
  close(id: string): void { const p = this.terms.get(id); if (p) { p.kill(); this.terms.delete(id); } }
  closeAll(): void { for (const id of [...this.terms.keys()]) this.close(id); }
  private get(id: string): pty.IPty { const p = this.terms.get(id); if (!p) throw new NotFoundError("terminal", id); return p; }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run apps/server/src/terminals` — Expected: 2 pass. (If node-pty fails to build, run `pnpm rebuild node-pty`.)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(server): node-pty terminal manager"
```

---

### Task 9: Server — register RPC methods and boot entry

**Files:**
- Create: `apps/server/src/rpc/methods.ts`, `apps/server/src/rpc/methods.test.ts`, `apps/server/src/main.ts`, `apps/server/src/app.ts`

- [ ] **Step 1: Failing test**

`apps/server/src/rpc/methods.test.ts`:
```ts
import { describe, expect, it, afterEach } from "vitest";
import WebSocket from "ws";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../app";

let app: App;
afterEach(async () => { await app?.close(); });

async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: any) => void>(); const events: any[] = [];
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); else events.push(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<any>((res) => { const id = String(++n); pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  return { call, events, close: () => ws.close() };
}

describe("rpc methods", () => {
  it("full flow: profile → space → item → layout, with change events", async () => {
    const home = mkdtempSync(join(tmpdir(), "realm-home-"));
    app = await createApp({ home, port: 0 });
    const c = await client(app.port);
    const prof = (await c.call("profiles.create", { name: "Work" })).result;
    expect(prof.icon).toBe("user");
    const space = (await c.call("spaces.create", { profileId: prof.id, name: "Versed" })).result;
    expect(space.folderPath).toContain("versed");
    const item = (await c.call("items.create", { spaceId: space.id, kind: "terminal", title: "zsh", refId: space.id })).result;
    const layout = { type: "leaf", id: "L1", tabs: [item.id], activeTab: item.id };
    const updated = (await c.call("spaces.setLayout", { id: space.id, layout })).result;
    expect(updated.layout).toEqual(layout);
    const listed = (await c.call("spaces.list", { profileId: prof.id })).result;
    expect(listed).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(c.events.map((e) => e.event)).toEqual(expect.arrayContaining(["profiles.changed", "spaces.changed", "items.changed"]));
    const info = (await c.call("system.info", {})).result;
    expect(info.realmHome).toBe(home);
    c.close();
  });

  it("terminals.create makes an item and streams data events", async () => {
    const home = mkdtempSync(join(tmpdir(), "realm-home-"));
    app = await createApp({ home, port: 0 });
    const c = await client(app.port);
    const prof = (await c.call("profiles.create", { name: "W" })).result;
    const space = (await c.call("spaces.create", { profileId: prof.id, name: "S" })).result;
    const { terminalId, itemId } = (await c.call("terminals.create", { spaceId: space.id })).result;
    expect(itemId).toBeTruthy();
    await c.call("terminals.write", { terminalId, data: "echo REALM_RPC_OK\n" });
    await new Promise((r) => setTimeout(r, 500));
    const data = c.events.filter((e) => e.event === "terminal.data").map((e) => e.payload.data).join("");
    expect(data).toContain("REALM_RPC_OK");
    await c.call("terminals.close", { terminalId });
    c.close();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm vitest run apps/server/src/rpc/methods.test.ts` — Expected: FAIL (`../app` missing).

- [ ] **Step 3: Implement**

`apps/server/src/rpc/methods.ts`:
```ts
import { Methods } from "@realm/contracts";
import type { RpcServer } from "./server";
import type { ProfilesStore } from "../store/profiles";
import type { SpacesStore } from "../store/spaces";
import type { ProjectsStore } from "../store/projects";
import type { ItemsStore } from "../store/items";
import type { TerminalManager } from "../terminals/manager";
import type { Db } from "../db/database";
import { newId } from "@realm/contracts";

export type Deps = {
  rpc: RpcServer; db: Db; home: string; version: string;
  profiles: ProfilesStore; spaces: SpacesStore; projects: ProjectsStore; items: ItemsStore; terminals: TerminalManager;
};

export function registerMethods(d: Deps): void {
  const { rpc } = d;
  const reg = <M extends keyof typeof Methods>(name: M, fn: (p: import("zod").infer<(typeof Methods)[M]["params"]>) => Promise<import("zod").infer<(typeof Methods)[M]["result"]>> | import("zod").infer<(typeof Methods)[M]["result"]>) =>
    rpc.register(name, Methods[name].params, async (p) => fn(p as never));

  reg("system.info", () => ({ realmHome: d.home, version: d.version }));

  reg("profiles.list", () => d.profiles.list());
  reg("profiles.create", (p) => { const r = d.profiles.create(p); rpc.broadcast("profiles.changed", {}); return r; });
  reg("profiles.update", (p) => { const r = d.profiles.update(p); rpc.broadcast("profiles.changed", {}); return r; });
  reg("profiles.delete", (p) => { d.profiles.delete(p.id); rpc.broadcast("profiles.changed", {}); return { ok: true as const }; });

  reg("spaces.list", (p) => d.spaces.list(p.profileId));
  reg("spaces.create", (p) => { const r = d.spaces.create(p); rpc.broadcast("spaces.changed", { profileId: r.profileId }); return r; });
  reg("spaces.update", (p) => { const r = d.spaces.update(p); rpc.broadcast("spaces.changed", { profileId: r.profileId }); return r; });
  reg("spaces.setLayout", (p) => { const r = d.spaces.setLayout(p.id, p.layout); rpc.broadcast("spaces.changed", { profileId: r.profileId }); return r; });
  reg("spaces.delete", (p) => { const s = d.spaces.get(p.id); d.spaces.delete(p.id); if (s) rpc.broadcast("spaces.changed", { profileId: s.profileId }); return { ok: true as const }; });

  reg("projects.list", (p) => d.projects.list(p.spaceId));
  reg("projects.create", (p) => { const r = d.projects.create(p); rpc.broadcast("items.changed", { spaceId: r.spaceId }); return r; });
  reg("projects.delete", (p) => { const pr = d.projects.get(p.id); d.projects.delete(p.id); if (pr) rpc.broadcast("items.changed", { spaceId: pr.spaceId }); return { ok: true as const }; });

  reg("items.list", (p) => d.items.list(p.spaceId));
  reg("items.create", (p) => { const r = d.items.create(p); rpc.broadcast("items.changed", { spaceId: r.spaceId }); return r; });
  reg("items.update", (p) => { const r = d.items.update(p); rpc.broadcast("items.changed", { spaceId: r.spaceId }); return r; });
  reg("items.delete", (p) => { const it = d.items.get(p.id); d.items.delete(p.id); if (it) rpc.broadcast("items.changed", { spaceId: it.spaceId }); return { ok: true as const }; });

  reg("terminals.create", (p) => {
    const space = d.spaces.get(p.spaceId); if (!space) throw Object.assign(new Error("space not found"), { code: "NOT_FOUND" });
    const cwd = p.cwd ?? space.folderPath;
    const terminalId = d.terminals.create({ cwd, cols: p.cols, rows: p.rows });
    const t = Date.now();
    d.db.prepare("INSERT INTO terminals (id, space_id, cwd, shell, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(terminalId, p.spaceId, cwd, process.env.SHELL ?? "/bin/zsh", t, t);
    const item = d.items.create({ spaceId: p.spaceId, kind: "terminal", title: "Terminal", refId: terminalId });
    rpc.broadcast("items.changed", { spaceId: p.spaceId });
    return { terminalId, itemId: item.id };
  });
  reg("terminals.write", (p) => { d.terminals.write(p.terminalId, p.data); return { ok: true as const }; });
  reg("terminals.resize", (p) => { d.terminals.resize(p.terminalId, p.cols, p.rows); return { ok: true as const }; });
  reg("terminals.close", (p) => { d.terminals.close(p.terminalId); d.db.prepare("DELETE FROM terminals WHERE id = ?").run(p.terminalId); return { ok: true as const }; });
  void newId;
}
```

`apps/server/src/app.ts`:
```ts
import { openDatabase, type Db } from "./db/database";
import { dbPath } from "./paths";
import { ProfilesStore } from "./store/profiles";
import { SpacesStore } from "./store/spaces";
import { ProjectsStore } from "./store/projects";
import { ItemsStore } from "./store/items";
import { TerminalManager } from "./terminals/manager";
import { RpcServer } from "./rpc/server";
import { registerMethods } from "./rpc/methods";

export type App = { port: number; db: Db; close(): Promise<void> };
export const SERVER_VERSION = "0.0.1";

export async function createApp(opts: { home: string; port: number }): Promise<App> {
  const db = openDatabase(dbPath(opts.home));
  const rpc = new RpcServer();
  const terminals = new TerminalManager({
    onData: (terminalId, data) => rpc.broadcast("terminal.data", { terminalId, data }),
    onExit: (terminalId, exitCode) => rpc.broadcast("terminal.exit", { terminalId, exitCode }),
  });
  registerMethods({
    rpc, db, home: opts.home, version: SERVER_VERSION,
    profiles: new ProfilesStore(db), spaces: new SpacesStore(db, opts.home),
    projects: new ProjectsStore(db), items: new ItemsStore(db), terminals,
  });
  const port = await rpc.listen(opts.port);
  return { port, db, close: async () => { terminals.closeAll(); await rpc.close(); db.close(); } };
}
```

`apps/server/src/main.ts`:
```ts
import { createApp } from "./app";
import { realmHome } from "./paths";

const home = realmHome();
const port = Number(process.env.REALM_PORT ?? 0);
const app = await createApp({ home, port });
// Announce readiness on stdout as a single JSON line; Electron main parses this.
process.stdout.write(JSON.stringify({ type: "ready", port: app.port, home }) + "\n");
const shutdown = async () => { await app.close(); process.exit(0); };
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run apps/server && pnpm --filter @realm/server build && (REALM_HOME=$(mktemp -d) timeout 3 node apps/server/dist/main.js || true)`
Expected: tests pass; build emits `apps/server/dist/main.js`; running prints one line like `{"type":"ready","port":54321,"home":"/var/folders/..."}`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(server): register rpc methods, app factory, main entry"
```

---

### Task 10: Desktop scaffold — Electron main spawns server, renderer WS client

**Files:**
- Create: `apps/desktop/package.json`, `apps/desktop/tsconfig.json`, `apps/desktop/tsconfig.node.json`, `apps/desktop/tsconfig.web.json`, `apps/desktop/electron.vite.config.ts`, `apps/desktop/vitest.config.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/server-process.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/index.html`, `apps/desktop/src/renderer/src/main.tsx`, `apps/desktop/src/renderer/src/App.tsx`, `apps/desktop/src/renderer/src/rpc/client.ts`, `apps/desktop/src/renderer/src/rpc/client.test.ts`, `apps/desktop/src/renderer/src/styles.css`, `apps/desktop/src/renderer/src/env.d.ts`

- [ ] **Step 1: Package + configs**

`apps/desktop/package.json`:
```json
{
  "name": "@realm/desktop",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "preview": "electron-vite preview",
    "typecheck": "tsc -p tsconfig.node.json --noEmit && tsc -p tsconfig.web.json --noEmit"
  },
  "dependencies": {
    "@realm/contracts": "workspace:*",
    "@realm/ui": "workspace:*",
    "@xterm/addon-fit": "^0.10.0",
    "@xterm/xterm": "^5.5.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-resizable-panels": "^3.0.0",
    "zustand": "^5.0.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.6.0",
    "@testing-library/react": "^16.1.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "electron": "^37.0.0",
    "electron-vite": "^3.0.0",
    "jsdom": "^25.0.0",
    "vite": "^6.0.0"
  }
}
```

`apps/desktop/tsconfig.json`:
```json
{ "files": [], "references": [{ "path": "./tsconfig.node.json" }, { "path": "./tsconfig.web.json" }] }
```
`apps/desktop/tsconfig.node.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "composite": true, "types": ["node", "electron-vite/node"] }, "include": ["electron.vite.config.ts", "src/main/**/*", "src/preload/**/*"] }
```
`apps/desktop/tsconfig.web.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "composite": true, "jsx": "react-jsx", "lib": ["ES2022", "DOM", "DOM.Iterable"], "types": ["vite/client", "@testing-library/jest-dom"] }, "include": ["src/renderer/**/*"] }
```

`apps/desktop/electron.vite.config.ts`:
```ts
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  main: {}, preload: {},
  renderer: { plugins: [react()] },
});
```

`apps/desktop/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  test: { name: "desktop", environment: "jsdom", include: ["src/renderer/**/*.test.{ts,tsx}"], setupFiles: ["src/renderer/src/test-setup.ts"] },
});
```

`apps/desktop/src/renderer/src/test-setup.ts`:
```ts
import "@testing-library/jest-dom/vitest";
```

`apps/desktop/src/renderer/src/env.d.ts`:
```ts
/// <reference types="vite/client" />
interface Window { realm: { port: number; home: string } }
```

- [ ] **Step 2: Failing test for the WS client**

`apps/desktop/src/renderer/src/rpc/client.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "./client";

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null; onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null; sent: string[] = []; readyState = 1;
  constructor(public url: string) { FakeSocket.instances.push(this); queueMicrotask(() => this.onopen?.()); }
  send(s: string) { this.sent.push(s); }
  close() { this.onclose?.(); }
}

describe("RpcClient", () => {
  it("sends requests and resolves matching responses; dispatches events", async () => {
    const c = new RpcClient("ws://x", FakeSocket as unknown as typeof WebSocket);
    await c.ready();
    const sock = FakeSocket.instances.at(-1)!;
    const p = c.call("profiles.list", {});
    const req = JSON.parse(sock.sent[0]!);
    expect(req.method).toBe("profiles.list");
    sock.onmessage!({ data: JSON.stringify({ id: req.id, ok: true, result: [] }) });
    expect(await p).toEqual([]);
    const spy = vi.fn(); c.on("terminal.data", spy);
    sock.onmessage!({ data: JSON.stringify({ event: "terminal.data", payload: { terminalId: "t", data: "x" } }) });
    expect(spy).toHaveBeenCalledWith({ terminalId: "t", data: "x" });
  });
  it("rejects on error response", async () => {
    const c = new RpcClient("ws://x", FakeSocket as unknown as typeof WebSocket);
    await c.ready();
    const sock = FakeSocket.instances.at(-1)!;
    const p = c.call("spaces.delete", { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });
    const req = JSON.parse(sock.sent[0]!);
    sock.onmessage!({ data: JSON.stringify({ id: req.id, ok: false, error: { code: "NOT_FOUND", message: "nope" } }) });
    await expect(p).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
```

- [ ] **Step 3: Run to verify fail**

Run: `pnpm install && pnpm vitest run apps/desktop` — Expected: FAIL (`./client` missing).

- [ ] **Step 4: Implement client, main, preload, renderer shell**

`apps/desktop/src/renderer/src/rpc/client.ts`:
```ts
import { parseWireMessage, type MethodName, type MethodParams, type MethodResult, type EventName, type EventPayload } from "@realm/contracts";

type Listener = (payload: unknown) => void;
export class RpcError extends Error { constructor(public code: string, message: string) { super(message); } }

export class RpcClient {
  private ws: WebSocket;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Set<Listener>>();
  private seq = 0;
  private opened: Promise<void>;
  constructor(url: string, Impl: typeof WebSocket = WebSocket) {
    this.ws = new Impl(url);
    this.opened = new Promise((res) => { this.ws.onopen = () => res(); });
    this.ws.onmessage = (e) => this.onMessage(String(e.data));
    this.ws.onclose = () => { for (const p of this.pending.values()) p.reject(new RpcError("DISCONNECTED", "socket closed")); this.pending.clear(); };
  }
  ready(): Promise<void> { return this.opened; }
  async call<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    await this.opened;
    const id = String(++this.seq);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on<E extends EventName>(event: E, fn: (payload: EventPayload<E>) => void): () => void {
    const set = this.listeners.get(event) ?? new Set(); set.add(fn as Listener); this.listeners.set(event, set);
    return () => set.delete(fn as Listener);
  }
  private onMessage(raw: string) {
    const m = parseWireMessage(raw);
    if (m.kind === "response") {
      const p = this.pending.get(m.msg.id); if (!p) return; this.pending.delete(m.msg.id);
      m.msg.ok ? p.resolve(m.msg.result) : p.reject(new RpcError(m.msg.error.code, m.msg.error.message));
    } else if (m.kind === "event") {
      for (const fn of this.listeners.get(m.msg.event) ?? []) fn(m.msg.payload);
    }
  }
}

let singleton: RpcClient | null = null;
export function rpc(): RpcClient {
  if (!singleton) singleton = new RpcClient(`ws://127.0.0.1:${window.realm.port}`);
  return singleton;
}
```

`apps/desktop/src/main/server-process.ts`:
```ts
import { spawn, type ChildProcess } from "node:child_process";
import { app } from "electron";
import { join } from "node:path";
import { existsSync } from "node:fs";

export type ServerInfo = { port: number; home: string };

function serverEntry(): string {
  if (process.env.REALM_SERVER_ENTRY) return process.env.REALM_SERVER_ENTRY;
  const dev = join(app.getAppPath(), "..", "server", "dist", "main.js");
  if (existsSync(dev)) return dev;
  return join(process.resourcesPath, "server", "main.js");
}

export function startServer(): Promise<{ child: ChildProcess; info: ServerInfo }> {
  return new Promise((resolve, reject) => {
    const nodeBin = process.env.REALM_NODE ?? "node";
    const child = spawn(nodeBin, [serverEntry()], { env: { ...process.env }, stdio: ["ignore", "pipe", "inherit"] });
    let buf = "";
    child.stdout!.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      try { const msg = JSON.parse(line); if (msg.type === "ready") resolve({ child, info: { port: msg.port, home: msg.home } }); }
      catch { /* ignore non-JSON */ }
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`realm-server exited early with code ${code}. Is Node >=22.13 on PATH? (set REALM_NODE)`)));
  });
}
```

`apps/desktop/src/main/index.ts`:
```ts
import { app, BrowserWindow, shell } from "electron";
import { join } from "node:path";
import { startServer } from "./server-process";

let serverChild: import("node:child_process").ChildProcess | null = null;

async function createWindow(info: { port: number; home: string }) {
  const win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    titleBarStyle: "hiddenInset", trafficLightPosition: { x: 12, y: 14 },
    webPreferences: { preload: join(__dirname, "../preload/index.js"), contextIsolation: true, sandbox: false,
      additionalArguments: [`--realm-port=${info.port}`, `--realm-home=${info.home}`] },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: "deny" }; });
  if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await win.loadFile(join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(async () => {
  try {
    const { child, info } = await startServer();
    serverChild = child;
    child.on("exit", () => { serverChild = null; });
    await createWindow(info);
  } catch (e) {
    console.error(e);
    app.quit();
  }
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => { serverChild?.kill("SIGTERM"); });
```

`apps/desktop/src/preload/index.ts`:
```ts
import { contextBridge } from "electron";
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? "";
contextBridge.exposeInMainWorld("realm", { port: Number(arg("realm-port")), home: arg("realm-home") });
```

`apps/desktop/src/renderer/index.html`:
```html
<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src ws://127.0.0.1:* http://127.0.0.1:*; img-src 'self' data:; font-src 'self' data:" />
    <title>Realm</title>
  </head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
```

`apps/desktop/src/renderer/src/main.tsx`:
```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
```

`apps/desktop/src/renderer/src/App.tsx` (temporary — replaced in Task 12):
```tsx
import { useEffect, useState } from "react";
import { rpc } from "./rpc/client";
export function App() {
  const [info, setInfo] = useState<string>("connecting…");
  useEffect(() => { rpc().call("system.info", {}).then((i) => setInfo(`realm-server ${i.version} · ${i.realmHome}`)).catch((e) => setInfo(String(e))); }, []);
  return <div style={{ padding: 24, fontFamily: "system-ui" }}>{info}</div>;
}
```

`apps/desktop/src/renderer/src/styles.css`:
```css
:root { --bg: #0f1012; --panel: #17181b; --border: #26282d; --fg: #e6e6e8; --muted: #8b8f98; --accent: #6c8cff; --radius: 8px; }
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; background: var(--bg); color: var(--fg); font: 13px/1.4 -apple-system, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
button { font: inherit; color: inherit; background: none; border: none; cursor: pointer; }
input { font: inherit; }
```

- [ ] **Step 5: Run tests and dev app**

Run: `pnpm vitest run apps/desktop` — Expected: 2 pass.
Run: `pnpm --filter @realm/server build && pnpm --filter @realm/desktop dev` — Expected: an Electron window opens showing `realm-server 0.0.1 · /Users/<you>/Realm`. Quit with Cmd+Q; confirm no orphan `node .../server/dist/main.js` remains (`pgrep -fl "server/dist/main.js"` prints nothing).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(desktop): electron scaffold, spawn realm-server, typed ws client"
```

---

### Task 11: UI package — Hugeicons wrapper

**Files:**
- Create: `packages/ui/package.json`, `packages/ui/tsconfig.json`, `packages/ui/src/index.ts`, `packages/ui/src/Icon.tsx`, `.npmrc` (gitignored, local only), `docs/dev/hugeicons.md`

- [ ] **Step 1: Registry auth (local, not committed)**

Create `.npmrc` at repo root with your Hugeicons Pro token (replace `<TOKEN>`; the file is gitignored):
```
@hugeicons-pro:registry=https://npm.hugeicons.com/
//npm.hugeicons.com/:_authToken=<TOKEN>
```
Document in `docs/dev/hugeicons.md`:
```markdown
# Hugeicons Pro
Icons come from `@hugeicons/react` + `@hugeicons-pro/core-stroke-rounded`.
The Pro registry needs a token: create `.npmrc` at repo root (see `.npmrc.example`), never commit it.
```
And `.npmrc.example` (committed):
```
@hugeicons-pro:registry=https://npm.hugeicons.com/
//npm.hugeicons.com/:_authToken=${HUGEICONS_TOKEN}
```

- [ ] **Step 2: Package**

`packages/ui/package.json`:
```json
{
  "name": "@realm/ui",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": { "typecheck": "tsc -p tsconfig.json --noEmit" },
  "dependencies": { "@hugeicons/react": "^1.0.0", "@hugeicons-pro/core-stroke-rounded": "^1.0.0" },
  "peerDependencies": { "react": "^19.0.0" },
  "devDependencies": { "@types/react": "^19.0.0", "react": "^19.0.0" }
}
```
`packages/ui/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "jsx": "react-jsx", "lib": ["ES2022", "DOM"] }, "include": ["src"] }
```

`packages/ui/src/Icon.tsx`:
```tsx
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon, Cancel01Icon, Folder01Icon, Briefcase01Icon, MortarboardIcon, Home01Icon, UserIcon,
  ComputerTerminal01Icon, GlobeIcon, SmartPhone01Icon, File01Icon, BrainIcon, LayoutGridIcon,
  Settings01Icon, MoreHorizontalIcon, ChatIcon,
} from "@hugeicons-pro/core-stroke-rounded";

export const icons = {
  add: Add01Icon, close: Cancel01Icon, folder: Folder01Icon, briefcase: Briefcase01Icon, cap: MortarboardIcon,
  home: Home01Icon, user: UserIcon, terminal: ComputerTerminal01Icon, browser: GlobeIcon, simulator: SmartPhone01Icon,
  artifact: File01Icon, context: BrainIcon, layout: LayoutGridIcon, settings: Settings01Icon, more: MoreHorizontalIcon,
  session: ChatIcon,
} as const;
export type IconName = keyof typeof icons;

export function Icon({ name, size = 16, className }: { name: IconName | string; size?: number; className?: string }) {
  const icon = (icons as Record<string, (typeof icons)[IconName]>)[name] ?? icons.folder;
  return <HugeiconsIcon icon={icon} size={size} className={className} strokeWidth={1.5} />;
}
```
`packages/ui/src/index.ts`:
```ts
export { Icon, icons, type IconName } from "./Icon";
```

- [ ] **Step 3: Install and typecheck**

Run: `pnpm install && pnpm --filter @realm/ui typecheck`
Expected: no errors. If a named icon export doesn't exist in your installed Hugeicons version, open `node_modules/@hugeicons-pro/core-stroke-rounded/dist/index.d.ts`, pick the closest name, and adjust the import — keep the `icons` keys unchanged.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(ui): hugeicons icon wrapper"
```

---

### Task 12: Desktop — app state store and profile strip + spaces sidebar

**Files:**
- Create: `apps/desktop/src/renderer/src/state/store.ts`, `apps/desktop/src/renderer/src/state/store.test.ts`, `apps/desktop/src/renderer/src/components/ProfileStrip.tsx`, `apps/desktop/src/renderer/src/components/SpacesSidebar.tsx`, `apps/desktop/src/renderer/src/components/Sidebar.tsx`, `apps/desktop/src/renderer/src/components/sidebar.test.tsx`
- Modify: `apps/desktop/src/renderer/src/App.tsx`, `apps/desktop/src/renderer/src/styles.css`

- [ ] **Step 1: Failing store test**

`apps/desktop/src/renderer/src/state/store.test.ts`:
```ts
import { describe, expect, it, beforeEach } from "vitest";
import { createAppStore, type Api } from "./store";
import { emptyLayout, type Profile, type Space, type Item } from "@realm/contracts";

const P = (id: string, name: string): Profile => ({ id, name, icon: "user", color: "#000", sortOrder: 0, createdAt: 0, updatedAt: 0 });
const S = (id: string, profileId: string, name: string): Space => ({ id, profileId, name, icon: "folder", sortOrder: 0, folderPath: "/tmp", layout: null, activeItemId: null, createdAt: 0, updatedAt: 0 });
const I = (id: string, spaceId: string): Item => ({ id, spaceId, kind: "terminal", title: "t", sortOrder: 0, pinned: false, refId: id, createdAt: 0, updatedAt: 0 });

function fakeApi(): Api & { calls: string[] } {
  const calls: string[] = [];
  const profiles = [P("p1", "Work"), P("p2", "School")];
  const spaces: Record<string, Space[]> = { p1: [S("s1", "p1", "Versed")], p2: [] };
  const items: Record<string, Item[]> = { s1: [I("i1", "s1")] };
  return {
    calls,
    listProfiles: async () => { calls.push("listProfiles"); return profiles; },
    listSpaces: async (pid) => { calls.push(`listSpaces:${pid}`); return spaces[pid] ?? []; },
    listItems: async (sid) => { calls.push(`listItems:${sid}`); return items[sid] ?? []; },
    createProfile: async (name) => { const p = P(`p${profiles.length + 1}`, name); profiles.push(p); return p; },
    createSpace: async (pid, name) => { const s = S(`s${Date.now()}`, pid, name); (spaces[pid] ??= []).push(s); return s; },
    setLayout: async (sid, layout) => { calls.push(`setLayout:${sid}`); return { ...S(sid, "p1", "x"), layout }; },
    createTerminal: async (sid) => { const it = I(`i${Date.now()}`, sid); (items[sid] ??= []).push(it); return { terminalId: it.refId, itemId: it.id }; },
    deleteItem: async (id) => { for (const k of Object.keys(items)) items[k] = items[k]!.filter((i) => i.id !== id); },
    closeTerminal: async () => {},
  };
}

describe("app store", () => {
  let api: ReturnType<typeof fakeApi>;
  beforeEach(() => { api = fakeApi(); });

  it("boot loads profiles, selects first, loads its spaces and first space's items", async () => {
    const store = createAppStore(api);
    await store.getState().boot();
    const s = store.getState();
    expect(s.profiles.map((p) => p.name)).toEqual(["Work", "School"]);
    expect(s.activeProfileId).toBe("p1");
    expect(s.spaces.map((x) => x.name)).toEqual(["Versed"]);
    expect(s.activeSpaceId).toBe("s1");
    expect(s.items.map((i) => i.id)).toEqual(["i1"]);
    // a null layout is materialized with all items as tabs
    expect(s.layout?.type).toBe("leaf");
  });

  it("selectProfile switches spaces list", async () => {
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().selectProfile("p2");
    expect(store.getState().spaces).toEqual([]);
    expect(store.getState().activeSpaceId).toBeNull();
  });

  it("newTerminal creates item, adds tab to layout, persists layout", async () => {
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().newTerminal();
    const s = store.getState();
    expect(s.items).toHaveLength(2);
    expect(api.calls.some((c) => c.startsWith("setLayout:s1"))).toBe(true);
    expect(s.layout && s.layout.type === "leaf" ? s.layout.tabs.length : 0).toBe(2);
  });

  it("closeItem removes item and tab", async () => {
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().closeItem("i1");
    expect(store.getState().items).toHaveLength(0);
    expect(store.getState().layout).toEqual(expect.objectContaining({ type: "leaf", tabs: [] }));
  });

  it("applyPreset rebuilds layout and persists", async () => {
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().newTerminal();
    await store.getState().applyPreset("two-col");
    expect(store.getState().layout?.type).toBe("split");
  });

  void emptyLayout;
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm vitest run apps/desktop/src/renderer/src/state` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement store**

`apps/desktop/src/renderer/src/state/store.ts`:
```ts
import { createStore, useStore, type StoreApi } from "zustand";
import {
  addTab, allTabs, emptyLayout, gridPreset, removeTab, setActiveTab, splitLeaf,
  type Item, type Layout, type PresetName, type Profile, type Space,
} from "@realm/contracts";
import { rpc } from "../rpc/client";
import { createContext, useContext } from "react";

export type Api = {
  listProfiles(): Promise<Profile[]>;
  listSpaces(profileId: string): Promise<Space[]>;
  listItems(spaceId: string): Promise<Item[]>;
  createProfile(name: string): Promise<Profile>;
  createSpace(profileId: string, name: string): Promise<Space>;
  setLayout(spaceId: string, layout: Layout): Promise<Space>;
  createTerminal(spaceId: string): Promise<{ terminalId: string; itemId: string }>;
  deleteItem(id: string): Promise<void>;
  closeTerminal(terminalId: string): Promise<void>;
};

export const liveApi = (): Api => ({
  listProfiles: () => rpc().call("profiles.list", {}),
  listSpaces: (profileId) => rpc().call("spaces.list", { profileId }),
  listItems: (spaceId) => rpc().call("items.list", { spaceId }),
  createProfile: (name) => rpc().call("profiles.create", { name }),
  createSpace: (profileId, name) => rpc().call("spaces.create", { profileId, name }),
  setLayout: (id, layout) => rpc().call("spaces.setLayout", { id, layout }),
  createTerminal: (spaceId) => rpc().call("terminals.create", { spaceId }),
  deleteItem: async (id) => { await rpc().call("items.delete", { id }); },
  closeTerminal: async (terminalId) => { await rpc().call("terminals.close", { terminalId }); },
});

export type AppState = {
  profiles: Profile[]; activeProfileId: string | null;
  spaces: Space[]; activeSpaceId: string | null;
  items: Item[]; layout: Layout | null;
  boot(): Promise<void>;
  selectProfile(id: string): Promise<void>;
  selectSpace(id: string): Promise<void>;
  createProfile(name: string): Promise<void>;
  createSpace(name: string): Promise<void>;
  refreshSpaces(): Promise<void>;
  refreshItems(): Promise<void>;
  newTerminal(targetLeafId?: string | null): Promise<void>;
  closeItem(itemId: string): Promise<void>;
  activateTab(itemId: string): Promise<void>;
  splitWithNewTerminal(leafId: string, dir: "row" | "col"): Promise<void>;
  applyPreset(name: PresetName): Promise<void>;
  setLayoutLocal(layout: Layout): void;
  persistLayout(): Promise<void>;
};

/** Ensure every item is present in the layout exactly once and no stale tabs remain. */
export function reconcileLayout(layout: Layout | null, items: Item[]): Layout {
  let l: Layout = layout ?? emptyLayout();
  const ids = new Set(items.map((i) => i.id));
  for (const t of allTabs(l)) if (!ids.has(t)) l = removeTab(l, t);
  const present = new Set(allTabs(l));
  for (const it of items) if (!present.has(it.id)) l = addTab(l, null, it.id);
  return l;
}

export function createAppStore(api: Api): StoreApi<AppState> {
  return createStore<AppState>((set, get) => {
    const persist = async () => { const { activeSpaceId, layout } = get(); if (activeSpaceId && layout) await api.setLayout(activeSpaceId, layout); };
    return {
      profiles: [], activeProfileId: null, spaces: [], activeSpaceId: null, items: [], layout: null,

      async boot() {
        const profiles = await api.listProfiles();
        set({ profiles });
        if (profiles[0]) await get().selectProfile(profiles[0].id);
      },
      async selectProfile(id) {
        set({ activeProfileId: id, activeSpaceId: null, items: [], layout: null });
        await get().refreshSpaces();
        const first = get().spaces[0];
        if (first) await get().selectSpace(first.id);
      },
      async selectSpace(id) {
        const space = get().spaces.find((s) => s.id === id);
        set({ activeSpaceId: id, layout: space?.layout ?? null, items: [] });
        await get().refreshItems();
      },
      async refreshSpaces() {
        const pid = get().activeProfileId; if (!pid) return;
        set({ spaces: await api.listSpaces(pid) });
      },
      async refreshItems() {
        const sid = get().activeSpaceId; if (!sid) return;
        const items = await api.listItems(sid);
        const layout = reconcileLayout(get().layout, items);
        set({ items, layout });
      },
      async createProfile(name) {
        const p = await api.createProfile(name);
        set({ profiles: [...get().profiles, p] });
        await get().selectProfile(p.id);
      },
      async createSpace(name) {
        const pid = get().activeProfileId; if (!pid) return;
        const s = await api.createSpace(pid, name);
        set({ spaces: [...get().spaces, s] });
        await get().selectSpace(s.id);
      },
      async newTerminal(targetLeafId = null) {
        const sid = get().activeSpaceId; if (!sid) return;
        const { itemId } = await api.createTerminal(sid);
        const items = await api.listItems(sid);
        const layout = addTab(get().layout ?? emptyLayout(), targetLeafId, itemId);
        set({ items, layout: reconcileLayout(layout, items) });
        await persist();
      },
      async closeItem(itemId) {
        const it = get().items.find((i) => i.id === itemId);
        if (it?.kind === "terminal") await api.closeTerminal(it.refId);
        await api.deleteItem(itemId);
        const items = get().items.filter((i) => i.id !== itemId);
        set({ items, layout: removeTab(get().layout ?? emptyLayout(), itemId) });
        await persist();
      },
      async activateTab(itemId) {
        set({ layout: setActiveTab(get().layout ?? emptyLayout(), itemId) });
        await persist();
      },
      async splitWithNewTerminal(leafId, dir) {
        const sid = get().activeSpaceId; if (!sid) return;
        const { itemId } = await api.createTerminal(sid);
        const items = await api.listItems(sid);
        set({ items, layout: splitLeaf(get().layout ?? emptyLayout(), leafId, dir, itemId) });
        await persist();
      },
      async applyPreset(name) {
        set({ layout: gridPreset(name, get().items.map((i) => i.id)) });
        await persist();
      },
      setLayoutLocal(layout) { set({ layout }); },
      persistLayout: persist,
    };
  });
}

export const StoreContext = createContext<StoreApi<AppState> | null>(null);
export function useApp<T>(sel: (s: AppState) => T): T {
  const store = useContext(StoreContext); if (!store) throw new Error("StoreContext missing");
  return useStore(store, sel);
}
```

- [ ] **Step 4: Run store tests**

Run: `pnpm vitest run apps/desktop/src/renderer/src/state` — Expected: 5 pass.

- [ ] **Step 5: Failing sidebar component test**

`apps/desktop/src/renderer/src/components/sidebar.test.tsx`:
```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Sidebar } from "./Sidebar";
import { StoreContext, createAppStore, type Api } from "../state/store";

const api: Api = {
  listProfiles: async () => [{ id: "p1", name: "Work", icon: "briefcase", color: "#000", sortOrder: 0, createdAt: 0, updatedAt: 0 },
                              { id: "p2", name: "School", icon: "cap", color: "#000", sortOrder: 1, createdAt: 0, updatedAt: 0 }],
  listSpaces: async (pid) => pid === "p1" ? [{ id: "s1", profileId: "p1", name: "Versed", icon: "folder", sortOrder: 0, folderPath: "/", layout: null, activeItemId: null, createdAt: 0, updatedAt: 0 }] : [],
  listItems: async () => [{ id: "i1", spaceId: "s1", kind: "terminal", title: "Terminal", sortOrder: 0, pinned: false, refId: "t1", createdAt: 0, updatedAt: 0 }],
  createProfile: vi.fn(), createSpace: vi.fn(), setLayout: vi.fn(async (id, layout) => ({ id, layout } as never)),
  createTerminal: vi.fn(), deleteItem: vi.fn(), closeTerminal: vi.fn(),
};

describe("Sidebar", () => {
  it("renders profiles, spaces of the active profile, and items of the active space", async () => {
    const store = createAppStore(api);
    await store.getState().boot();
    render(<StoreContext.Provider value={store}><Sidebar /></StoreContext.Provider>);
    expect(screen.getByRole("button", { name: /Work/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /School/ })).toBeInTheDocument();
    expect(screen.getByText("Versed")).toBeInTheDocument();
    expect(screen.getByText("Terminal")).toBeInTheDocument();
  });
  it("switching profile empties spaces list", async () => {
    const store = createAppStore(api);
    await store.getState().boot();
    render(<StoreContext.Provider value={store}><Sidebar /></StoreContext.Provider>);
    fireEvent.click(screen.getByRole("button", { name: /School/ }));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("Versed")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run to verify fail**

Run: `pnpm vitest run apps/desktop/src/renderer/src/components` — Expected: FAIL (module missing).

- [ ] **Step 7: Implement components**

`apps/desktop/src/renderer/src/components/ProfileStrip.tsx`:
```tsx
import { Icon } from "@realm/ui";
import { useApp } from "../state/store";
import { useState } from "react";

export function ProfileStrip() {
  const profiles = useApp((s) => s.profiles);
  const active = useApp((s) => s.activeProfileId);
  const selectProfile = useApp((s) => s.selectProfile);
  const createProfile = useApp((s) => s.createProfile);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  return (
    <div className="profile-strip">
      {profiles.map((p) => (
        <button key={p.id} className={"profile-dot" + (p.id === active ? " active" : "")} title={p.name} aria-label={p.name}
          style={{ ["--dot" as string]: p.color }} onClick={() => void selectProfile(p.id)}>
          <Icon name={p.icon} size={14} />
        </button>
      ))}
      {adding ? (
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void createProfile(name.trim()); setName(""); setAdding(false); }}>
          <input autoFocus placeholder="Profile name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setAdding(false)} />
        </form>
      ) : (
        <button className="profile-dot ghost" aria-label="Add profile" title="Add profile" onClick={() => setAdding(true)}><Icon name="add" size={14} /></button>
      )}
    </div>
  );
}
```

`apps/desktop/src/renderer/src/components/SpacesSidebar.tsx`:
```tsx
import { Icon } from "@realm/ui";
import { useApp } from "../state/store";
import { useState } from "react";

export function SpacesSidebar() {
  const spaces = useApp((s) => s.spaces);
  const activeSpaceId = useApp((s) => s.activeSpaceId);
  const items = useApp((s) => s.items);
  const layout = useApp((s) => s.layout);
  const selectSpace = useApp((s) => s.selectSpace);
  const createSpace = useApp((s) => s.createSpace);
  const activateTab = useApp((s) => s.activateTab);
  const newTerminal = useApp((s) => s.newTerminal);
  const closeItem = useApp((s) => s.closeItem);
  const [adding, setAdding] = useState(false); const [name, setName] = useState("");
  const activeTabs = new Set(collectActive(layout));
  return (
    <div className="spaces">
      <div className="spaces-header"><span className="label">Spaces</span>
        <button aria-label="New space" title="New space" onClick={() => setAdding(true)}><Icon name="add" size={14} /></button></div>
      {adding && (
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void createSpace(name.trim()); setName(""); setAdding(false); }}>
          <input autoFocus placeholder="Space name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setAdding(false)} />
        </form>
      )}
      {spaces.map((sp) => (
        <div key={sp.id} className={"space" + (sp.id === activeSpaceId ? " active" : "")}>
          <button className="space-row" onClick={() => void selectSpace(sp.id)}><Icon name={sp.icon} size={14} /><span>{sp.name}</span></button>
          {sp.id === activeSpaceId && (
            <div className="items">
              {items.map((it) => (
                <div key={it.id} className={"item" + (activeTabs.has(it.id) ? " active" : "")}>
                  <button className="item-row" onClick={() => void activateTab(it.id)}><Icon name={it.kind} size={13} /><span>{it.title}</span></button>
                  <button className="item-close" aria-label={`Close ${it.title}`} onClick={() => void closeItem(it.id)}><Icon name="close" size={12} /></button>
                </div>
              ))}
              <button className="item-row add" onClick={() => void newTerminal()}><Icon name="add" size={13} /><span>New terminal</span></button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function collectActive(l: import("@realm/contracts").Layout | null): string[] {
  if (!l) return [];
  return l.type === "leaf" ? (l.activeTab ? [l.activeTab] : []) : l.children.flatMap(collectActive);
}
```

`apps/desktop/src/renderer/src/components/Sidebar.tsx`:
```tsx
import { ProfileStrip } from "./ProfileStrip";
import { SpacesSidebar } from "./SpacesSidebar";
export function Sidebar() {
  return <aside className="sidebar"><ProfileStrip /><SpacesSidebar /></aside>;
}
```

Replace `apps/desktop/src/renderer/src/App.tsx`:
```tsx
import { useEffect, useMemo } from "react";
import { Sidebar } from "./components/Sidebar";
import { StoreContext, createAppStore, liveApi } from "./state/store";
import { rpc } from "./rpc/client";

export function App() {
  const store = useMemo(() => createAppStore(liveApi()), []);
  useEffect(() => {
    void store.getState().boot();
    const offS = rpc().on("spaces.changed", () => void store.getState().refreshSpaces());
    const offI = rpc().on("items.changed", ({ spaceId }) => { if (spaceId === store.getState().activeSpaceId) void store.getState().refreshItems(); });
    return () => { offS(); offI(); };
  }, [store]);
  return (
    <StoreContext.Provider value={store}>
      <div className="app"><Sidebar /><main className="main">{/* PaneHost in Task 13 */}</main></div>
    </StoreContext.Provider>
  );
}
```

Append to `styles.css`:
```css
.app { display: flex; height: 100%; }
.sidebar { width: 240px; flex: none; display: flex; flex-direction: column; background: var(--panel); border-right: 1px solid var(--border); padding-top: 38px; -webkit-app-region: drag; }
.sidebar button, .sidebar input { -webkit-app-region: no-drag; }
.profile-strip { display: flex; gap: 6px; padding: 0 12px 10px; border-bottom: 1px solid var(--border); }
.profile-dot { width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; background: color-mix(in srgb, var(--dot, #666) 25%, transparent); color: var(--fg); opacity: .7; }
.profile-dot.active { opacity: 1; outline: 2px solid var(--dot, var(--accent)); }
.profile-dot.ghost { background: transparent; border: 1px dashed var(--border); }
.spaces { flex: 1; overflow: auto; padding: 8px; }
.spaces-header { display: flex; justify-content: space-between; align-items: center; padding: 4px 6px; }
.label { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.space-row, .item-row { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 6px 8px; border-radius: 6px; color: var(--fg); }
.space-row:hover, .item-row:hover { background: rgba(255,255,255,.05); }
.space.active > .space-row { background: rgba(255,255,255,.08); font-weight: 600; }
.items { padding-left: 14px; }
.item { display: flex; align-items: center; }
.item.active .item-row { color: var(--accent); }
.item-close { opacity: 0; padding: 4px; color: var(--muted); }
.item:hover .item-close { opacity: 1; }
.item-row.add { color: var(--muted); }
.inline-form input { width: 100%; padding: 6px 8px; margin: 4px 0; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
```

- [ ] **Step 8: Run tests + dev**

Run: `pnpm vitest run apps/desktop` — Expected: all pass.
Run: `pnpm dev` — Expected: window with sidebar; click "+" in the profile strip, name "Work"; add space "Versed"; both appear; folder `~/Realm/work/versed/` exists on disk.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat(desktop): app store, profile strip, spaces sidebar"
```

---

### Task 13: Desktop — PaneHost (split tree), TabBar, LayoutMenu, placeholder pane

**Files:**
- Create: `apps/desktop/src/renderer/src/components/PaneHost.tsx`, `apps/desktop/src/renderer/src/components/TabBar.tsx`, `apps/desktop/src/renderer/src/components/LayoutMenu.tsx`, `apps/desktop/src/renderer/src/panes/PlaceholderPane.tsx`, `apps/desktop/src/renderer/src/panes/registry.tsx`, `apps/desktop/src/renderer/src/components/panehost.test.tsx`
- Modify: `apps/desktop/src/renderer/src/App.tsx`, `apps/desktop/src/renderer/src/styles.css`

- [ ] **Step 1: Failing test**

`apps/desktop/src/renderer/src/components/panehost.test.tsx`:
```tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PaneHost } from "./PaneHost";
import type { Item, Layout } from "@realm/contracts";

const items: Item[] = [
  { id: "A", spaceId: "s", kind: "browser", title: "Tab A", sortOrder: 0, pinned: false, refId: "A", createdAt: 0, updatedAt: 0 },
  { id: "B", spaceId: "s", kind: "artifact", title: "Tab B", sortOrder: 1, pinned: false, refId: "B", createdAt: 0, updatedAt: 0 },
  { id: "C", spaceId: "s", kind: "context", title: "Tab C", sortOrder: 2, pinned: false, refId: "C", createdAt: 0, updatedAt: 0 },
];

describe("PaneHost", () => {
  it("renders leaves for a nested split and shows active tab content", () => {
    const layout: Layout = { type: "split", id: "root", dir: "row", sizes: [50, 50], children: [
      { type: "leaf", id: "L1", tabs: ["A", "B"], activeTab: "B" },
      { type: "leaf", id: "L2", tabs: ["C"], activeTab: "C" },
    ] };
    render(<PaneHost layout={layout} items={items} onActivate={() => {}} onClose={() => {}} onSplit={() => {}} />);
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByRole("tab", { name: "Tab B" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Tab A" })).toHaveAttribute("aria-selected", "false");
    // placeholder pane content mentions the item kind
    expect(screen.getByText(/artifact pane/i)).toBeInTheDocument();
    expect(screen.getByText(/context pane/i)).toBeInTheDocument();
  });
  it("renders an empty-state for an empty leaf", () => {
    render(<PaneHost layout={{ type: "leaf", id: "L", tabs: [], activeTab: null }} items={[]} onActivate={() => {}} onClose={() => {}} onSplit={() => {}} />);
    expect(screen.getByText(/nothing open/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm vitest run apps/desktop/src/renderer/src/components/panehost.test.tsx` — Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/desktop/src/renderer/src/panes/PlaceholderPane.tsx`:
```tsx
import type { Item } from "@realm/contracts";
export function PlaceholderPane({ item }: { item: Item }) {
  return <div className="pane-placeholder"><div>{item.kind} pane</div><div className="muted">"{item.title}" — coming in a later plan</div></div>;
}
```

`apps/desktop/src/renderer/src/panes/registry.tsx`:
```tsx
import type { Item } from "@realm/contracts";
import type { ComponentType } from "react";
import { PlaceholderPane } from "./PlaceholderPane";

export type PaneProps = { item: Item; visible: boolean };
const registry: Partial<Record<Item["kind"], ComponentType<PaneProps>>> = {};
export function registerPane(kind: Item["kind"], c: ComponentType<PaneProps>) { registry[kind] = c; }
export function PaneFor(props: PaneProps) {
  const C = registry[props.item.kind] ?? PlaceholderPane;
  return <C {...props} />;
}
```

`apps/desktop/src/renderer/src/components/TabBar.tsx`:
```tsx
import { Icon } from "@realm/ui";
import type { Item } from "@realm/contracts";

export function TabBar({ tabs, activeTab, onActivate, onClose, onSplit }: {
  tabs: Item[]; activeTab: string | null;
  onActivate: (id: string) => void; onClose: (id: string) => void; onSplit: (dir: "row" | "col") => void;
}) {
  return (
    <div className="tabbar" role="tablist">
      {tabs.map((t) => (
        <div key={t.id} role="tab" aria-selected={t.id === activeTab} aria-label={t.title}
          className={"tab" + (t.id === activeTab ? " active" : "")} onClick={() => onActivate(t.id)}>
          <Icon name={t.kind} size={13} /><span className="tab-title">{t.title}</span>
          <button className="tab-close" aria-label={`Close ${t.title}`} onClick={(e) => { e.stopPropagation(); onClose(t.id); }}><Icon name="close" size={11} /></button>
        </div>
      ))}
      <div className="tab-actions">
        <button title="Split right (new terminal)" aria-label="Split right" onClick={() => onSplit("row")}>⫽</button>
        <button title="Split down (new terminal)" aria-label="Split down" onClick={() => onSplit("col")}>⩶</button>
      </div>
    </div>
  );
}
```

`apps/desktop/src/renderer/src/components/PaneHost.tsx`:
```tsx
import { Fragment, type JSX } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import type { Item, Layout } from "@realm/contracts";
import { TabBar } from "./TabBar";
import { PaneFor } from "../panes/registry";

export type PaneHostProps = {
  layout: Layout; items: Item[];
  onActivate: (itemId: string) => void; onClose: (itemId: string) => void;
  onSplit: (leafId: string, dir: "row" | "col") => void;
  onResize?: (splitId: string, sizes: number[]) => void;
};

export function PaneHost(p: PaneHostProps) {
  const byId = new Map(p.items.map((i) => [i.id, i]));
  return <div className="panehost">{renderNode(p.layout)}</div>;

  function renderNode(n: Layout): JSX.Element {
    if (n.type === "leaf") {
      const tabs = n.tabs.map((t) => byId.get(t)).filter((x): x is Item => !!x);
      const active = tabs.find((t) => t.id === n.activeTab) ?? tabs[0] ?? null;
      return (
        <div className="leaf" data-leaf-id={n.id}>
          <TabBar tabs={tabs} activeTab={active?.id ?? null} onActivate={p.onActivate} onClose={p.onClose} onSplit={(dir) => p.onSplit(n.id, dir)} />
          <div className="leaf-body">
            {tabs.length === 0 && <div className="pane-placeholder muted">Nothing open — add a terminal from the sidebar or split.</div>}
            {tabs.map((t) => (
              <div key={t.id} className="pane-slot" style={{ display: t.id === active?.id ? "flex" : "none" }}>
                <PaneFor item={t} visible={t.id === active?.id} />
              </div>
            ))}
          </div>
        </div>
      );
    }
    return (
      <PanelGroup direction={n.dir === "row" ? "horizontal" : "vertical"} onLayout={(sizes) => p.onResize?.(n.id, sizes)}>
        {n.children.map((c, i) => (
          <Fragment key={c.id}>
            {i > 0 && <PanelResizeHandle className="resize-handle" />}
            <Panel defaultSize={n.sizes[i] ?? 100 / n.children.length} minSize={10}>{renderNode(c)}</Panel>
          </Fragment>
        ))}
      </PanelGroup>
    );
  }
}
```

`apps/desktop/src/renderer/src/components/LayoutMenu.tsx`:
```tsx
import { PRESETS, type PresetName } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useState } from "react";
const LABELS: Record<PresetName, string> = { one: "1-up", "two-col": "2 columns", "three-col": "3 columns", "grid-2x2": "2×2 grid", "grid-3x3": "3×3 grid" };
export function LayoutMenu({ onPick }: { onPick: (p: PresetName) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="layout-menu">
      <button aria-label="Layout presets" title="Layout presets" onClick={() => setOpen((o) => !o)}><Icon name="layout" size={15} /></button>
      {open && <div className="menu">{PRESETS.map((p) => <button key={p} onClick={() => { onPick(p); setOpen(false); }}>{LABELS[p]}</button>)}</div>}
    </div>
  );
}
```

Update `App.tsx` main area:
```tsx
import { useEffect, useMemo } from "react";
import { Sidebar } from "./components/Sidebar";
import { PaneHost } from "./components/PaneHost";
import { LayoutMenu } from "./components/LayoutMenu";
import { StoreContext, createAppStore, liveApi, useApp } from "./state/store";
import { rpc } from "./rpc/client";
import { emptyLayout } from "@realm/contracts";

function Main() {
  const layout = useApp((s) => s.layout);
  const items = useApp((s) => s.items);
  const spaceId = useApp((s) => s.activeSpaceId);
  const activateTab = useApp((s) => s.activateTab);
  const closeItem = useApp((s) => s.closeItem);
  const split = useApp((s) => s.splitWithNewTerminal);
  const applyPreset = useApp((s) => s.applyPreset);
  const setLayoutLocal = useApp((s) => s.setLayoutLocal);
  const persistLayout = useApp((s) => s.persistLayout);
  if (!spaceId) return <div className="pane-placeholder muted">Create or pick a space.</div>;
  return (
    <>
      <div className="topbar"><LayoutMenu onPick={(p) => void applyPreset(p)} /></div>
      <PaneHost layout={layout ?? emptyLayout()} items={items}
        onActivate={(id) => void activateTab(id)} onClose={(id) => void closeItem(id)}
        onSplit={(leafId, dir) => void split(leafId, dir)}
        onResize={(splitId, sizes) => { const l = layout; if (!l) return; setLayoutLocal(updateSizes(l, splitId, sizes)); void persistLayout(); }} />
    </>
  );
}
function updateSizes(l: import("@realm/contracts").Layout, splitId: string, sizes: number[]): import("@realm/contracts").Layout {
  if (l.type === "leaf") return l;
  return l.id === splitId ? { ...l, sizes } : { ...l, children: l.children.map((c) => updateSizes(c, splitId, sizes)) };
}

export function App() {
  const store = useMemo(() => createAppStore(liveApi()), []);
  useEffect(() => {
    void store.getState().boot();
    const offS = rpc().on("spaces.changed", () => void store.getState().refreshSpaces());
    const offI = rpc().on("items.changed", ({ spaceId }) => { if (spaceId === store.getState().activeSpaceId) void store.getState().refreshItems(); });
    return () => { offS(); offI(); };
  }, [store]);
  return (
    <StoreContext.Provider value={store}>
      <div className="app"><Sidebar /><main className="main"><Main /></main></div>
    </StoreContext.Provider>
  );
}
```

Append to `styles.css`:
```css
.topbar { height: 38px; flex: none; display: flex; align-items: center; justify-content: flex-end; padding: 0 10px; -webkit-app-region: drag; }
.topbar button { -webkit-app-region: no-drag; }
.panehost { flex: 1; min-height: 0; display: flex; }
.panehost > * { flex: 1; min-width: 0; min-height: 0; }
.leaf { display: flex; flex-direction: column; height: 100%; min-width: 0; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; margin: 4px; background: var(--panel); }
.tabbar { display: flex; align-items: center; height: 32px; border-bottom: 1px solid var(--border); overflow-x: auto; }
.tab { display: flex; align-items: center; gap: 6px; padding: 0 10px; height: 100%; color: var(--muted); cursor: default; white-space: nowrap; border-right: 1px solid var(--border); }
.tab.active { color: var(--fg); background: rgba(255,255,255,.04); }
.tab-close { opacity: 0; padding: 2px; } .tab:hover .tab-close { opacity: 1; }
.tab-actions { margin-left: auto; display: flex; gap: 2px; padding: 0 6px; color: var(--muted); }
.leaf-body { flex: 1; min-height: 0; position: relative; display: flex; }
.pane-slot { flex: 1; min-width: 0; min-height: 0; }
.pane-placeholder { flex: 1; display: grid; place-content: center; text-align: center; gap: 4px; color: var(--fg); }
.muted { color: var(--muted); }
.resize-handle { flex: 0 0 4px; background: transparent; } .resize-handle:hover, .resize-handle[data-resize-handle-active] { background: var(--accent); }
.layout-menu { position: relative; }
.menu { position: absolute; right: 0; top: 28px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 4px; display: flex; flex-direction: column; min-width: 140px; z-index: 10; }
.menu button { text-align: left; padding: 6px 10px; border-radius: 6px; } .menu button:hover { background: rgba(255,255,255,.06); }
```

- [ ] **Step 4: Run tests + dev**

Run: `pnpm vitest run apps/desktop && pnpm --filter @realm/desktop typecheck` — Expected: pass.
Run: `pnpm dev` — click "New terminal" twice in the sidebar (placeholder panes appear as tabs), use ⫽ to split, drag the divider, pick "2×2 grid" from the layout menu, quit and relaunch — layout is restored.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(desktop): split-tree pane host, tab bar, layout presets"
```

---

### Task 14: Desktop — Terminal pane (xterm.js) wired to realm-server

**Files:**
- Create: `apps/desktop/src/renderer/src/panes/TerminalPane.tsx`, `apps/desktop/src/renderer/src/panes/terminal-buffer.ts`, `apps/desktop/src/renderer/src/panes/terminal-buffer.test.ts`
- Modify: `apps/desktop/src/renderer/src/panes/registry.tsx` (register), `apps/desktop/src/renderer/src/main.tsx` (import xterm css), `apps/desktop/src/renderer/src/styles.css`

- [ ] **Step 1: Failing test for the data buffer (logic we can unit test without a DOM terminal)**

`apps/desktop/src/renderer/src/panes/terminal-buffer.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { TerminalBuffer } from "./terminal-buffer";

describe("TerminalBuffer", () => {
  it("buffers data until a sink attaches, then flushes and streams", () => {
    const b = new TerminalBuffer();
    b.push("a"); b.push("b");
    const out: string[] = [];
    b.attach((d) => out.push(d));
    expect(out).toEqual(["ab"]);
    b.push("c");
    expect(out).toEqual(["ab", "c"]);
  });
  it("caps retained scrollback to maxChars", () => {
    const b = new TerminalBuffer(5);
    b.push("123456789");
    const out: string[] = []; b.attach((d) => out.push(d));
    expect(out).toEqual(["56789"]);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm vitest run apps/desktop/src/renderer/src/panes` — Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/desktop/src/renderer/src/panes/terminal-buffer.ts`:
```ts
/** Holds pty output that arrives before an xterm instance is mounted (or while a pane is hidden). */
export class TerminalBuffer {
  private pending = ""; private sink: ((d: string) => void) | null = null;
  constructor(private maxChars = 200_000) {}
  push(d: string) {
    if (this.sink) return this.sink(d);
    this.pending += d;
    if (this.pending.length > this.maxChars) this.pending = this.pending.slice(-this.maxChars);
  }
  attach(sink: (d: string) => void) { this.sink = sink; if (this.pending) { sink(this.pending); this.pending = ""; } }
  detach() { this.sink = null; }
}
```

`apps/desktop/src/renderer/src/panes/TerminalPane.tsx`:
```tsx
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { rpc } from "../rpc/client";
import { TerminalBuffer } from "./terminal-buffer";
import type { PaneProps } from "./registry";

const buffers = new Map<string, TerminalBuffer>();
let subscribed = false;
function ensureSubscription() {
  if (subscribed) return; subscribed = true;
  rpc().on("terminal.data", ({ terminalId, data }) => { (buffers.get(terminalId) ?? buffers.set(terminalId, new TerminalBuffer()).get(terminalId)!).push(data); });
  rpc().on("terminal.exit", ({ terminalId, exitCode }) => { buffers.get(terminalId)?.push(`\r\n[process exited with code ${exitCode}]\r\n`); });
}

export function TerminalPane({ item, visible }: PaneProps) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const terminalId = item.refId;

  useEffect(() => {
    ensureSubscription();
    const term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: "ui-monospace, Menlo, monospace", theme: { background: "#17181b" }, allowProposedApi: true });
    const fit = new FitAddon(); term.loadAddon(fit);
    term.open(ref.current!); fit.fit();
    termRef.current = term; fitRef.current = fit;
    const buf = buffers.get(terminalId) ?? buffers.set(terminalId, new TerminalBuffer()).get(terminalId)!;
    buf.attach((d) => term.write(d));
    const onData = term.onData((d) => void rpc().call("terminals.write", { terminalId, data: d }));
    const onResize = term.onResize(({ cols, rows }) => void rpc().call("terminals.resize", { terminalId, cols, rows }));
    const ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* not visible */ } });
    ro.observe(ref.current!);
    void rpc().call("terminals.resize", { terminalId, cols: term.cols, rows: term.rows });
    return () => { ro.disconnect(); onData.dispose(); onResize.dispose(); buf.detach(); term.dispose(); termRef.current = null; };
  }, [terminalId]);

  useEffect(() => { if (visible) { requestAnimationFrame(() => { try { fitRef.current?.fit(); termRef.current?.focus(); } catch { /* ignore */ } }); } }, [visible]);

  return <div className="terminal-pane" ref={ref} />;
}
```

Register it — in `apps/desktop/src/renderer/src/panes/registry.tsx` add at the bottom:
```tsx
import { TerminalPane } from "./TerminalPane";
registerPane("terminal", TerminalPane);
```
(Circular import is safe: `TerminalPane` only imports the `PaneProps` type from registry.)

`main.tsx` — add `import "@xterm/xterm/css/xterm.css";` above `./styles.css`.

Append to `styles.css`:
```css
.terminal-pane { flex: 1; min-width: 0; min-height: 0; padding: 6px; background: #17181b; }
.terminal-pane .xterm { height: 100%; }
```

- [ ] **Step 4: Run tests + dev**

Run: `pnpm vitest run apps/desktop && pnpm --filter @realm/desktop typecheck` — Expected: pass.
Run: `pnpm dev` — "New terminal" opens a live zsh in the space folder (`pwd` prints `~/Realm/<profile>/<space>`); typing works; split → second terminal; resize the divider and the shells reflow; switch spaces and back — terminals still alive with their scrollback.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(desktop): xterm terminal pane wired to realm-server ptys"
```

---

### Task 15: Projects — link a repo to a space (server already supports it; add UI)

**Files:**
- Modify: `apps/desktop/src/renderer/src/state/store.ts` (add projects), `apps/desktop/src/renderer/src/components/SpacesSidebar.tsx`, `apps/desktop/src/renderer/src/state/store.test.ts`
- Modify: `apps/desktop/src/main/index.ts` (folder picker IPC), `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/src/env.d.ts`

- [ ] **Step 1: Failing store test** — append to `store.test.ts` inside `describe("app store")`:
```ts
  it("linkProject adds a project to the active space", async () => {
    const store = createAppStore({ ...api,
      listProjects: async () => [], createProject: async (spaceId, name, rootPath) => ({ id: "pr1", spaceId, name, rootPath, defaultBranch: "main", createdAt: 0, updatedAt: 0 }) });
    await store.getState().boot();
    await store.getState().linkProject("/tmp/versed");
    expect(store.getState().projects.map((p) => p.name)).toEqual(["versed"]);
  });
```
And extend `fakeApi()` with `listProjects: async () => []` and `createProject: async (spaceId, name, rootPath) => ({ id: "pr", spaceId, name, rootPath, defaultBranch: "main", createdAt: 0, updatedAt: 0 })` so existing tests still type-check.

- [ ] **Step 2: Run to verify fail** — `pnpm vitest run apps/desktop/src/renderer/src/state` — Expected: FAIL (`linkProject` missing).

- [ ] **Step 3: Implement**

In `store.ts`: add to `Api`:
```ts
  listProjects(spaceId: string): Promise<Project[]>;
  createProject(spaceId: string, name: string, rootPath: string): Promise<Project>;
```
to `liveApi`:
```ts
  listProjects: (spaceId) => rpc().call("projects.list", { spaceId }),
  createProject: (spaceId, name, rootPath) => rpc().call("projects.create", { spaceId, name, rootPath }),
```
to `AppState`: `projects: Project[]; linkProject(rootPath: string): Promise<void>; refreshProjects(): Promise<void>;`
to the store body: initial `projects: []`; in `selectSpace` after `set(...)`: `await get().refreshProjects();` and:
```ts
      async refreshProjects() { const sid = get().activeSpaceId; if (!sid) return; set({ projects: await api.listProjects(sid) }); },
      async linkProject(rootPath) {
        const sid = get().activeSpaceId; if (!sid) return;
        const name = rootPath.replace(/\/+$/, "").split("/").pop() ?? rootPath;
        await api.createProject(sid, name, rootPath);
        await get().refreshProjects();
      },
```
Import `type Project` from `@realm/contracts`.

Folder picker — `apps/desktop/src/main/index.ts` add:
```ts
import { ipcMain, dialog } from "electron";
ipcMain.handle("pick-folder", async () => {
  const r = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
  return r.canceled ? null : r.filePaths[0] ?? null;
});
```
`preload/index.ts`:
```ts
import { contextBridge, ipcRenderer } from "electron";
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? "";
contextBridge.exposeInMainWorld("realm", {
  port: Number(arg("realm-port")), home: arg("realm-home"),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("pick-folder"),
});
```
`env.d.ts`: `interface Window { realm: { port: number; home: string; pickFolder(): Promise<string | null> } }`

`SpacesSidebar.tsx` — inside the active space's `.items` block, before the items list, add a projects section:
```tsx
              <div className="projects">
                {projects.map((pr) => <div key={pr.id} className="project-row" title={pr.rootPath}><Icon name="folder" size={13} /><span>{pr.name}</span></div>)}
                <button className="item-row add" onClick={() => void (async () => { const p = await window.realm.pickFolder(); if (p) await linkProject(p); })()}>
                  <Icon name="add" size={13} /><span>Link project…</span></button>
              </div>
```
with `const projects = useApp((s) => s.projects); const linkProject = useApp((s) => s.linkProject);`.
CSS: `.projects { padding: 2px 0 6px; } .project-row { display:flex; gap:8px; align-items:center; padding: 4px 8px; color: var(--muted); }`

- [ ] **Step 4: Run tests + dev**

Run: `pnpm vitest run apps/desktop && pnpm --filter @realm/desktop typecheck` — Expected: pass.
Run: `pnpm dev` — "Link project…" opens a folder picker; the folder appears under the space.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(desktop): link projects to a space via folder picker"
```

---

### Task 16: README, dev docs, and end-of-plan verification

**Files:**
- Create: `README.md`, `docs/dev/getting-started.md`

- [ ] **Step 1: Write docs**

`README.md`:
```markdown
# Realm

Local-first agent control plane for macOS — profiles → spaces, split panes for agents / terminals / browser / simulator / artifacts, a context pool, and an MCP gateway. See `docs/superpowers/specs/2026-08-17-realm-v1-design.md`.

## Dev
- Node ≥ 22.13, pnpm 10, macOS.
- Hugeicons Pro token in `.npmrc` (see `.npmrc.example`).
- `pnpm install && pnpm dev`
- Tests: `pnpm test`  ·  Types: `pnpm typecheck`
- Data lives in `~/Realm/` (override with `REALM_HOME`).
```

`docs/dev/getting-started.md`:
```markdown
# Getting started
1. `pnpm install`
2. `pnpm --filter @realm/server build` (desktop dev spawns `apps/server/dist/main.js` with system `node`; set `REALM_NODE` to a specific binary or `REALM_SERVER_ENTRY` to another build)
3. `pnpm dev`
Layout: `apps/desktop` (Electron+React), `apps/server` (realm-server), `packages/contracts` (zod + layout ops), `packages/ui` (Hugeicons).
The renderer talks to realm-server only over WebSocket (`ws://127.0.0.1:<port>`); the port arrives via preload arg `--realm-port`.
```

- [ ] **Step 2: Full verification**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: all green.
Manual: `pnpm dev` → create profiles Work/School, spaces under each, terminals split 2×2, link a project, quit, relaunch: everything restored, `~/Realm/<profile>/<space>/` folders exist.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "docs: readme and getting started"
```

---

## Self-review against the spec (Plan 1 scope only)

- §2 architecture: Electron renderer ↔ realm-server over WS only ✔ (Task 10); server spawned by main ✔; on-disk `~/Realm/realm.db` + `<profile>/<space>/` ✔ (Tasks 5–6). CDP flag, realm-mcp, adapters, context, gateway → Plans 2–7 by design.
- §3 data model: Profile/Space/Project/Item/Terminal/Setting tables ✔; Session/Artifact/Context/Mcp/Skill tables added in their plans' migrations (v2+). Layout tree with leaf ids ✔ (spec's tree gained an `id` per node — recorded here as a refinement).
- §5 terminal ability pane ✔; other panes are placeholders via the pane registry ✔.
- §8: server crash → Electron currently quits on early exit; renderer reconnect/replay lands in Plan 2 with `lastEventSeq`.
- §9 testing: contracts/server/desktop unit tests ✔; Electron smoke test → Plan 8.
- Type consistency check: `Api` methods used in tests match `store.ts`; `Methods` names used in `liveApi` exist in `rpc.ts`; `PaneProps` shape used by `TerminalPane` matches `registry.tsx`.
