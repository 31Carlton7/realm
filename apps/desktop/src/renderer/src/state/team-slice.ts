import type {
  CreateRoleInput, CustomRoleInput, RoleRun, Run, TeamActivity, TeamRecord, TeamRecordSummary, TeamReviewDetail, TeamReviewSummary, TeamRole, TeamSpace, UpdateRoleInput,
} from "@realm/contracts";

/** What making a team, or adding to one, can carry besides the starters: the person's own teammates,
 *  the folder they chose for its memory, and the team's week raised to fit. */
export type TeamMakeOptions = { roles?: CustomRoleInput[]; repoPath?: string; weekBudgetUsd?: number };

/** The team calls the renderer makes (`team.*`, contracts/rpc.ts). */
export type TeamApi = {
  teamOverview(): Promise<TeamSpace[]>;
  teamSpace(spaceId: string): Promise<TeamSpace>;
  teamMake(spaceId: string, templates: string[], o?: TeamMakeOptions): Promise<TeamSpace>;
  teamRoleCreate(input: CreateRoleInput): Promise<TeamRole>;
  teamRoleUpdate(input: UpdateRoleInput): Promise<TeamRole>;
  teamRoleArchive(id: string): Promise<void>;
  teamRoleRun(id: string, message: string | null): Promise<Run>;
  teamRoleRuns(id: string): Promise<RoleRun[]>;
  teamReview(id: string): Promise<TeamReviewDetail>;
  teamReviewDecide(id: string, decision: "approve" | "done" | "dismiss"): Promise<TeamReviewSummary>;
  teamReviewRequestChanges(id: string, note: string): Promise<TeamReviewSummary>;
  teamRecords(spaceId: string): Promise<TeamRecordSummary[]>;
  teamRecord(spaceId: string, path: string): Promise<TeamRecord>;
  teamRecordWrite(spaceId: string, path: string, markdown: string): Promise<TeamRecord>;
  teamRecordCreate(spaceId: string, name: string): Promise<TeamRecord>;
  teamActivity(spaceId: string, limit: number): Promise<TeamActivity[]>;
};

/**
 * What the window holds about teams. `teams` is every team space's snapshot, read once at boot and
 * again for a space whenever the server says `team.changed`: the sidebar's Review row, Team fold and
 * Needs you rows read it, and so do the pages. Everything else — a review's detail, a role's runs,
 * the records, the log — is held only once something has shown it, and re-read on the same event.
 */
export type TeamSlice = {
  teams: Record<string, TeamSpace>;
  teamReviewDetail: Record<string, TeamReviewDetail>;
  /** The review the Review pane is reading, per space. */
  teamReviewSelected: Record<string, string>;
  teamRoleRuns: Record<string, RoleRun[]>;
  teamRecords: Record<string, TeamRecordSummary[]>;
  teamActivity: Record<string, TeamActivity[]>;
  /** Spaces whose Team row is folded shut (`ui.sidebarTeamFolded`). Open unless listed. */
  sidebarTeamFolded: string[];

  refreshTeams(): Promise<void>;
  /** One space's team again, and whatever detail of it the window is holding. */
  refreshTeam(spaceId: string): Promise<void>;
  makeTeam(spaceId: string, templates: string[], o?: TeamMakeOptions): Promise<TeamSpace>;
  /** A space's team as the server sees it, team or not, held nowhere — what making a team reads to
   *  learn whether the space already keeps creator records. */
  peekTeam(spaceId: string): Promise<TeamSpace>;
  createRole(input: CreateRoleInput): Promise<TeamRole>;
  updateRole(input: UpdateRoleInput): Promise<TeamRole>;
  archiveRole(id: string, spaceId: string): Promise<void>;
  runRole(id: string, message: string | null): Promise<Run>;
  loadRoleRuns(roleId: string): Promise<void>;
  loadTeamReview(id: string): Promise<TeamReviewDetail>;
  selectTeamReview(spaceId: string, id: string): void;
  decideTeamReview(id: string, decision: "approve" | "done" | "dismiss"): Promise<void>;
  requestTeamReviewChanges(id: string, note: string): Promise<void>;
  loadTeamRecords(spaceId: string): Promise<void>;
  fetchTeamRecord(spaceId: string, path: string): Promise<TeamRecord>;
  writeTeamRecord(spaceId: string, path: string, markdown: string): Promise<TeamRecord>;
  createTeamRecord(spaceId: string, name: string): Promise<TeamRecord>;
  loadTeamActivity(spaceId: string): Promise<void>;
  hydrateTeamFolds(): Promise<void>;
  setTeamFolded(spaceId: string, folded: boolean): Promise<void>;
};

type Host = {
  teams: Record<string, TeamSpace>;
  teamReviewDetail: Record<string, TeamReviewDetail>;
  teamReviewSelected: Record<string, string>;
  teamRoleRuns: Record<string, RoleRun[]>;
  teamRecords: Record<string, TeamRecordSummary[]>;
  teamActivity: Record<string, TeamActivity[]>;
  sidebarTeamFolded: string[];
  spaces: readonly { id: string }[];
};

