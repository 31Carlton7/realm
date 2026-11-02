import type { CreateTeammateInput, ReorderTeammatesInput, Teammate, TeammateTaskSession, UpdateTeammateInput } from "@realm/contracts";

/** The teammate calls the renderer makes (`teammates.*`, contracts/rpc.ts). */
export type TeammatesApi = {
  teammates(spaceId: string): Promise<Teammate[]>;
  teammateCreate(input: CreateTeammateInput): Promise<Teammate>;
  teammateUpdate(input: UpdateTeammateInput): Promise<Teammate>;
  teammateArchive(id: string, archived: boolean): Promise<Teammate>;
  teammateSetLead(spaceId: string, id: string | null): Promise<Teammate[]>;
  teammatesReorder(input: ReorderTeammatesInput): Promise<Teammate[]>;
  teammateHome(id: string): Promise<{ sessionId: string }>;
  teammateSessions(id: string): Promise<TeammateTaskSession[]>;
};

/**
 * What the window holds about teammates. `teammates` is every space's Team list, read at boot and
 * again for a space whenever the server says `teammates.changed` — the sidebar, the teammate page's
 * head and the `@` list all read it. A teammate's full list of sessions is held only once its
 * computer has shown it, and re-read on the same event.
 */
export type TeammatesSlice = {
  /** By space, in the Team list's order (the Lead first), archived ones left out. */
  teammates: Record<string, Teammate[]>;
  /** By teammate: every session it started and the ones handed on from them, newest first. */
  teammateSessions: Record<string, TeammateTaskSession[]>;
  /** The sidebar's teammate groups folded shut, as `<spaceId>/<group>` (`ui.sidebarTeamGroupsFolded`). */
  teamGroupsFolded: string[];

  /** One space's teammates again, or every space's, and the sessions held for them. */
  refreshTeammates(spaceId?: string): Promise<void>;
  createTeammate(input: CreateTeammateInput): Promise<Teammate>;
  updateTeammate(input: UpdateTeammateInput): Promise<Teammate>;
  archiveTeammate(teammate: Teammate, archived?: boolean): Promise<void>;
  /** Makes `id` the space's Lead, or leaves the space with none. */
  setTeamLead(spaceId: string, id: string | null): Promise<void>;
  reorderTeammates(input: ReorderTeammatesInput): Promise<void>;
  loadTeammateSessions(id: string): Promise<void>;
  hydrateTeamGroupFolds(): Promise<void>;
  setTeamGroupFolded(spaceId: string, group: string, folded: boolean): Promise<void>;
};

type Host = TeammatesSlice & { spaces: readonly { id: string }[] };

/** Where a teammate sits in its space's list: the Lead first, then the person's order. */
const ordered = (list: Teammate[]): Teammate[] =>
  [...list].sort((a, b) => Number(b.lead) - Number(a.lead) || a.sortOrder - b.sortOrder);

export const groupKey = (spaceId: string, group: string) => `${spaceId}/${group}`;

export function teammatesSlice<S extends Host>(
  api: TeammatesApi & { getSetting(key: string): Promise<unknown>; setSetting(key: string, value: unknown): Promise<void> },
  get: () => S,
  set: (partial: Partial<TeammatesSlice>) => void,
): TeammatesSlice {
  const putSpace = (spaceId: string, list: Teammate[]) =>
    set({ teammates: { ...get().teammates, [spaceId]: ordered(list.filter((t) => !t.archived)) } });
  return {
    teammates: {}, teammateSessions: {}, teamGroupsFolded: [],

    async refreshTeammates(spaceId) {
      const ids = spaceId ? [spaceId] : get().spaces.map((s) => s.id);
      await Promise.all(ids.map(async (id) => putSpace(id, await api.teammates(id))));
      const held = Object.keys(get().teammateSessions)
        .filter((tid) => ids.some((id) => get().teammates[id]?.some((t) => t.id === tid)));
      await Promise.all(held.map((tid) => get().loadTeammateSessions(tid).catch(() => undefined)));
    },
    async createTeammate(input) {
      const made = await api.teammateCreate(input);
      await get().refreshTeammates(input.spaceId);
      return made;
    },
    async updateTeammate(input) {
      const t = await api.teammateUpdate(input);
      await get().refreshTeammates(t.spaceId);
      return t;
    },
    async archiveTeammate(teammate, archived = true) {
      await api.teammateArchive(teammate.id, archived);
      await get().refreshTeammates(teammate.spaceId);
    },
    async setTeamLead(spaceId, id) { putSpace(spaceId, await api.teammateSetLead(spaceId, id)); },
    async reorderTeammates(input) { putSpace(input.spaceId, await api.teammatesReorder(input)); },
    async loadTeammateSessions(id) {
      set({ teammateSessions: { ...get().teammateSessions, [id]: await api.teammateSessions(id) } });
    },
    async hydrateTeamGroupFolds() {
      const v = await api.getSetting("ui.sidebarTeamGroupsFolded");
      set({ teamGroupsFolded: Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [] });
    },
    async setTeamGroupFolded(spaceId, group, folded) {
      const key = groupKey(spaceId, group);
      const known = new Set(get().spaces.map((s) => s.id));
      const kept = get().teamGroupsFolded.filter((k) => k !== key && known.has(k.slice(0, k.indexOf("/"))));
      const next = folded ? [...kept, key] : kept;
      set({ teamGroupsFolded: next });
      await api.setSetting("ui.sidebarTeamGroupsFolded", next);
    },
  };
}

/** The teammate a session is the chat of, if it is one. */
export function teammateOfHome(teammates: Record<string, Teammate[]>, sessionId: string, spaceId?: string): Teammate | null {
  const lists = spaceId ? [teammates[spaceId] ?? []] : Object.values(teammates);
  for (const list of lists) for (const t of list) if (t.homeSessionId === sessionId) return t;
  return null;
}

/** The first line of what a teammate does, for the one line under its name. */
export function roleLine(brief: string): string {
  return brief.split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean) ?? "";
}
