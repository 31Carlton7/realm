export const SPACE_COLORS = ["#7c6cff", "#3ddc97", "#ffb454", "#ff6b8b", "#4cc9f0", "#f4a261", "#a3e635", "#c084fc", "#38bdf8", "#fb7185"] as const;
export const SPACE_ICONS = ["briefcase", "cap", "home", "folder", "terminal", "browser", "session", "artifact", "context", "layout"] as const;
export const pickSpaceColor = (i: number): string => SPACE_COLORS[i % SPACE_COLORS.length]!;

export const AGENT_MODELS = {
  claude: [{ id: "claude-opus-5", label: "Claude Opus 5" }, { id: "claude-sonnet-5", label: "Claude Sonnet 5" }, { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" }],
  codex: [], "acp:gemini": [], "acp:cursor": [], fake: [{ id: "fake", label: "Fake" }],
} as const;
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export const PERMISSION_MODES = [{ id: "default", label: "Ask" }, { id: "acceptEdits", label: "Accept edits" }, { id: "plan", label: "Plan" }, { id: "bypassPermissions", label: "Full access" }] as const;

/** Display metadata per agent kind (icon names come from @realm/ui's icon set). */
export const AGENT_META = {
  claude: { label: "Claude", icon: "sparkles" }, codex: { label: "Codex", icon: "bot" }, "acp:gemini": { label: "Gemini", icon: "bot" },
  "acp:cursor": { label: "Cursor", icon: "bot" }, fake: { label: "Fake agent", icon: "bot" },
} as const satisfies Record<import("./entities").AgentKind, { label: string; icon: string }>;
