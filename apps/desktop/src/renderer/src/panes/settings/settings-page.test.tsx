import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AGENT_CLI_COMMANDS, DEFAULT_PERMISSION_MODE_KEY, NOTIFICATIONS_DISABLED_KEY, PAGE_REF_IDS } from "@realm/contracts";
import { engineVersionLabel, SettingsPage } from "./SettingsPage";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, type FakeData } from "../../state/store.test-fakes";
import type { AgentProbe } from "../../state/store";

/** The pane as PaneHost mounts it: kind is the identity, refId the sentinel. */
const pageItem = item("set-s1", "s1", { kind: "settings-page", title: "Settings", refId: PAGE_REF_IDS["settings-page"] });

/** A realistic probe: Claude installed (keychain login unknowable), Codex installed but signed out,
 *  Cursor missing, Gemini missing. What the Engines rows must render honestly. */
const probe: AgentProbe[] = [
  { kind: "claude", available: true, version: "2.1.223", loggedIn: null, reason: "unknown (keychain)" },
  { kind: "codex", available: true, version: "0.48.0", loggedIn: false, reason: "not logged in — run `codex login`" },
  { kind: "acp:cursor", available: false, version: null, loggedIn: null, reason: "spawn cursor-agent ENOENT" },
  { kind: "acp:gemini", available: false, version: null, loggedIn: null, reason: "spawn gemini ENOENT" },
];

async function mount(overrides: FakeData = {}) {
  const api = fakeApi({ agentProbe: probe, ...overrides });
  const store = createAppStore(api);
  await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}><SettingsPage item={pageItem} visible /></StoreContext.Provider>);
  return { store, api, ...r };
}

describe("the Settings page (Plan 12 W6)", () => {
  it("wears the page pattern: head, an Engines · App · Permissions rail, Engines first", async () => {
    await mount();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Engines" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "App" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Permissions" })).not.toBeChecked();
  });
});

describe("Engines tab", () => {
  it("mounting rides the probe cache; Re-check FORCES (the named mutant: a cached probe shown as fresh)", async () => {
    const { api } = await mount();
    await waitFor(() => expect(api.calls).toContain("probeAgents:false"));
    expect(api.calls).not.toContain("probeAgents:true");
    fireEvent.click(screen.getByRole("button", { name: "Re-check" }));
    await waitFor(() => expect(api.calls).toContain("probeAgents:true"));
  });

  it("renders each CLI's honest state: installed + version, signed-out, missing — and login-unknowable renders as NOTHING, not a claim", async () => {
    await mount();
    // Claude: installed with version; loggedIn null (keychain) must claim neither signed in nor out.
    const claude = await screen.findByRole("listitem", { name: /Claude: Installed · v2\.1\.223$/ });
    expect(within(claude).queryByText(/signed/)).toBeNull();
    // Codex: installed and explicitly signed out — with the LOGIN command, not the install one.
    const codex = screen.getByRole("listitem", { name: /Codex: Installed · v0\.48\.0 · signed out/ });
    expect(within(codex).getByText(AGENT_CLI_COMMANDS.codex.login!)).toBeInTheDocument();
    expect(within(codex).queryByText(AGENT_CLI_COMMANDS.codex.install!)).toBeNull();
    // Cursor: missing — with the exact install command.
    const cursor = screen.getByRole("listitem", { name: /Cursor: Not installed/ });
    expect(within(cursor).getByText(AGENT_CLI_COMMANDS["acp:cursor"].install!)).toBeInTheDocument();
  });

  it("Gemini appears with its honest dead-end note rather than being hidden", async () => {
    await mount();
    const gemini = await screen.findByRole("listitem", { name: /Gemini: Not installed/ });
    expect(within(gemini).getByText(/Not offered for new sessions/)).toBeInTheDocument();
    expect(within(gemini).getByText(/free personal tier/)).toBeInTheDocument();
  });

  it("copying an install command puts the command on the clipboard VERBATIM — no trailing newline (doctrine)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await mount();
    const cursor = await screen.findByRole("listitem", { name: /Cursor: Not installed/ });
    fireEvent.click(within(cursor).getByRole("button", { name: "Copy command" }));
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0]![0] as string;
    expect(copied).toBe(AGENT_CLI_COMMANDS["acp:cursor"].install);
    expect(copied.endsWith("\n")).toBe(false);
  });
});

