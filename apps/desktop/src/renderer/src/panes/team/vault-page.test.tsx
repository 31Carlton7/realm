import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { TeamActivity, VaultGrant, VaultUse } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, profile, space, teamRole, teamSpace } from "../../state/store.test-fakes";
import { VaultPage } from "./VaultPage";
import { TeamRailList } from "./TeamPages";
import { setVaultClient, type VaultClient, type VaultListing } from "./vault-client";
import { usageLine, vaultEntries, vaultSentence } from "./vault-format";

/**
 * The team's Vault page and its grant sheet. The mutants are named per test; the ones the page exists
 * to stop are a "use without asking" that turns on in one click (or without main), and a turn-off that
 * asks for anything.
 */

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setVaultClient(null); });

const S = "01J00000000000000000SPACE1";
const ANALYST = teamRole("01J0000000000000000ANALYST", S, "Growth Analyst");
const MANAGER = teamRole("01J0000000000000000MANAGER", S, "Creator Manager");
const NOW = Date.now();

const LISTING: VaultListing = {
  available: true, profileUnattended: false, allows: [],
  secrets: {
    signins: [
      { id: "c-tiktok", origin: "https://www.tiktok.com", username: "nathan", label: "@versed.nathan", generated: false, spaceId: S, createdAt: 1 },
      { id: "c-github", origin: "https://github.com", username: "me", label: "", generated: false, spaceId: null, createdAt: 1 },
    ],
    keys: [{ id: "k-rc", name: "REVENUECAT_SECRET_KEY", label: "", allowedHosts: ["api.revenuecat.com", "api2.revenuecat.com"], spaceId: S, createdAt: 1 }],
  },
};
const grant = (secretId: string, roleId: string, over: Partial<VaultGrant> = {}): VaultGrant => ({
  secretId, spaceId: S, roleId, kind: secretId.startsWith("k-") ? "key" : "signin", name: secretId, hosts: ["api.revenuecat.com"], purpose: null, createdAt: 77, ...over,
});
const use = (over: Partial<VaultUse>): VaultUse => ({
  id: "u", ts: NOW - 60_000, actor: `role:${ANALYST.id}`, roleId: ANALYST.id, sessionId: "s", runId: "r", outcome: "used",
  secretId: "k-rc", secretName: "REVENUECAT_SECRET_KEY", kind: "key", where: "api.revenuecat.com", how: "card", status: 200, ...over,
});

function fakeClient(over: Partial<VaultClient> = {}, listing: VaultListing = LISTING) {
  const calls: string[] = [];
  const c: VaultClient = {
    list: async () => listing,
    addSignin: vi.fn(), addKey: vi.fn(), remove: vi.fn(async () => true),
    setAllow: vi.fn(async (_p, input) => { calls.push(`setAllow:${input.roleId}:${input.hosts.join(",")}:${input.grantAt}`); return { ok: true as const, allow: { ...input, setAt: 1 } }; }),
    clearAllow: vi.fn(async (secretId, roleId) => { calls.push(`clearAllow:${secretId}:${roleId}`); return true; }),
    grants: async () => [grant("k-rc", ANALYST.id), grant("c-tiktok", MANAGER.id, { hosts: ["www.tiktok.com"] })],
    grant: vi.fn(async (input) => { calls.push(`grant:${input.roleId}:${input.hosts.join(",")}`); return grant(input.secretId, input.roleId); }),
    revoke: vi.fn(async (_s, secretId, roleId) => { calls.push(`revoke:${secretId}:${roleId}`); return true; }),
    uses: async () => [
      use({ id: "u1", ts: NOW - 30_000, roleId: MANAGER.id, actor: `role:${MANAGER.id}`, outcome: "filled", kind: "signin", secretId: "c-tiktok", secretName: "tiktok.com · nathan", where: "www.tiktok.com" }),
      use({ id: "u2" }),
      use({ id: "u3", outcome: "refused", secretId: "k-vercel", secretName: "VERCEL_TOKEN", where: "not granted to this role", how: null }),
    ],
    allowChanged: vi.fn(async (_s, secretId, roleId) => { calls.push(`allowChanged:${secretId}:${roleId}`); return { on: true }; }),
    ...over,
  };
  setVaultClient(c);
  return { c, calls };
}

async function mount() {
  const api = fakeApi({ profiles: [profile("p1", "Work")], spaces: [space(S, "p1", "Versed")], teams: [teamSpace(S, [ANALYST, MANAGER])] });
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().refreshTeams();
  const team = store.getState().teams[S]!;
  render(<StoreContext.Provider value={store}><VaultPage spaceId={S} team={team} /></StoreContext.Provider>);
  await screen.findByText("REVENUECAT_SECRET_KEY");
  return { store };
}

