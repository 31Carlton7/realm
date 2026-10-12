/**
 * What the hero's working sample of Realm holds: four spaces, six sessions, and what each one has
 * open in the side panel. Every behaviour it acts out is one the shipped app has — Needs you
 * collecting what waits on you from every space, a permission answered from its row, a file link
 * opening at the line it named, sub-agents on two harnesses, a question asked on one card — and the
 * names and models match the captures further down the page, so the sample and the evidence agree.
 */
import type { AgentId } from "@/components/AgentMark"
import type { IconName } from "@/components/home/mini/icons"

export type PanelKind = "document" | "terminal" | "browser" | "agents" | "diff"
export type PanelTab = { id: string; kind: PanelKind; title: string }

export type Waiting =
  | { kind: "permission"; tool: string; command: string }
  | { kind: "question"; question: string; options: string[] }

export type MiniSession = {
  id: string
  space: string
  title: string
  agent: AgentId
  model: string
  /** Before anyone has touched the sample. */
  status: "working" | "waiting" | "done" | "scheduled"
  waiting?: Waiting
  tabs: PanelTab[]
}

export type MiniSpace = { id: string; name: string; icon: IconName; color: string }

export const spaces: MiniSpace[] = [
  { id: "realm", name: "Realm", icon: "folder", color: "oklch(0.72 0.14 290)" },
  { id: "dashboard", name: "Dashboard", icon: "grid", color: "oklch(0.72 0.15 250)" },
  { id: "site", name: "Site", icon: "globe", color: "oklch(0.74 0.15 155)" },
  { id: "school", name: "School", icon: "notebook", color: "oklch(0.8 0.13 85)" },
]

export const sessions: MiniSession[] = [
  {
    id: "dark",
    space: "realm",
    title: "Dark mode",
    agent: "claude",
    model: "Opus 5.5",
    status: "working",
    tabs: [{ id: "dark-agents", kind: "agents", title: "Agents" }],
  },
  {
    id: "crash",
    space: "dashboard",
    title: "Fix the org access crash",
    agent: "claude",
    model: "Opus 5.5",
    status: "done",
    tabs: [
      { id: "crash-doc", kind: "document", title: "orgs.ts" },
      { id: "crash-diff", kind: "diff", title: "Review" },
    ],
  },
  {
    id: "tests",
    space: "dashboard",
    title: "Write tests for the invite flow",
    agent: "openai",
    model: "GPT-6 Luna",
    status: "waiting",
    waiting: { kind: "permission", tool: "Bash", command: "pnpm vitest run web/lib/invites" },
    tabs: [{ id: "tests-term", kind: "terminal", title: "zsh · dashboard" }],
  },
  {
    id: "settings",
    space: "site",
    title: "Pick a look for the settings page",
    agent: "claude",
    model: "Opus 5.5",
    status: "waiting",
    waiting: {
      kind: "question",
      question: "Which layout should the settings page use?",
      options: ["Sections in a sidebar", "One long page", "Tabs across the top"],
    },
    tabs: [{ id: "settings-browser", kind: "browser", title: "localhost:3000" }],
  },
  {
    id: "weekly",
    space: "site",
    title: "Weekly numbers",
    agent: "claude",
    model: "Opus 5.5",
    status: "scheduled",
    tabs: [],
  },
  {
    id: "flash",
    space: "school",
    title: "Flashcards for chapter 4",
    agent: "claude",
    model: "Fable 5.1",
    status: "done",
    tabs: [{ id: "flash-doc", kind: "document", title: "chapter-4.md" }],
  },
]

/** The file the crash fix named, as the Documents pane shows it, from line 70. */
export const orgsTs = [
  "/** What a member list shows beside a name. */",
  "export function roleLabel(role: Role) {",
  '  return role === "owner" ? "Owner" : role === "admin" ? "Admin" : "Member";',
  "}",
  "",
  "export async function canAccessProject(orgId: string, userId: string) {",
  "  const membership = await getOrgMembership(orgId, userId);",
  '  return membership !== null && hasRole(membership.role, "viewer");',
  "}",
  "",
  "export async function getOrgMembership(orgId: string, userId: string) {",
  "  // Only the stable columns access checks read. The invite metadata",
  "  // drifts between environments, and selecting it is what crashed.",
  "  const rows = await db",
  "    .select({",
  "      id: organizationMember.id,",
  "      organizationId: organizationMember.organizationId,",
  "      userId: organizationMember.userId,",
  "      role: organizationMember.role,",
  "    })",
  "    .from(organizationMember)",
  "    .where(and(eq(organizationMember.organizationId, orgId), eq(organizationMember.userId, userId)));",
  "  for (const row of rows) withInviteDefaults(row);",
  "  return rows[0] ?? null;",
  "}",
]
export const ORGS_FIRST_LINE = 70
/** The line the agent's answer links to. */
export const ORGS_NAMED_LINE = 82

export const chapter4 = [
  "# Chapter 4 · Thermodynamics",
  "",
  "**Q** What does the first law conserve?",
  "**A** Energy: ΔU = Q − W.",
  "",
  "**Q** When is a process adiabatic?",
  "**A** When no heat crosses the boundary (Q = 0).",
  "",
  "**Q** What does entropy measure?",
  "**A** How many microstates fit the macrostate.",
  "",
  "**Q** Which cycle is the most efficient between two reservoirs?",
  "**A** The Carnot cycle: η = 1 − Tc / Th.",
]

export const weeklyBars = [
  { label: "Mon", value: 42 },
  { label: "Tue", value: 58 },
  { label: "Wed", value: 51 },
  { label: "Thu", value: 77 },
  { label: "Fri", value: 69 },
  { label: "Sat", value: 31 },
  { label: "Sun", value: 26 },
]
