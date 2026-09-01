export const SPACE_COLORS = ["#7c6cff", "#3ddc97", "#ffb454", "#ff6b8b", "#4cc9f0", "#f4a261", "#a3e635", "#c084fc", "#38bdf8", "#fb7185"] as const;
/**
 * Every glyph a space's icon picker offers under its "Default" section. Curated one-clean-variant-
 * per-concept from the much larger `@hugeicons-pro/core-stroke-standard` pack already vendored into
 * `@realm/ui`'s `Icon` component (`packages/ui/src/Icon.tsx`) — this list and that map's keys must
 * stay in lockstep, since a name here with no matching entry there silently falls back to the folder
 * glyph. The first ten are the original set (unchanged order, so existing spaces keep their glyph).
 */
export const SPACE_ICONS = [
  "briefcase", "cap", "home", "folder", "terminal", "browser", "session", "artifact", "context", "layout",
  "rocket", "star", "book", "camera", "musicNote", "shield", "flag", "coffee", "target", "compass",
  "crown", "calendar", "clock", "gameController", "paintBrush", "magicWand", "tree", "building", "zap", "diamond",
  "fire", "leaf", "mountain", "flower", "rainbow", "umbrella", "cloud", "anchor", "puzzle", "gift",
  "trophy", "lightbulb", "key", "lock", "bell", "mic", "headphones", "video", "dice", "store",
  "house", "plane", "train", "bike", "globe2", "paintBucket", "pen", "ruler", "penTool", "startUp",
  "bookmark", "bookOpen2", "heart", "heartbreak", "cameraAi", "fireworks", "diceFaces", "gameboy", "pentagon", "microscope",
] as const;
export const pickSpaceColor = (i: number): string => SPACE_COLORS[i % SPACE_COLORS.length]!;

/**
 * `Space.icon` (and `Profile.icon`) stay a plain string on the wire — no schema change, fully
 * backward compatible with every row written before this parsed convention existed. A bare name (no
 * `:`) is every icon ever stored before user-generated icons existed, so it parses as the default
 * `hugeicon` kind rather than needing a one-time data migration.
 *
 * - `hugeicon:<name>` (or a bare name) — one of `SPACE_ICONS`, rendered by `@realm/ui`'s `Icon`.
 * - `emoji:<char>` — a raw unicode emoji, rendered as text (native OS rendering, no asset).
 * - `asset:<id>` — a user-generated or uploaded `IconAsset` row, looked up by id.
 */