describe("App tab", () => {
  const openApp = async (overrides: FakeData = {}) => {
    const mounted = await mount(overrides);
    fireEvent.click(screen.getByRole("radio", { name: "App" }));
    return mounted;
  };

  it("theme is the existing themePref as a segmented control; choosing writes ui.theme", async () => {
    const { store, api } = await openApp();
    expect(screen.getByRole("radio", { name: "System" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    await waitFor(() => expect(store.getState().themePref).toBe("dark"));
    expect(api.calls).toContain("setSetting:ui.theme=dark");
  });

  it("notification switches read W5's key: default-on, a stored disable shows OFF, and the copy says disabling stops new rows only", async () => {
    await openApp({ settings: { [NOTIFICATIONS_DISABLED_KEY]: ["mcp_health"] } });
    expect(await screen.findByRole("switch", { name: "Connection trouble" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Permission requests" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Sessions finishing" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Engine regressions" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Worktree hazards" })).toBeChecked();
    expect(screen.getByText(/stops new rows from being written/)).toBeInTheDocument();
  });

  it("a toggle writes EXACTLY its own category (the named mutant: the wrong category), leaving the rest of the set alone", async () => {
    const { api } = await openApp({ settings: { [NOTIFICATIONS_DISABLED_KEY]: ["mcp_health"] } });
    fireEvent.click(await screen.findByRole("switch", { name: "Sessions finishing" }));
    await waitFor(() => expect(api.data.settings[NOTIFICATIONS_DISABLED_KEY]).toEqual(["mcp_health", "session_done"]));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Sessions finishing" })).not.toBeChecked());
    // Re-enable removes only session_done; the pre-existing disable survives.
    fireEvent.click(screen.getByRole("switch", { name: "Sessions finishing" }));
    await waitFor(() => expect(api.data.settings[NOTIFICATIONS_DISABLED_KEY]).toEqual(["mcp_health"]));
  });

  it("default permission mode: reads the stored key, and a plain choice (Accept edits) writes it immediately", async () => {
    const { api } = await openApp({ settings: { [DEFAULT_PERMISSION_MODE_KEY]: "acceptEdits" } });
    expect(await screen.findByRole("radio", { name: "Accept edits" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Ask" }));
    await waitFor(() => expect(api.data.settings[DEFAULT_PERMISSION_MODE_KEY]).toBe("default"));
  });

  it("Full access as a default demands its own confirm (the named mutant: bypass skipping it), and the confirm SAYS what it means", async () => {
    const { api } = await openApp();
    fireEvent.click(await screen.findByRole("radio", { name: "Full access" }));
    // Nothing written yet, and the control still shows the current mode.
    expect(api.data.settings[DEFAULT_PERMISSION_MODE_KEY]).toBeUndefined();
    expect(screen.getByRole("radio", { name: "Ask" })).toBeChecked();
    const confirm = screen.getByRole("button", { name: /run tools and edit files without asking first/ });
    fireEvent.click(confirm);
    await waitFor(() => expect(api.data.settings[DEFAULT_PERMISSION_MODE_KEY]).toBe("bypassPermissions"));
    expect(screen.getByRole("radio", { name: "Full access" })).toBeChecked();
  });

  it("per-agent honesty: the control names who obeys it and who ignores it (AGENT_SUPPORTS_PERMISSION_MODES)", async () => {
    await openApp();
    expect(await screen.findByText(/Applies to new Claude, Codex sessions/)).toBeInTheDocument();
    expect(screen.getByText(/Cursor sessions ignore it/)).toBeInTheDocument();
  });

  it("junk under either key degrades safely: unknown categories dropped, an unlisted mode renders as Ask", async () => {
    await openApp({ settings: { [NOTIFICATIONS_DISABLED_KEY]: ["nonsense", "permission"], [DEFAULT_PERMISSION_MODE_KEY]: "plan" } });
    expect(await screen.findByRole("switch", { name: "Permission requests" })).not.toBeChecked();
    // "plan" is a mode axis, not a permission — the server would refuse it, so the page must not show it.
    expect(screen.getByRole("radio", { name: "Ask" })).toBeChecked();
  });
});

describe("App tab → Updates row (Plan 15 W1)", () => {
  const openApp = async (overrides: FakeData = {}) => {
    const mounted = await mount(overrides);
    fireEvent.click(screen.getByRole("radio", { name: "App" }));
    return mounted;
  };

  it("renders the current version and, on today's shipped truth (unsigned), a DISABLED button naming that reason — no dead gray mystery", async () => {
    const { api } = await openApp();
    await waitFor(() => expect(api.calls).toContain("updateStatus"));
    expect(await screen.findByText("Realm v0.0.1")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: "Check for updates" });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/unsigned build — macOS can only install a signed update/)).toBeInTheDocument();
    // A disabled button never checks — clicking is inert, no fake spinner, no call.
    fireEvent.click(btn);
    expect(api.calls).not.toContain("checkUpdates");
    expect(screen.queryByText("Checking for updates…")).toBeNull();
  });

  it("each gate reason gets its own honest sentence (dev / no public feed)", async () => {
    await openApp({ updateStatus: { version: "0.0.1", state: { kind: "disabled", reason: "no-feed" } } });
    expect(await screen.findByText(/no public update feed — this build's releases are private/)).toBeInTheDocument();
    cleanup();
    await openApp({ updateStatus: { version: "0.0.1", state: { kind: "disabled", reason: "dev" } } });
    expect(await screen.findByText("Update checks don't run in development builds.")).toBeInTheDocument();
  });

  it("an ENABLED build checks for real: the interim 'checking' reflects the in-flight call, then main's verdict lands verbatim", async () => {
    const { api } = await openApp({ updateStatus: { version: "1.0.0", state: { kind: "idle" } } });
    const btn = await screen.findByRole("button", { name: "Check for updates" });
    expect(btn).toBeEnabled();
    api.delays.checkUpdates = 40; // hold the fake's answer so the genuine in-flight state is visible
    fireEvent.click(btn);
    expect(await screen.findByText("Checking for updates…")).toBeInTheDocument();
    expect(btn).toBeDisabled(); // no double-check while one is in flight
    api.data.updateStatus = { version: "1.0.0", state: { kind: "up-to-date" } };
    expect(await screen.findByText("You're on the latest version.")).toBeInTheDocument();
    expect(api.calls.filter((c) => c === "checkUpdates")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeEnabled();
  });

  it("a downloaded update swaps the button for 'Restart to update', which asks main to install", async () => {
    const { api } = await openApp({ updateStatus: { version: "1.0.0", state: { kind: "downloaded", version: "1.1.0" } } });
    expect(await screen.findByText(/v1\.1\.0 is ready — restart to finish installing/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restart to update" }));
    await waitFor(() => expect(api.calls).toContain("installUpdate"));
  });

  it("a failed check reports the error and leaves the button usable for a retry", async () => {
    await openApp({ updateStatus: { version: "1.0.0", state: { kind: "error", message: "ENOTFOUND github.com" } } });
    expect(await screen.findByText("Update check failed: ENOTFOUND github.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeEnabled();
  });
});

describe("Permissions tab (macOS TCC)", () => {
  const openPermissions = async (overrides: FakeData = {}) => {
    const mounted = await mount(overrides);
    fireEvent.click(screen.getByRole("radio", { name: "Permissions" }));
    return mounted;
  };

  it("renders main's probe rows VERBATIM — granted only where a probe basis exists, 'can't be checked' where none does (the named mutant: unearned green)", async () => {
    const { api } = await openPermissions();
    await waitFor(() => expect(api.calls).toContain("tccProbe"));
    // The two no-API rows: never a state, always the transcription's own phrase.
    expect(await screen.findByRole("listitem", { name: "Files & Folders: Can't be checked until used" })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "Automation: Can't be checked until used" })).toBeInTheDocument();
    // The probed rows wear exactly what the probe said.
    expect(screen.getByRole("listitem", { name: "Screen Recording: Not granted" })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "Accessibility: Granted" })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "Full Disk Access: Not granted" })).toBeInTheDocument();
    // One green check on the page: the single granted row. Nothing else may borrow it.
    expect(document.querySelectorAll('.tcc-state[data-state="granted"]')).toHaveLength(1);
  });

  it("every row deep-links its own System Settings pane by ROW ID — never a URL from the renderer", async () => {
    const { api } = await openPermissions();
    const row = await screen.findByRole("listitem", { name: "Screen Recording: Not granted" });
    fireEvent.click(within(row).getByRole("button", { name: "Open System Settings" }));
    await waitFor(() => expect(api.calls).toContain("openTccPane:screenRecording"));
    expect(api.calls.filter((c) => c.startsWith("openTccPane:"))).toEqual(["openTccPane:screenRecording"]);
  });

  it("a probe that reports everything denied still renders — an honest wall of 'not granted', no invented grants", async () => {
    await openPermissions({ tccRows: [
      { id: "fullDisk", label: "Full Disk Access", state: "denied", detail: "macOS refused the probe file." },
    ] });
    expect(await screen.findByRole("listitem", { name: "Full Disk Access: Not granted" })).toBeInTheDocument();
    expect(document.querySelectorAll('.tcc-state[data-state="granted"]')).toHaveLength(0);
  });

  it("does not glue a v onto a version that already names its product (codex-cli 0.146.0)", () => {
    // Live-pass finding: "vcodex-cli 0.146.0". The v is for bare numbers only.
    expect(engineVersionLabel("codex-cli 0.146.0")).toBe("codex-cli 0.146.0");
    expect(engineVersionLabel("2.1.223 (Claude Code)")).toBe("v2.1.223 (Claude Code)");
  });
});