const openRow = (name: string) => fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} —`) }));

describe("the Vault page", () => {
  it("reads sign-ins, then recent use, then keys — the audit before the keys", async () => {
    fakeClient();
    await mount();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Vault");
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Sign-ins", "Recent use", "Keys"]);
    expect(document.querySelector(".page-vantage")).toHaveTextContent("2 secrets · Keychain");
    expect(screen.getByText(/the agent never receives the value/)).toBeInTheDocument();
  });

  it("names who may use each secret, and lists a profile sign-in only once a role here holds it", async () => {
    // THE MUTANT: every one of the profile's sign-ins drawn as the team's.
    fakeClient();
    await mount();
    expect(screen.getByText("Sign-in for @versed.nathan · Creator Manager")).toBeInTheDocument();
    expect(screen.getByText("API key · only to api.revenuecat.com, api2.revenuecat.com · Growth Analyst")).toBeInTheDocument();
    expect(screen.queryByText(/github\.com/)).toBeNull();
  });

  it("draws each use as who, what, where and a chip in words", async () => {
    fakeClient();
    await mount();
    const rows = within(document.querySelector(".tv-uses tbody")!).getAllByRole("row").map((r) => [...r.querySelectorAll("td")].slice(1).map((td) => td.textContent));
    expect(rows).toEqual([
      ["Creator Manager", "Filled tiktok.com · nathan", "www.tiktok.com", "Filled"],
      ["Growth Analyst", "REVENUECAT_SECRET_KEY into one request", "api.revenuecat.com", "Used"],
      ["Growth Analyst", "Asked for VERCEL_TOKEN", "not granted to this role", "Refused"],
    ]);
  });
});

describe("the grant sheet", () => {
  it("grants a role every host by default, and takes a grant away in one click", async () => {
    const { calls } = fakeClient();
    await mount();
    openRow("REVENUECAT_SECRET_KEY");
    const sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByRole("switch", { name: "Creator Manager may use REVENUECAT_SECRET_KEY" }));
    fireEvent.click(within(sheet).getByRole("switch", { name: "Growth Analyst may use REVENUECAT_SECRET_KEY" }));
    await waitFor(() => expect(calls).toEqual([`grant:${MANAGER.id}:`, `revoke:k-rc:${ANALYST.id}`]));
  });

  it("asks before 'use without asking', in words, and only main's yes turns it on", async () => {
    // THE MUTANT: the switch calling setAllow on the click, with no sheet saying what it costs.
    const { calls } = fakeClient();
    await mount();
    openRow("REVENUECAT_SECRET_KEY");
    const sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByRole("switch", { name: "Growth Analyst uses REVENUECAT_SECRET_KEY without asking" }));
    const confirm = await screen.findByRole("dialog", { name: "Let Growth Analyst use REVENUECAT_SECRET_KEY without asking?" });
    expect(calls).toEqual([]);
    expect(confirm).toHaveTextContent("Only this secret, only for Growth Analyst, only at api.revenuecat.com.");
    // The profile still asks for Touch ID, so the sheet says the switch alone changes nothing yet.
    expect(confirm).toHaveTextContent("It takes effect once Settings ▸ Sign-ins unlocks Work's sign-ins without asking.");
    expect(confirm).toHaveTextContent("macOS asks for Touch ID or your login password");
    fireEvent.click(within(confirm).getByRole("button", { name: "Turn on for Growth Analyst" }));
    await waitFor(() => expect(calls).toEqual([`setAllow:${ANALYST.id}:api.revenuecat.com:77`, `allowChanged:k-rc:${ANALYST.id}`]));
  });

  it("says macOS's no and stays put, writing nothing to the log", async () => {
    const { calls } = fakeClient({ setAllow: vi.fn(async () => ({ ok: false as const, error: "macOS did not confirm it was you, so nothing changed." })) });
    await mount();
    openRow("REVENUECAT_SECRET_KEY");
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("switch", { name: /without asking/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Turn on for Growth Analyst" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("macOS did not confirm it was you");
    expect(calls).toEqual([]);
  });

  it("turns 'use without asking' off in one click, asking nothing", async () => {
    const listing = { ...LISTING, profileUnattended: true, allows: [{ secretId: "k-rc", roleId: ANALYST.id, spaceId: S, hosts: ["api.revenuecat.com"], grantAt: 77, setAt: 1 }] };
    const { calls } = fakeClient({}, listing);
    await mount();
    expect(screen.getByText("Without asking")).toBeInTheDocument();
    openRow("REVENUECAT_SECRET_KEY");
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("Uses it without asking on this Mac")).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("switch", { name: "Growth Analyst uses REVENUECAT_SECRET_KEY without asking" }));
    await waitFor(() => expect(calls).toEqual([`clearAllow:k-rc:${ANALYST.id}`, `allowChanged:k-rc:${ANALYST.id}`]));
    expect(screen.queryByRole("dialog", { name: /without asking\?/ })).toBeNull();
  });

  it("is out of an agent's reach: every control in it, and the confirmation, carry data-no-agent", async () => {
    fakeClient();
    await mount();
    expect(screen.getByRole("button", { name: "Add…" })).toHaveAttribute("data-no-agent");
    openRow("REVENUECAT_SECRET_KEY");
    const sheet = await screen.findByRole("dialog");
    const allow = within(sheet).getByRole("switch", { name: /without asking/ });
    expect(allow.closest("[data-no-agent]")).not.toBeNull();
    fireEvent.click(allow);
    const turnOn = await screen.findByRole("button", { name: "Turn on for Growth Analyst" });
    expect(turnOn.closest("[data-no-agent]")).not.toBeNull();
  });

  it("narrows a key's grant to one of its hosts, never to none", async () => {
    const { calls } = fakeClient();
    await mount();
    openRow("REVENUECAT_SECRET_KEY");
    const hosts = within(await screen.findByRole("dialog")).getByRole("group", { name: "Where Growth Analyst may send it" });
    const only = within(hosts).getByRole("checkbox", { name: "api.revenuecat.com" });
    expect(only).toBeDisabled();
    fireEvent.click(within(hosts).getByRole("checkbox", { name: "api2.revenuecat.com" }));
    await waitFor(() => expect(calls).toEqual([`grant:${ANALYST.id}:api.revenuecat.com,api2.revenuecat.com`]));
  });
});

describe("the team's column", () => {
  it("lists the Vault between Roles and Activity", async () => {
    const team = teamSpace(S, [ANALYST]);
    const store = createAppStore(fakeApi({ profiles: [profile("p1", "Work")], spaces: [space(S, "p1", "Versed")], teams: [team] }));
    render(<StoreContext.Provider value={store}><TeamRailList spaceId={S} team={team} tab="vault" pick={() => undefined} /></StoreContext.Provider>);
    expect(screen.getAllByRole("radio").map((r) => r.closest("label")!.textContent?.replace(/\d+$/, ""))).toEqual(["Overview", "Creators", "Roles", "Policies", "Vault", "Activity"]);
    expect(screen.getByRole("radio", { name: "Vault" })).toBeChecked();
  });
});

describe("vault-format", () => {
  it("names a use's chip by what happened", () => {
    expect(usageLine(use({ outcome: "filled", kind: "signin", secretName: "tiktok.com · nathan" })).chip).toEqual({ word: "Filled", tone: "ok" });
    expect(usageLine(use({ outcome: "refused" })).chip).toEqual({ word: "Refused", tone: "warn" });
  });

  it("says the vault's lines in the Activity feed, and how each use was let through", () => {
    const a = (verb: string, detail: Record<string, unknown>): TeamActivity => ({ id: "a", spaceId: S, ts: 1, actor: "role:x", runId: null, sessionId: null, verb, object: "REVENUECAT_SECRET_KEY", detail });
    expect(vaultSentence(a("used_secret", { kind: "key", where: "api.revenuecat.com", how: "unattended" }), "Growth Analyst"))
      .toEqual({ text: "Growth Analyst used REVENUECAT_SECRET_KEY", detail: "api.revenuecat.com · without asking" });
    expect(vaultSentence(a("allowed_unattended", { role: "Growth Analyst", hosts: ["api.revenuecat.com"] }), "You"))
      .toEqual({ text: "You let Growth Analyst use REVENUECAT_SECRET_KEY without asking", detail: "on this Mac · api.revenuecat.com" });
    expect(vaultSentence(a("approved", {}), "You")).toBeNull();
  });

  it("does not offer a used-at time for a refusal", () => {
    const { keys } = vaultEntries(LISTING.secrets, [], [], [use({ outcome: "refused", ts: 5 })], S, () => null);
    expect(keys[0]!.lastUsed).toBeNull();
  });
});
