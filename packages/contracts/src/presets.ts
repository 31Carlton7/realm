export const SPACE_COLORS = ["#7c6cff", "#3ddc97", "#ffb454", "#ff6b8b", "#4cc9f0", "#f4a261", "#a3e635", "#c084fc", "#38bdf8", "#fb7185"] as const;
export const SPACE_ICONS = ["briefcase", "cap", "home", "folder", "terminal", "browser", "session", "artifact", "context", "layout"] as const;
export const pickSpaceColor = (i: number): string => SPACE_COLORS[i % SPACE_COLORS.length]!;

/** One pickable model: the id the wire transmits and the name the row shows. */
export type AgentModel = { id: string; label: string };

/**
 * STATIC fallback model lists — what the picker shows for a kind when no probe has answered yet
 * (`agents.probe` results carry `models`, the live catalog, which wins whenever present).
 *
 * The asymmetry is deliberate, not an accident of neglect:
 *
 *  - **claude** is a curated list that stays hardcoded because no enumeration channel exists — the
 *    Claude Code CLI has no `--list-models`, and the Agent SDK takes a model id on faith. Curation is
 *    the honest option left; keep it in step with the CLI's own picker.
 *  - **codex** and **acp:cursor** are empty ON PURPOSE: their real catalogs are enumerated live by the
 *    probe (Codex over app-server `model/list`, Cursor from ACP `session/new`'s `availableModels`), so
 *    a hardcoded list here would only ever be a stale copy that shadows the truth. Empty means the
 *    picker falls back to the single DEFAULT_MODEL_LABEL row until a probe has answered.
 *  - **acp:gemini** is empty because the kind is no longer offered (see SELECTABLE_AGENT_KINDS).
 */
export const AGENT_MODELS = {
  claude: [{ id: "claude-fable-5", label: "Claude Fable 5" }, { id: "claude-opus-5", label: "Claude Opus 5" }, { id: "claude-sonnet-5", label: "Claude Sonnet 5" }, { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" }],
  codex: [], "acp:gemini": [], "acp:cursor": [], fake: [{ id: "fake", label: "Fake" }],
} as const satisfies Record<import("./entities").AgentKind, readonly AgentModel[]>;
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

/**
 * Whether an agent can be told to forget the turns a checkpoint restore undid (Plan 7 W4).
 *
 * Every value is `false`, and that is a finding rather than a placeholder. All three adapters were
 * read before this table was written, and not one of them exposes a rewind:
 *
 *  - **Claude** — `StartOptions.resume` becomes the Agent SDK's `resume: <session id>`, which replays a
 *    conversation from its end. The SDK's query options have no "resume at message N".
 *  - **Codex** — `thread/resume { threadId }`. The app-server protocol has `turn/start`, `turn/steer`
 *    and `turn/interrupt`; there is no call that removes a completed turn from a thread.
 *  - **ACP (Cursor, Gemini)** — `session/load` replays the whole session as `session/update`
 *    notifications. The protocol has no truncation verb, and `loadSession` is itself optional.
 *
 * So a restore puts the FILES back and the agent still remembers writing them. Truncating Realm's own
 * transcript to hide that would be a lie about the provider's context — the model would still be told
 * about the work on the next turn — so Realm does not do it, and the confirmation says so instead.
 *
 * When an adapter gains the ability, flip its entry and the UI stops apologising: `checkpoints.restore`
 * reads this table for the sentence it returns, so there is one place to change.
 */
export const AGENT_CONVERSATION_REWIND = {
  claude: false, codex: false, "acp:cursor": false, "acp:gemini": false, fake: false,
} as const satisfies Record<import("./entities").AgentKind, boolean>;

/**
 * How much the agent may do without asking. Ordered least → most permissive.
 *
 * `plan` is deliberately NOT here. It used to sit in this list, which conflated two different axes:
 * "how freely may the agent act" and "is the agent building or thinking". Plan is now its own chip
 * (see `AGENT_SUPPORTS_PLAN_MODE`), and the two are chosen independently.
 */
export const PERMISSION_MODES = [{ id: "default", label: "Ask" }, { id: "acceptEdits", label: "Accept edits" }, { id: "bypassPermissions", label: "Full access" }] as const;

/**
 * Settings key for the permission mode NEW sessions start in (Plan 12 W6) — consumed server-side by
 * `sessions.create` whenever the caller does not name a mode (which is every instant-create path:
 * "+", ⌘N, the palette's one-shots). Stored as a `PERMISSION_MODES` id; anything else — including
 * `"plan"`, which is a mode axis and not a permission — resolves to `"default"`, as does any agent
 * whose permission model Realm cannot actually set (`AGENT_SUPPORTS_PERMISSION_MODES`): storing
 * `bypassPermissions` must never quietly widen an agent the table says Realm has no lever on.
 */
export const DEFAULT_PERMISSION_MODE_KEY = "sessions.defaultPermissionMode";

/**
 * The wire value for Plan. It is still transmitted through the `permissionMode` field because that is
 * the channel both supporting adapters read it on — Claude Code has a first-class `"plan"` permission
 * mode, and `codexPolicyFor` maps this exact string onto `approvalPolicy: "untrusted"` +
 * `sandbox: "read-only"`. Splitting the two axes is a UI split; the transport is unchanged.
 *
 * The consequence the prompter has to handle: a session in Plan is not storing the permission the user
 * chose, so leaving Plan has to put it back rather than resetting to `default`.
 */
export const PLAN_PERMISSION_MODE = "plan";
/** Build/Plan, the mode axis. Build is the absence of Plan, not a value Realm ever transmits. */
export const SESSION_MODES = [{ id: "build", label: "Build" }, { id: "plan", label: "Plan" }] as const;
export type SessionMode = (typeof SESSION_MODES)[number]["id"];

/**
 * Agent kinds that can actually be put into Plan.
 *
 * Kept apart from `AGENT_SUPPORTS_PERMISSION_MODES` because they answer different questions, even
 * though every kind currently gives them the same answer: one asks whether Realm can set how freely
 * the agent acts, the other whether the agent has a plan-only mode at all. An ACP agent that
 * advertised a `plan` id through `modes.availableModes` could support the second without the first.
 *
 * - `claude` — Claude Code's own `permissionMode: "plan"`.
 * - `codex` — `codexPolicyFor("plan")` starts the thread read-only under an untrusted approval policy.
 * - `acp:cursor` / `acp:gemini` — false for the same reason they have no permission picker: ACP mode
 *   ids are agent-defined, `AcpAdapter.start()` never reads `permissionMode`, and `session/set_mode`
 *   rejects a foreign id. Cursor does have a `plan` mode; Realm just has no way to name it yet. The
 *   follow-up is the same one: read `modes.availableModes` from `session/new` and map onto it.
 * - `fake` — the scripted dev adapter ignores the field entirely, but stays true so the development
 *   prompter shows the same controls as a real one (as it already does for permission modes).
 */
export const AGENT_SUPPORTS_PLAN_MODE = {
  claude: true, codex: true, "acp:cursor": false, "acp:gemini": false, fake: true,
} as const satisfies Record<import("./entities").AgentKind, boolean>;

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
