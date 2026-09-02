import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AGENT_CLI_COMMANDS, DEFAULT_PERMISSION_MODE_KEY, NOTIFICATIONS_DISABLED_KEY, PAGE_REF_IDS } from "@realm/contracts";
import { engineVersionLabel, SettingsPage } from "./SettingsPage";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, macRow, type FakeData } from "../../state/store.test-fakes";
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
  // Plan 18's ACP agents. opencode is the one actually installed on a dev machine, so it is the row
  // that proves an installed-and-ready ACP agent renders no how-to-fix noise.
  { kind: "acp:opencode", available: true, version: "1.18.13", loggedIn: null, reason: "unknown until a session starts" },
  { kind: "acp:copilot", available: false, version: null, loggedIn: null, reason: "spawn copilot ENOENT" },
  { kind: "acp:goose", available: false, version: null, loggedIn: null, reason: "spawn goose ENOENT" },
  { kind: "acp:qwen", available: false, version: null, loggedIn: null, reason: "spawn qwen ENOENT" },
  { kind: "acp:grok", available: false, version: null, loggedIn: null, reason: "spawn grok ENOENT" },
  { kind: "acp:fx", available: false, version: null, loggedIn: null, reason: "spawn fx ENOENT" },
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

  it("Gemini is offered again, ONCE, with the auth routes that still work named", async () => {
    await mount();
    // Plan 18: measured against gemini-cli 0.56.0, only oauth-personal is dead — an API key, Vertex,
    // or a gateway all still open a session. So it is no longer withheld, and the note must name the
    // live routes rather than only the dead one.
    const rows = await screen.findAllByRole("listitem", { name: /Gemini: Not installed/ });
    // Kills the regression this change actually caused: ENGINE_ORDER used to append Gemini by hand
    // AND derive from SELECTABLE_AGENT_KINDS, so re-offering it rendered the row twice.
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).queryByText(/Not offered for new sessions/)).toBeNull();
    // Gemini has NO login command, so the hint is the only thing that can tell the user what to do.
    // Kills the regression re-offering it caused: the hint used to hang off `!offered`, so an offered
    // Gemini would have shown "Not installed" and nothing else.
    expect(within(rows[0]!).getByText(/free personal tier/)).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/Vertex AI credentials/)).toBeInTheDocument();
  });

  it("a ready agent carries no how-to-fix sentence — the hint is for blocked rows only", async () => {
    await mount();
    // opencode probes installed. Kills a mutation that drops the `isBlocked` guard and prints the
    // login hint on every row, which would tell a working agent to go and sign in.
    const ok = await screen.findByRole("listitem", { name: /OpenCode: Installed/ });
    expect(within(ok).queryByText(/opencode auth login/)).toBeNull();
  });

  it("lists every ACP agent Plan 18 added, each with its own install command", async () => {
    await mount();
    // opencode is deliberately absent: the fixture has it INSTALLED, so it correctly shows no install
    // command. That case is covered by its own test above.
    for (const [kind, name] of [["acp:copilot", "GitHub Copilot"], ["acp:goose", "goose"],
                                ["acp:qwen", "Qwen Code"], ["acp:grok", "Grok"], ["acp:fx", "fx"]] as const) {
      const row = await screen.findByRole("listitem", { name: new RegExp(`^${name}: `) });
      // Kills a copy-paste mutation that gives two agents the same install line — the failure mode
      // where the card tells you to install the wrong CLI.
      expect(within(row).getByText(AGENT_CLI_COMMANDS[kind].install!)).toBeInTheDocument();
    }
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

  it("submit key defaults to Enter and can switch to ⌘/Ctrl+Enter, writing ui.submitKey", async () => {
    const { store, api } = await openApp();
    expect(screen.getByRole("radio", { name: "Enter" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "⌘/Ctrl+Enter" }));
    await waitFor(() => expect(store.getState().submitKey).toBe("cmdEnter"));
    expect(api.calls).toContain("setSetting:ui.submitKey=cmdEnter");
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
    // Every ACP kind ignores the permission axis (agent-defined mode ids, nothing honest to map onto),
    // so the sentence names all of them rather than trailing off after the first.
    const ignored = screen.getByText(/sessions ignore it/);
    for (const label of ["Cursor", "Gemini", "OpenCode", "GitHub Copilot", "goose", "Qwen Code", "Grok", "fx"]) {
      expect(ignored.textContent).toContain(label);
    }
    expect(ignored.textContent).not.toContain("Claude,  Codex");
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

/** A `mac doctor` audit with nothing in it — used where a test is about the OTHER section and the
 *  mac rows would only add noise (both sections render a "Full Disk Access" row). */
const emptyMacAccess: MacAccessStatus = {
  cli: { present: true, path: "/opt/homebrew/bin/mac", version: "0.6.0" },
  host: { name: "Realm", bundlePath: "/Applications/Realm.app", packaged: true },
  rows: [],
};

describe("Permissions tab (macOS TCC)", () => {
  const openPermissions = async (overrides: FakeData = {}) => {
    const mounted = await mount({ macAccess: emptyMacAccess, ...overrides });
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
    // One green check in THIS section: the single granted row. Nothing else may borrow it.
    expect(document.querySelectorAll('.realm-access-field .tcc-state[data-state="granted"]')).toHaveLength(1);
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
    ], macAccess: emptyMacAccess });
    expect(await screen.findByRole("listitem", { name: "Full Disk Access: Not granted" })).toBeInTheDocument();
    expect(document.querySelectorAll('.realm-access-field .tcc-state[data-state="granted"]')).toHaveLength(0);
  });

  it("does not glue a v onto a version that already names its product (codex-cli 0.146.0)", () => {
    // Live-pass finding: "vcodex-cli 0.146.0". The v is for bare numbers only.
    expect(engineVersionLabel("codex-cli 0.146.0")).toBe("codex-cli 0.146.0");
    expect(engineVersionLabel("2.1.223 (Claude Code)")).toBe("v2.1.223 (Claude Code)");
  });
});