export type SpaceIconRef = { kind: "hugeicon"; name: string } | { kind: "emoji"; char: string } | { kind: "asset"; id: string };
export function parseSpaceIcon(icon: string): SpaceIconRef {
  const i = icon.indexOf(":");
  if (i < 0) return { kind: "hugeicon", name: icon };
  const kind = icon.slice(0, i);
  const rest = icon.slice(i + 1);
  if (kind === "emoji" && rest.length > 0) return { kind: "emoji", char: rest };
  if (kind === "asset" && rest.length > 0) return { kind: "asset", id: rest };
  // Anything else (including a malformed `emoji:`/`asset:` with nothing after the colon, or an
  // explicit `hugeicon:name`) degrades to a hugeicon lookup — `Icon` already falls back to the
  // folder glyph for a name it doesn't recognize, so this can never render nothing.
  return { kind: "hugeicon", name: kind === "hugeicon" ? rest : icon };
}

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
  claude: [{ id: "claude-fable-5-1", label: "Claude Fable 5.1" }, { id: "claude-fable-5", label: "Claude Fable 5" }, { id: "claude-opus-5", label: "Claude Opus 5" }, { id: "claude-sonnet-5", label: "Claude Sonnet 5" }, { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" }],
  codex: [], "acp:gemini": [], "acp:cursor": [],
  // Plan 18's ACP agents: empty for the same reason as Cursor's — the catalog is enumerated live by
  // the probe (through `configOptions` now, see acpSessionConfig), so a hardcoded list would only ever
  // be a stale copy that shadows the truth. opencode alone reported 50 models on 2026-09-01.
  "acp:opencode": [], "acp:copilot": [], "acp:goose": [], "acp:qwen": [], "acp:grok": [], "acp:fx": [],
  fake: [{ id: "fake", label: "Fake" }],
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
export const SELECTABLE_AGENT_KINDS = [
  "claude", "codex", "acp:cursor", "acp:gemini",
  "acp:opencode", "acp:copilot", "acp:goose", "acp:qwen", "acp:grok", "acp:fx",
] as const satisfies ReadonlyArray<import("./entities").AgentKind>;
/** Frontier default model label per kind — what the prompter's model chip shows while `session.model`
 *  is null (the adapter's own default). Display-only: never transmitted as a model id. */
export const DEFAULT_MODEL_LABEL = {
  claude: "Fable 5.1", codex: "GPT-5.6", "acp:cursor": "Composer", "acp:gemini": "Gemini",
  // "Default" rather than a model name, because for these we do not know one before the handshake:
  // Cursor's default IS "Composer", but opencode's is whatever the user configured (measured:
  // `opencode/big-pickle` on this machine, which is a local config value, not a constant). Naming a
  // guess here would put a model the session is not on into the prompter's chip.
  "acp:opencode": "Default", "acp:copilot": "Default", "acp:goose": "Default",
  "acp:qwen": "Default", "acp:grok": "Default", "acp:fx": "Default",
  fake: "Fake",
} as const satisfies Record<import("./entities").AgentKind, string>;
/**
 * Agent kinds whose permission model Realm can actually control.
 *
 * ACP mode ids are agent-defined (Cursor uses `agent`/`plan`/`ask` — re-verified live 2026-09-01 against
 * cursor-agent 2026.07.25), so Realm's own Claude-derived ids are never transmitted: `AcpAdapter.start()`
 * does not read `permissionMode` as a permission at all, and `session/set_mode` with a foreign id is
 * rejected. Offering the picker there would be a lie about what the agent is allowed to do.
 *
 * Plan 14 W3 took the mode-axis half of the old follow-up: the PLAN mapping now exists per session
 * (`acpPlanMode` over the captured `availableModes`). The PERMISSION axis stays false — Cursor's
 * `agent`/`plan`/`ask` are what-the-agent-is-doing modes, none of them a "how freely may it act" level,
 * so there is still nothing honest to map Ask/Accept edits/Full access onto.
 */
export const AGENT_SUPPORTS_PERMISSION_MODES = {
  claude: true, codex: true, "acp:cursor": false, "acp:gemini": false,
  // Every ACP agent, for the reason above: mode ids are agent-defined, so there is nothing honest to
  // map Ask / Accept edits / Full access onto. One adapter, one answer.
  "acp:opencode": false, "acp:copilot": false, "acp:goose": false,
  "acp:qwen": false, "acp:grok": false, "acp:fx": false,
  fake: true,
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
  claude: false, codex: false, "acp:cursor": false, "acp:gemini": false,
  "acp:opencode": false, "acp:copilot": false, "acp:goose": false,
  "acp:qwen": false, "acp:grok": false, "acp:fx": false,
  fake: false,
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
 * - `acp:cursor` / `acp:gemini` — false HERE because the honest answer is per-session, not per-kind
 *   (Plan 14 W3): ACP mode ids are agent-defined, so whether Plan exists is whatever THIS session's
 *   `session/new` handshake advertised in `modes.availableModes` (captured on the init event). The
 *   prompter answers with `acpPlanMode` over those; this static entry is only the pre-handshake
 *   floor — no chip until the agent has named its modes.
 * - `fake` — the scripted dev adapter ignores the field entirely, but stays true so the development
 *   prompter shows the same controls as a real one (as it already does for permission modes).
 */
export const AGENT_SUPPORTS_PLAN_MODE = {
  claude: true, codex: true, "acp:cursor": false, "acp:gemini": false,
  // Same per-session answer as Cursor's, and now genuinely load-bearing: opencode reports its modes
  // through `configOptions`, so whether it has a Plan equivalent depends on the user's own agent
  // config. Measured on this machine it does NOT (its modes are custom agents named "Sisyphus",
  // "Prometheus - Plan Builder", …) — and "Plan Builder" is exactly the name a fuzzy match would
  // wrongly accept. The chip appears only when acpPlanMode finds a well-known id.
  "acp:opencode": false, "acp:copilot": false, "acp:goose": false,
  "acp:qwen": false, "acp:grok": false, "acp:fx": false,
  fake: true,
} as const satisfies Record<import("./entities").AgentKind, boolean>;

/** One advertised ACP session mode, as `session/new`'s `modes.availableModes` carries it. */
export type AcpSessionMode = { id: string; name: string; description?: string };

/**
 * The advertised mode Realm treats as Plan-equivalent, or null when the agent offers none.
 *
 * Matched on the AGENT'S OWN id being the well-known `"plan"` — either bare (verified live against
 * cursor-agent 2026.07.25: `agent`/`plan`/`ask`, with `plan` described as "Read-only mode for planning
 * and designing before implementation") or in ACP's spec-URI form, which GitHub Copilot uses.
 * Deliberately no fuzzy NAME matching: a mode Realm merely hopes means Plan is exactly the lie the
 * per-session capability exists to end. What the write transmits is the matched mode's own id,
 * never Realm's.
 */
export function acpPlanMode(modes: readonly AcpSessionMode[] | null | undefined): AcpSessionMode | null {
  return modes?.find((m) => acpWellKnownMode(m.id, "plan")) ?? null;
}

/**
 * The advertised mode Build maps back onto: the agent's `agent` mode when it has one (Cursor's
 * default), else the mode the session BOOTED in — provided that is not the plan mode itself.
 * Null means leaving Plan has nowhere honest to go, and the adapter sends nothing.
 */
export function acpBuildMode(modes: readonly AcpSessionMode[] | null | undefined, bootModeId: string | null): AcpSessionMode | null {
  if (!modes) return null;
  const agent = modes.find((m) => acpWellKnownMode(m.id, "agent"));
  if (agent) return agent;
  const boot = modes.find((m) => m.id === bootModeId);
  return boot && !acpWellKnownMode(boot.id, "plan") ? boot : null;
}

/**
 * ACP's own well-known session-mode identifiers. Agents may report a mode by its spec URI instead of
 * a bare id — GitHub Copilot does, e.g. `https://agentclientprotocol.com/protocol/session-modes#plan`.
 *
 * Matching these is NOT the fuzzy name matching `acpPlanMode` refuses. A spec URI is an identifier the
 * protocol defines and the agent chose deliberately; a mode merely *named* "Planning" is a guess. The
 * line is "did the agent name a well-known id", not "does the label look right".
 */
const ACP_MODE_URI_PREFIX = "https://agentclientprotocol.com/protocol/session-modes#";
/** True when `id` is the bare well-known id or its spec URI form. */
export function acpWellKnownMode(id: string, wellKnown: "plan" | "agent"): boolean {
  return id === wellKnown || id === `${ACP_MODE_URI_PREFIX}${wellKnown}`;
}

/**
 * One entry of ACP's `configOptions` — the replacement for `modes` and `models`.
 *
 * The spec is explicit: "If an Agent provides `configOptions`, Clients SHOULD use them instead of the
 * `modes` field. Modes will be removed in a future version of the protocol."
 * (agentclientprotocol.com/protocol/session-config-options). Writes go through
 * `session/set_config_option {sessionId, configId, value}`, NOT `session/set_mode`/`session/set_model`.
 */
export type AcpConfigOption = {
  id: string;
  /** `"mode"` and `"model"` are the two Realm consumes; anything else is carried and ignored. */
  category: string | null;
  currentValue: string | null;
  options: { value: string; name: string | null; description: string | null }[];
};

/**
 * Everything Realm reads off an ACP `session/new` answer, from whichever shape the agent speaks.
 *
 * `modeConfigId`/`modelConfigId` are the seam: non-null means the value came from `configOptions` and
 * the write is `session/set_config_option` with that id; null means the legacy `modes`/`models` shape
 * and the write is `session/set_mode`/`session/set_model`. Reading from one channel and writing on the
 * other is the failure this field exists to make impossible.
 */
export type AcpSessionConfig = {
  modes: AcpSessionMode[];
  currentModeId: string | null;
  modeConfigId: string | null;
  models: AgentModel[];
  currentModelId: string | null;
  modelConfigId: string | null;
};

const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const asStr = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Parses `configOptions` off a `session/new`/`session/load` answer. Entries missing a string `id` are
 *  dropped rather than repaired — a config option Realm cannot address is one it must not offer. */
export function parseAcpConfigOptions(raw: unknown): AcpConfigOption[] {
  if (!Array.isArray(raw)) return [];
  const out: AcpConfigOption[] = [];
  for (const entry of raw) {
    const o = asObj(entry);
    const id = asStr(o.id);
    if (!id) continue;
    const opts = Array.isArray(o.options) ? o.options : [];
    out.push({
      id,
      category: asStr(o.category),
      currentValue: asStr(o.currentValue),
      // An option may be a bare string or `{value, name?, description?}`. opencode emits `{"value":"build"}`
      // with no name at all, so the label falls back to the value — an ugly true label over a pretty guess.
      options: opts.map((raw) => {
        if (typeof raw === "string") return { value: raw, name: null, description: null };
        const oo = asObj(raw);
        const value = asStr(oo.value);
        return value ? { value, name: asStr(oo.name), description: asStr(oo.description) } : null;
      }).filter((v): v is { value: string; name: string | null; description: string | null } => v !== null),
    });
  }
  return out;
}

/**
 * Normalizes a `session/new` answer into the one shape the adapter uses, preferring `configOptions`
 * over `modes`/`models` per the spec.
 *
 * Measured 2026-09-01: opencode answers with `configOptions` ONLY (a `model` and a `mode` option, no
 * top-level `modes` or `models`), so an adapter reading only the legacy fields gives it no Plan chip
 * and no model picker — silently, which is the worst way to be wrong. Cursor answers with `modes` only.
 * Copilot answers with both. All three work off this one function.
 */
export function acpSessionConfig(session: unknown): AcpSessionConfig {
  const s = asObj(session);
  const cfg = parseAcpConfigOptions(s.configOptions);
  const modeOpt = cfg.find((o) => o.category === "mode");
  const modelOpt = cfg.find((o) => o.category === "model");

  const legacyModes = asObj(s.modes);
  const legacyModeRows = (Array.isArray(legacyModes.availableModes) ? legacyModes.availableModes : [])
    .map(asObj)
    .filter((m): m is Record<string, unknown> & { id: string; name: string } => typeof m.id === "string" && typeof m.name === "string")
    .map((m) => ({ id: m.id, name: m.name, ...(typeof m.description === "string" ? { description: m.description } : {}) }));

  const legacyModels = asObj(s.models);
  const legacyModelRows: AgentModel[] = [];
  for (const raw of Array.isArray(legacyModels.availableModels) ? legacyModels.availableModels : []) {
    const m = asObj(raw);
    const id = asStr(m.modelId);
    if (id) legacyModelRows.push({ id, label: asStr(m.name) ?? id });
  }

  return {
    modes: modeOpt
      ? modeOpt.options.map((o) => ({ id: o.value, name: o.name ?? o.value, ...(o.description ? { description: o.description } : {}) }))
      : legacyModeRows,
    currentModeId: modeOpt ? modeOpt.currentValue : asStr(legacyModes.currentModeId),
    modeConfigId: modeOpt ? modeOpt.id : null,
    models: modelOpt ? modelOpt.options.map((o) => ({ id: o.value, label: o.name ?? o.value })) : legacyModelRows,
    currentModelId: modelOpt ? modelOpt.currentValue : asStr(legacyModels.currentModelId),
    modelConfigId: modelOpt ? modelOpt.id : null,
  };
}

/**
 * Display metadata per agent kind (icon names come from @realm/ui's icon set).
 *
 * Every real agent names its *provider's* brand mark, so the prompter's model chip reads the way the
 * user's other tools do — the vendor's own glyph next to the model. `fake` keeps a generic Hugeicons
 * glyph because it is the scripted dev adapter and has no vendor to stand for.
 */
export const AGENT_META = {
  claude: { label: "Claude", icon: "claude" }, codex: { label: "Codex", icon: "openai" }, "acp:gemini": { label: "Gemini", icon: "gemini" },
  "acp:cursor": { label: "Cursor", icon: "cursor" },
  // Hugeicons glyphs, not brand marks: `brandMarks` carries real vendor path data for four vendors and
  // inventing SVG paths for the rest would render as garbage. Distinct glyphs so the picker rows are
  // still tellable apart; swap each for its real mark as the path data is added.
  "acp:opencode": { label: "OpenCode", icon: "code" },
  "acp:copilot": { label: "GitHub Copilot", icon: "branch" },
  "acp:goose": { label: "goose", icon: "compass" },
  "acp:qwen": { label: "Qwen Code", icon: "sparkles" },
  "acp:grok": { label: "Grok", icon: "zap" },
  "acp:fx": { label: "fx", icon: "rocket" },
  fake: { label: "Fake agent", icon: "bot" },
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
  "acp:opencode": { install: "npm install -g opencode-ai", login: "opencode auth login" },
  "acp:copilot": { install: "npm install -g @github/copilot", login: "copilot login" },
  "acp:goose": { install: "brew install block-goose-cli", login: "goose configure" },
  "acp:qwen": { install: "npm install -g @qwen-code/qwen-code", login: "qwen" },
  "acp:grok": { install: "npm install -g @xai-official/grok", login: "grok login" },
  // fx installs by shell script and gates its ACP handshake on being signed in — `fx login` is the
  // Vercel OAuth route, `fx setup` the API-key one. One command per slot, so `login` names the former.
  "acp:fx": { install: "curl -fsSL https://fx.sh/setup.sh | bash", login: "fx login" },
  fake: { install: null, login: null },
} as const satisfies Record<import("./entities").AgentKind, { install: string | null; login: string | null }>;

/** Shown under the agent picker so a signed-out agent tells the user exactly which command to run. */
export const AGENT_LOGIN_HINTS = {
  claude: "Uses your `claude` login — run `claude auth login` if sessions fail to authenticate.",
  codex: "Uses your `codex` login — run `codex login` if sessions fail to authenticate.",
  "acp:cursor": "Uses your Cursor login — run `cursor-agent login` if sessions fail to authenticate.",
  // Measured 2026-09-01 against gemini-cli 0.56.0: `initialize` succeeds and advertises four auth
  // methods; only `oauth-personal` is dead (session/new fails IneligibleTierError). The other three
  // work, so the kind is offered again with the live routes named instead of the dead one.
  "acp:gemini": "Google discontinued the Gemini CLI's free personal tier — sign in with a Gemini API key, Vertex AI credentials, or a custom AI gateway.",
  "acp:opencode": "Uses your OpenCode login — run `opencode auth login` if sessions fail to authenticate.",
  "acp:copilot": "Uses your GitHub Copilot login — run `copilot login` if sessions fail to authenticate.",
  "acp:goose": "Run `goose configure` to pick a provider and set its API key; goose has no login of its own.",
  "acp:qwen": "Run `qwen` once to sign in with your Qwen account, or set OPENAI_API_KEY.",
  "acp:grok": "Run `grok login` (browser sign-in, needs SuperGrok or X Premium), or set XAI_API_KEY.",
  // fx refuses `initialize` itself when signed out, so its failure lands on the boot branch with an
  // empty auth-method list; this hint is the only thing that tells the user what to do.
  "acp:fx": "Run `fx login` to sign in with Vercel, `fx setup` for an AI Gateway API key, or set AI_GATEWAY_API_KEY.",
  fake: "Scripted offline agent used for development.",
} as const satisfies Record<import("./entities").AgentKind, string>;
