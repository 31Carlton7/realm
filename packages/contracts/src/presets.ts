export const SPACE_COLORS = ["#7c6cff", "#3ddc97", "#ffb454", "#ff6b8b", "#4cc9f0", "#f4a261", "#a3e635", "#c084fc", "#38bdf8", "#fb7185"] as const;
export const SPACE_ICONS = ["briefcase", "cap", "home", "folder", "terminal", "browser", "session", "artifact", "context", "layout"] as const;
export const pickSpaceColor = (i: number): string => SPACE_COLORS[i % SPACE_COLORS.length]!;

export const AGENT_MODELS = {
  claude: [{ id: "claude-fable-5", label: "Claude Fable 5" }, { id: "claude-opus-5", label: "Claude Opus 5" }, { id: "claude-sonnet-5", label: "Claude Sonnet 5" }, { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" }],
  codex: [], "acp:gemini": [], "acp:cursor": [], fake: [{ id: "fake", label: "Fake" }],
} as const;
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
/**
 * Agent kinds a user can pick — the palette's one-shot entries and the prompter's agent chip.
 *
 * `acp:gemini` is out because Google discontinued the free personal tier (see AGENT_LOGIN_HINTS): the
 * kind stays registered so existing sessions keep working, but offering it is offering a dead end.
 * `fake` is the scripted dev adapter. Callers that must show a session's *current* kind prepend it when
 * it is missing here rather than hiding the agent the session actually runs.
 */
export const SELECTABLE_AGENT_KINDS = ["claude", "codex", "acp:cursor"] as const satisfies ReadonlyArray<import("./entities").AgentKind>;
/** Frontier default model label per kind — what the prompter's model chip shows while `session.model`
 *  is null (the adapter's own default). Display-only: never transmitted as a model id. */
export const DEFAULT_MODEL_LABEL = {
  claude: "Fable 5", codex: "GPT-5.6", "acp:cursor": "Composer", "acp:gemini": "Gemini", fake: "Fake",
} as const satisfies Record<import("./entities").AgentKind, string>;
/**
 * Agent kinds whose permission model Realm can actually control.
 *
 * ACP mode ids are agent-defined (Cursor uses `agent`/`plan`/`ask`), so Realm's own Claude-derived ids are
 * never transmitted: `AcpAdapter.start()` does not read `permissionMode` at all, and `session/set_mode` with a
 * foreign id is rejected. Offering the picker there would be a lie about what the agent is allowed to do.
 *
 * Follow-up (not in this change): read the `modes.availableModes` that `session/new` returns and map Realm's
 * modes onto them, then flip the ACP kinds to `true`.
 */
export const AGENT_SUPPORTS_PERMISSION_MODES = {
  claude: true, codex: true, "acp:cursor": false, "acp:gemini": false, fake: true,
} as const satisfies Record<import("./entities").AgentKind, boolean>;

export const PERMISSION_MODES = [{ id: "default", label: "Ask" }, { id: "acceptEdits", label: "Accept edits" }, { id: "plan", label: "Plan" }, { id: "bypassPermissions", label: "Full access" }] as const;

/**
 * Display metadata per agent kind (icon names come from @realm/ui's icon set).
 *
 * Every real agent names its *provider's* brand mark, so the prompter's model chip reads the way the
 * user's other tools do — the vendor's own glyph next to the model. `fake` keeps a generic Hugeicons
 * glyph because it is the scripted dev adapter and has no vendor to stand for.
 */
export const AGENT_META = {
  claude: { label: "Claude", icon: "claude" }, codex: { label: "Codex", icon: "openai" }, "acp:gemini": { label: "Gemini", icon: "gemini" },
  "acp:cursor": { label: "Cursor", icon: "cursor" }, fake: { label: "Fake agent", icon: "bot" },
} as const satisfies Record<import("./entities").AgentKind, { label: string; icon: string }>;

/**
 * The two commands that can make an agent usable: `install` puts its CLI on the machine, `login` signs it
 * in. Rendered verbatim by the install card and pre-typed (never executed) into the session's terminal.
 *
 * They are deliberately NOT interchangeable — a missing CLI and a signed-out CLI are different problems,
 * and running the wrong one gets the user nowhere.
 *
 * `null` means "there is no single command for this": `fake` is compiled in, and Gemini needs an API key or
 * Vertex credentials rather than a login command (see AGENT_LOGIN_HINTS). Callers show the reason alone.
 */
export const AGENT_CLI_COMMANDS = {
  claude: { install: "npm install -g @anthropic-ai/claude-code", login: "claude auth login" },
  codex: { install: "npm install -g @openai/codex", login: "codex login" },
  "acp:cursor": { install: "curl https://cursor.com/install -fsS | bash", login: "cursor-agent login" },
  "acp:gemini": { install: "npm install -g @google/gemini-cli", login: null },
  fake: { install: null, login: null },
} as const satisfies Record<import("./entities").AgentKind, { install: string | null; login: string | null }>;

/** Shown under the agent picker so a signed-out agent tells the user exactly which command to run. */
export const AGENT_LOGIN_HINTS = {
  claude: "Uses your `claude` login — run `claude auth login` if sessions fail to authenticate.",
  codex: "Uses your `codex` login — run `codex login` if sessions fail to authenticate.",
  "acp:cursor": "Uses your Cursor login — run `cursor-agent login` if sessions fail to authenticate.",
  "acp:gemini": "Google discontinued the free personal tier for the Gemini CLI; sessions need a Gemini API key or Vertex AI credentials.",
  fake: "Scripted offline agent used for development.",
} as const satisfies Record<import("./entities").AgentKind, string>;
