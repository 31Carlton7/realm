import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PAGE_REF_IDS, dayKey, mediaUrl, type UsageRecords } from "@realm/contracts";
import { createAppStore, StoreContext } from "../../state/store";
import { emptyUsageRecords, fakeApi, item } from "../../state/store.test-fakes";
import { YouPage, dayRangeLabel } from "./YouPage";

afterEach(() => cleanup());

const DAY_MS = 86_400_000;
const today = dayKey(Date.now());
const yesterday = dayKey(Date.now() - DAY_MS);

/** A home with a real history behind it: every figure has something to say. */
const full = (extra: Partial<UsageRecords> = {}): UsageRecords => emptyUsageRecords({
  tokens: { input: 2_400_000, output: 300_000 },
  peakDay: { day: "2026-09-03", tokens: 640_000 },
  longestTurn: { ms: 74 * 60_000, endedAt: 0, sessionId: "a1", title: "Rewrite the importer", spaceId: "s1" },
  streak: { current: { days: 3, from: dayKey(Date.now() - 2 * DAY_MS), to: today }, longest: { days: 9, from: "2026-08-02", to: "2026-08-10" } },
  models: [{ key: "claude-opus-5", label: "claude-opus-5", messages: 214, sessions: 31 }],
  efforts: [{ effort: "xhigh", messages: 40, sessions: 4 }, { effort: "high", messages: 12, sessions: 2 }],
  skills: [{ name: "browsing", uses: 16 }],
  tools: [{ name: "Bash", calls: 5021 }, { name: "Read", calls: 538 }],
  ...extra,
});

async function mount(over: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi(over);
  const store = createAppStore(api);
  await store.getState().boot();
  const page = item("pg", "s1", { kind: "you-page", refId: PAGE_REF_IDS["you-page"], title: "You" });
  render(<StoreContext.Provider value={store}><YouPage item={page} visible focused /></StoreContext.Provider>);
  return { api, store };
}

/** A figure's tile, found by its label. */
const tile = (label: string) => screen.getByText(label, { selector: ".stat-label" }).closest(".stat-tile") as HTMLElement;