describe("Permissions tab — Apps on this Mac (the grantable half)", () => {
  const openPermissions = async (overrides: FakeData = {}) => {
    const mounted = await mount(overrides);
    fireEvent.click(screen.getByRole("radio", { name: "Permissions" }));
    return mounted;
  };
  const macRowFor = (name: string) => screen.getByRole("listitem", { name });

  it("renders mac doctor's five states as five different words — Add-only is never dressed as Granted", async () => {
    const { api } = await openPermissions({ macAccess: {
      cli: { present: true, path: "/opt/homebrew/bin/mac", version: "0.6.0" },
      host: { name: "Realm", bundlePath: "/Applications/Realm.app", packaged: true },
      rows: [
        macRow("calendar", "Calendar", "data", "writeOnly"),
        macRow("reminders", "Reminders", "data", "granted"),
        macRow("contacts", "Contacts", "data", "denied"),
        macRow("automation:Mail", "Mail", "automation", "notRequested"),
        macRow("automation:Notes", "Notes", "automation", "unknown"),
      ],
    } });
    await waitFor(() => expect(api.calls).toContain("macAccessStatus"));
    expect(await screen.findByRole("listitem", { name: "Calendar: Add-only" })).toBeInTheDocument();
    expect(macRowFor("Reminders: Granted")).toBeInTheDocument();
    expect(macRowFor("Contacts: Refused")).toBeInTheDocument();
    expect(macRowFor("Mail: Not asked yet")).toBeInTheDocument();
    expect(macRowFor("Notes: Unknown")).toBeInTheDocument();
    // Exactly one green check: the granted row. writeOnly is a HALF grant and must not borrow it.
    expect(document.querySelectorAll('.mac-access-field .tcc-state[data-state="granted"]')).toHaveLength(1);
  });

  it("a REFUSED row offers System Settings but never a prompt — denials are sticky, so an Ask button there could not work", async () => {
    await openPermissions();
    const denied = await screen.findByRole("listitem", { name: "Reminders: Refused" });
    expect(within(denied).queryByRole("button", { name: "Ask macOS" })).toBeNull();
    expect(within(denied).getByRole("button", { name: "Open System Settings" })).toBeInTheDocument();
  });

  it("a GRANTED row offers nothing at all — there is nothing left to ask and nothing left to fix", async () => {
    await openPermissions();
    const granted = await screen.findByRole("listitem", { name: "Calendar: Granted" });
    expect(within(granted).queryAllByRole("button")).toEqual([]);
  });

  it("Full Disk Access offers the drag, not a dialog macOS does not have", async () => {
    const { api } = await openPermissions();
    const fda = await screen.findByRole("listitem", { name: "Full Disk Access: Refused" });
    expect(within(fda).queryByRole("button", { name: "Ask macOS" })).toBeNull();
    fireEvent.click(within(fda).getByRole("button", { name: "Show app in Finder" }));
    await waitFor(() => expect(api.calls).toContain("macAccessRevealApp"));
    fireEvent.click(within(fda).getByRole("button", { name: "Open System Settings" }));
    await waitFor(() => expect(api.calls).toContain("macAccessOpenSettings:fullDiskAccess"));
  });

  it("shows the exact command before running it, and says which ones open an app", async () => {
    await openPermissions();
    const mail = await screen.findByRole("listitem", { name: "Mail: Not asked yet" });
    expect(mail.textContent).toContain("mac mail list --json");
    expect(mail.textContent).toContain("which opens Mail");
  });

  it("“Ask for all” walks ONLY the promptable rows, one dialog at a time, and each answer lands", async () => {
    const { api } = await openPermissions({ macAccess: {
      cli: { present: true, path: "/opt/homebrew/bin/mac", version: "0.6.0" },
      host: { name: "Realm", bundlePath: "/Applications/Realm.app", packaged: true },
      rows: [
        macRow("calendar", "Calendar", "data", "granted"),        // nothing to ask
        macRow("reminders", "Reminders", "data", "denied"),        // asking cannot work
        macRow("contacts", "Contacts", "data", "notRequested"),    // ask
        macRow("automation:Mail", "Mail", "automation", "unknown"),// ask
        macRow("fullDiskAccess", "Full Disk Access", "disk", "denied"), // no dialog exists
      ],
    } });
    fireEvent.click(await screen.findByRole("button", { name: "Ask for all 2" }));
    await waitFor(() => expect(screen.getByRole("listitem", { name: "Contacts: Granted" })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("listitem", { name: "Mail: Granted" })).toBeInTheDocument());
    // The named mutant: a walk that also re-asks the granted/denied/prompt-less rows.
    expect(api.calls.filter((c) => c.startsWith("macAccessGrant:"))).toEqual(["macAccessGrant:contacts", "macAccessGrant:automation:Mail"]);
  });

  it("names what the walk will NOT have fixed, so a short run can't read as full coverage", async () => {
    await openPermissions();
    const field = document.querySelector(".mac-access-field")!;
    await waitFor(() => expect(field.textContent).toContain("1 of 4 granted"));
    expect(field.textContent).toContain("Reminders, Full Disk Access can't be asked for at all and stay for System Settings.");
  });

  it("a refusal mid-walk does not abandon the rest of it", async () => {
    const { api } = await openPermissions({
      macAccess: {
        cli: { present: true, path: "/opt/homebrew/bin/mac", version: "0.6.0" },
        host: { name: "Realm", bundlePath: "/Applications/Realm.app", packaged: true },
        rows: [macRow("contacts", "Contacts", "data", "notRequested"), macRow("automation:Mail", "Mail", "automation", "notRequested")],
      },
      macGrantAnswers: { contacts: "denied" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Ask for all 2" }));
    await waitFor(() => expect(screen.getByRole("listitem", { name: "Mail: Granted" })).toBeInTheDocument());
    expect(screen.getByRole("listitem", { name: "Contacts: Refused" })).toBeInTheDocument();
    expect(api.calls).toContain("macAccessGrant:automation:Mail");
  });

  it("only one macOS dialog at a time: a second Ask while one is pending is dropped, not queued behind it", async () => {
    const { api } = await openPermissions();
    api.delays["macAccessGrant:automation:Mail"] = 50;
    const mail = await screen.findByRole("listitem", { name: "Mail: Not asked yet" });
    const ask = within(mail).getByRole("button", { name: "Ask macOS" });
    fireEvent.click(ask);
    // While the dialog is up the row says so, and every Ask button on the page is disabled.
    expect(await screen.findByRole("button", { name: "Waiting for macOS…" })).toBeDisabled();
    fireEvent.click(ask);
    await waitFor(() => expect(screen.getByRole("listitem", { name: "Mail: Granted" })).toBeInTheDocument());
    expect(api.calls.filter((c) => c === "macAccessGrant:automation:Mail")).toHaveLength(1);
  });

  it("warns that a dev build's grants land on the wrong app — the caveat that would otherwise cost an afternoon", async () => {
    await openPermissions({ macAccess: {
      cli: { present: true, path: "/opt/homebrew/bin/mac", version: "0.6.0" },
      host: { name: "Electron", bundlePath: "/repo/node_modules/electron/dist/Electron.app", packaged: false },
      rows: [macRow("calendar", "Calendar", "data", "notRequested")],
    } });
    expect((await screen.findByText(/development build/)).textContent).toContain("Electron");
    expect(screen.getByText(/development build/).textContent).toContain("won't carry into the packaged Realm.app");
  });

  it("no mac CLI means no permissions to offer — and it says where it looked instead of showing empty rows", async () => {
    await openPermissions({ macAccess: { cli: { present: false, searched: ["/opt/homebrew/bin", "/usr/local/bin"] }, host: { name: "Realm", bundlePath: "/Applications/Realm.app", packaged: true }, rows: [] } });
    const field = document.querySelector(".mac-access-field")!;
    await waitFor(() => expect(field.textContent).toContain("/opt/homebrew/bin"));
    expect(screen.queryByRole("button", { name: /Ask for all/ })).toBeNull();
  });
});