export const TEAM_ACTIVITY_PAGE = 100;

export function teamSlice<S extends Host & TeamSlice>(
  api: TeamApi & { getSetting(key: string): Promise<unknown>; setSetting(key: string, value: unknown): Promise<void> },
  get: () => S,
  set: (partial: Partial<TeamSlice>) => void,
): TeamSlice {
  const put = <K extends keyof TeamSlice>(key: K, id: string, value: TeamSlice[K] extends Record<string, infer V> ? V : never) =>
    set({ [key]: { ...(get()[key] as object), [id]: value } } as Partial<TeamSlice>);
  return {
    teams: {}, teamReviewDetail: {}, teamReviewSelected: {}, teamRoleRuns: {}, teamRecords: {}, teamActivity: {}, sidebarTeamFolded: [],

    async refreshTeams() {
      const all = await api.teamOverview();
      set({ teams: Object.fromEntries(all.map((t) => [t.spaceId, t])) });
    },
    async refreshTeam(spaceId) {
      const team = await api.teamSpace(spaceId);
      if (team.enabled || get().teams[spaceId]) put("teams", spaceId, team);
      const s = get();
      // The detail that is on screen somewhere, re-read; nothing nobody is looking at.
      const held = [
        ...Object.values(s.teamReviewDetail).filter((r) => r.spaceId === spaceId).map((r) => s.loadTeamReview(r.id)),
        ...team.roles.filter((r) => s.teamRoleRuns[r.id]).map((r) => s.loadRoleRuns(r.id)),
        ...(s.teamRecords[spaceId] ? [s.loadTeamRecords(spaceId)] : []),
        ...(s.teamActivity[spaceId] ? [s.loadTeamActivity(spaceId)] : []),
      ];
      await Promise.all(held.map((p) => p.catch(() => undefined)));
    },
    async makeTeam(spaceId, templates, o) {
      const team = await api.teamMake(spaceId, templates, o);
      put("teams", spaceId, team);
      return team;
    },
    peekTeam: (spaceId) => api.teamSpace(spaceId),
    async createRole(input) {
      const role = await api.teamRoleCreate(input);
      await get().refreshTeam(input.spaceId);
      return role;
    },
    async updateRole(input) {
      const role = await api.teamRoleUpdate(input);
      await get().refreshTeam(role.spaceId);
      return role;
    },
    async archiveRole(id, spaceId) {
      await api.teamRoleArchive(id);
      await get().refreshTeam(spaceId);
    },
    async runRole(id, message) {
      const run = await api.teamRoleRun(id, message);
      await Promise.all([get().refreshTeam(run.spaceId), get().loadRoleRuns(id)]);
      return run;
    },
    async loadRoleRuns(roleId) { put("teamRoleRuns", roleId, await api.teamRoleRuns(roleId)); },
    async loadTeamReview(id) {
      const detail = await api.teamReview(id);
      put("teamReviewDetail", id, detail);
      return detail;
    },
    selectTeamReview(spaceId, id) { put("teamReviewSelected", spaceId, id); },
    async decideTeamReview(id, decision) {
      const r = await api.teamReviewDecide(id, decision);
      await Promise.all([get().loadTeamReview(id), get().refreshTeam(r.spaceId)]);
    },
    async requestTeamReviewChanges(id, note) {
      const r = await api.teamReviewRequestChanges(id, note);
      await Promise.all([get().loadTeamReview(id), get().refreshTeam(r.spaceId)]);
    },
    async loadTeamRecords(spaceId) { put("teamRecords", spaceId, await api.teamRecords(spaceId)); },
    fetchTeamRecord: (spaceId, path) => api.teamRecord(spaceId, path),
    async writeTeamRecord(spaceId, path, markdown) {
      const rec = await api.teamRecordWrite(spaceId, path, markdown);
      await get().loadTeamRecords(spaceId);
      return rec;
    },
    async createTeamRecord(spaceId, name) {
      const rec = await api.teamRecordCreate(spaceId, name);
      await get().loadTeamRecords(spaceId);
      return rec;
    },
    async loadTeamActivity(spaceId) { put("teamActivity", spaceId, await api.teamActivity(spaceId, TEAM_ACTIVITY_PAGE)); },
    async hydrateTeamFolds() {
      const v = await api.getSetting("ui.sidebarTeamFolded");
      set({ sidebarTeamFolded: Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [] });
    },
    async setTeamFolded(spaceId, folded) {
      const known = new Set(get().spaces.map((s) => s.id));
      const kept = get().sidebarTeamFolded.filter((id) => id !== spaceId && known.has(id));
      const next = folded ? [...kept, spaceId] : kept;
      set({ sidebarTeamFolded: next });
      await api.setSetting("ui.sidebarTeamFolded", next);
    },
  };
}