describe("the page about you", () => {
  it("is headed by your name, with a person in a circle until a picture is chosen", async () => {
    await mount({ usageRecords: full() });
    expect(screen.getByRole("heading", { level: 1, name: "Carlton" })).toBeInTheDocument();
    // THE mutant: the name's first letter back in the circle — the bare "C" at the foot of the rail.
    const face = document.querySelector(".you-page .page-head .avatar-placeholder")!;
    expect(face.querySelector("svg")).not.toBeNull();
    expect(face.textContent).toBe("");
    expect(screen.getByRole("button", { name: "Choose a picture…" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove picture" })).toBeNull();
  });

  it("is headed 'You' when the Mac has no real name for the account — never the login name", async () => {
    const { store } = await mount();
    act(() => store.setState({ userName: "" }));
    expect(screen.getByRole("heading", { level: 1, name: "You" })).toBeInTheDocument();
  });

  it("draws the five figures", async () => {
    await mount({ usageRecords: full() });
    await waitFor(() => expect(tile("Lifetime tokens")).toHaveTextContent("2.7M"));
    expect(tile("Lifetime tokens")).toHaveTextContent("2.4M in · 300K out");
    expect(tile("Peak day")).toHaveTextContent("640K");
    expect(tile("Peak day")).toHaveTextContent("Sep 3, 2026");
    expect(tile("Longest turn")).toHaveTextContent("1h 14m");
    expect(tile("Longest turn")).toHaveTextContent("Rewrite the importer");
    expect(tile("Current streak")).toHaveTextContent("3 days");
    expect(tile("Longest streak")).toHaveTextContent("9 days");
    expect(tile("Longest streak")).toHaveTextContent("Aug 2–10, 2026");
  });

  it("says a streak is alive through yesterday when today has nothing in it yet", async () => {
    await mount({ usageRecords: full({ streak: { current: { days: 4, from: "2026-01-01", to: yesterday }, longest: { days: 4, from: "2026-01-01", to: yesterday } } }) });
    await waitFor(() => expect(tile("Current streak")).toHaveTextContent("4 days"));
    expect(tile("Current streak")).toHaveTextContent("Through yesterday");
  });

  it("draws no token figure it cannot state, and says why instead of showing a zero", async () => {
    // Every session on an engine that reports no usage: the tokens are unknown, not none.
    await mount({ usageRecords: full({ tokens: { input: 0, output: 0 }, peakDay: null, unmeasuredSessions: 4 }) });
    await waitFor(() => expect(tile("Longest turn")).toBeInTheDocument());
    expect(screen.queryByText("Lifetime tokens")).toBeNull();
    expect(screen.queryByText("Peak day")).toBeNull();
    expect(screen.getByText(/report no token usage, so there are no token figures to show/)).toBeInTheDocument();
  });

  it("names what the lifetime figure leaves out, where some sessions could not be measured", async () => {
    await mount({ usageRecords: full({ unmeasuredSessions: 2 }) });
    await waitFor(() => expect(tile("Lifetime tokens").title).toMatch(/2 sessions on engines that report none are not in this figure/));
  });

  it("starts empty on a fresh home with zeros that are true and nothing that is not", async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/Nothing to count yet/)).toBeInTheDocument());
    expect(tile("Current streak")).toHaveTextContent("0 days");
    expect(tile("Longest streak")).toHaveTextContent("None yet");
    expect(screen.queryByText("Longest turn")).toBeNull();
    expect(screen.getByText("No agent has loaded a skill yet.")).toBeInTheDocument();
  });

  it("lists the most-used models, efforts, skills and tools", async () => {
    await mount({ usageRecords: full() });
    const most = await screen.findByRole("region", { name: "Most used" });
    const list = (title: string) => within(most).getByRole("heading", { name: title }).closest(".usage-toplist") as HTMLElement;
    expect(list("Models")).toHaveTextContent("claude-opus-5214");
    // The effort's own label, as the prompter writes it.
    expect(list("Efforts")).toHaveTextContent("XHigh40");
    expect(list("Skills")).toHaveTextContent("browsing16");
    expect(list("Tools")).toHaveTextContent("Bash5,021");
  });

  it("draws the activity calendar, with its three readings", async () => {
    await mount({ usageRecords: full() });
    expect(await screen.findByRole("radio", { name: "Cumulative" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Days you used Realm" })).toBeInTheDocument();
  });
});

describe("your picture", () => {
  it("is chosen in the native dialog, and the page shows the copy under the home — never the original", async () => {
    const original = "/Users/me/Desktop/me.png";
    const { api } = await mount({ pickIconImage: { path: original, mime: "image/png", name: "me.png", size: 2_000_000 } });
    fireEvent.click(screen.getByRole("button", { name: "Choose a picture…" }));
    await waitFor(() => expect(document.querySelector(".you-page img.avatar")).not.toBeNull());
    // Downscaled first, then handed over: the server copies what it is given.
    expect(api.calls.filter((c) => /^(pickIconImage|compressIconImage|setAvatar)/.test(c))).toEqual(["pickIconImage", "compressIconImage", `setAvatar:${original}`]);
    const src = document.querySelector<HTMLImageElement>(".you-page img.avatar")!.getAttribute("src")!;
    expect(src).toBe(mediaUrl(api.data.avatarPath!));
    expect(decodeURIComponent(src)).not.toContain("Desktop");
    expect(screen.getByRole("button", { name: "Change picture…" })).toBeInTheDocument();
  });

  it("changes nothing when the dialog is cancelled", async () => {
    const { api } = await mount({ pickIconImage: null });
    fireEvent.click(screen.getByRole("button", { name: "Choose a picture…" }));
    await waitFor(() => expect(api.calls).toContain("pickIconImage"));
    expect(api.calls.some((c) => c.startsWith("setAvatar"))).toBe(false);
    expect(document.querySelector(".you-page img.avatar")).toBeNull();
  });

  it("comes back from the home on the next launch, and goes back to the person when removed", async () => {
    const { api } = await mount({ avatarPath: "/realm-home/avatar/01J.png" });
    expect(document.querySelector<HTMLImageElement>(".you-page img.avatar")!.getAttribute("src")).toBe(mediaUrl("/realm-home/avatar/01J.png"));
    fireEvent.click(screen.getByRole("button", { name: "Remove picture" }));
    await waitFor(() => expect(document.querySelector(".you-page .avatar-placeholder")).not.toBeNull());
    expect(api.calls).toContain("clearAvatar");
    expect(screen.getByRole("button", { name: "Choose a picture…" })).toBeInTheDocument();
  });

  it("follows a picture chosen in another window", async () => {
    const { store } = await mount();
    act(() => store.getState().applyAvatarChanged("/realm-home/avatar/02K.png"));
    expect(document.querySelector<HTMLImageElement>(".you-page img.avatar")!.getAttribute("src")).toBe(mediaUrl("/realm-home/avatar/02K.png"));
  });

  it("falls back to the person when the copy will not load", async () => {
    await mount({ avatarPath: "/realm-home/avatar/gone.png" });
    fireEvent.error(document.querySelector(".you-page img.avatar")!);
    expect(document.querySelector(".you-page .avatar-placeholder svg")).not.toBeNull();
  });
});

describe("dayRangeLabel", () => {
  it("says a range as briefly as its two ends allow", () => {
    expect(dayRangeLabel("2026-08-02", "2026-08-10")).toBe("Aug 2–10, 2026");
    expect(dayRangeLabel("2026-08-30", "2026-09-02")).toBe("Aug 30 – Sep 2, 2026");
    expect(dayRangeLabel("2025-12-30", "2026-01-02")).toBe("Dec 30, 2025 – Jan 2, 2026");
    expect(dayRangeLabel("2026-08-02", "2026-08-02")).toBe("Aug 2, 2026");
  });
});
