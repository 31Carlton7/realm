import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { TeamReviewDetail, TeamReviewItem } from "@realm/contracts";
import { ReviewPane } from "./ReviewPane";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, profile, space, teamReview, teamRole, teamSpace } from "../../state/store.test-fakes";
import { numericColumns, parseDelimited, parseLinks } from "./renderers/parse";

/**
 * Review's renderers: one review per format, each drawn as what it is in the same frame under the
 * head; the text drawn once; and the person's edit before the yes. Each test names its mutant.
 */

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const it0 = (id: string, o: Partial<TeamReviewItem>): TeamReviewItem => ({
  id: `${id}-i0`, reviewId: id, version: 1, ord: 0, files: [], body: null, target: null, contentHash: "h", approvedHash: null, actState: "none",
  meta: {}, format: null, action: null, editedBy: null, ...o,
});

const detail = (id: string, title: string, items: TeamReviewItem[], over: Partial<TeamReviewDetail> = {}): TeamReviewDetail => ({
  ...teamReview(id, "s1", title, { roleName: "Writer", itemCount: items.length, kind: over.kind ?? "work" }),
  items, previous: [], costUsd: 0.2, durationMs: 60_000, runCapUsd: 3, model: "sonnet", recordName: null,
  checks: [{ ok: null, title: "Nothing leaves Realm", detail: "It names no action. Approving marks it approved." }],
  ledger: [], root: "/spaces/desk", tickets: [], fileTexts: {}, ...over,
});

async function mount(reviews: TeamReviewDetail[]) {
  const api = fakeApi({
    profiles: [profile("p1", "Work")],
    spaces: [space("s1", "p1", "Desk")],
    items: { s1: [item("i-review", "s1", { kind: "review", refId: "s1", title: "Review" })] },
    teams: [teamSpace("s1", [teamRole("r1", "s1", "Writer")], reviews.map(({ items: _i, previous: _p, costUsd: _c, durationMs: _d, runCapUsd: _r, model: _m, recordName: _n, checks: _k, ledger: _l, root: _o, fileTexts: _f, ...s }) => s))],
    teamReviews: Object.fromEntries(reviews.map((r) => [r.id, r])),
  });
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().refreshTeams();
  const it = store.getState().items.find((i) => i.kind === "review")!;
  render(<StoreContext.Provider value={store}><ReviewPane item={it} visible /></StoreContext.Provider>);
  await screen.findByRole("heading", { level: 1 });
  return { api, store };
}

const FORMATS: TeamReviewDetail[] = [
  detail("rimg", "One picture", [it0("rimg", { files: ["out/hero.png"] })]),
  detail("rpdf", "The brief", [it0("rpdf", { files: ["out/brief.pdf"] })]),
  detail("rmd", "Answer", [it0("rmd", { body: "# The answer\n\nIt is **yes**, with two sources." })]),
  detail("rmail", "Reply to Dana", [it0("rmail", { body: "Hi Dana,\nthanks for Monday.", meta: { Subject: "Following up", Due: "Tue" },
    action: { connector: "mcp:gmail", verb: "send", account: "me@versed.app", to: "dana@acme.com" } })]),
  detail("rmsg", "DM", [it0("rmsg", { body: "thanks for the repost!", action: { connector: "channel:instagram", verb: "dm", account: "@versed.nathan", to: "@reader" } })]),
  detail("rdiff", "Release notes", [it0("rdiff", { files: ["out/fix.patch"] })], { fileTexts: { "out/fix.patch": "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n" } }),
  detail("rlinks", "Reading", [it0("rlinks", { body: "- [Attention Is All You Need](https://arxiv.org/abs/1706.03762)\n- https://www.example.com/post?id=4" })]),
  detail("rtable", "Leads", [it0("rtable", { files: ["out/leads.csv"] })], { fileTexts: { "out/leads.csv": "Name,Company,Deals\nDana,Acme,3\n\"Lee, Jr\",Initech,12\n" } }),
  detail("rtext", "Note", [it0("rtext", { body: "Call Dana back on Tuesday." })]),
  detail("rfiles", "Clip", [it0("rfiles", { files: ["out/clip.mov"] })]),
];

describe("one renderer per format, in the same frame", () => {
  it.each([
    ["rimg", "images", ".rv-picture img"],
    ["rpdf", "pdf", ".rv-pdf .rv-pdf-page"],
    ["rmd", "markdown", ".rv-doc .md h1"],
    ["rmail", "email", ".rv-mail .rv-mail-head"],
    ["rmsg", "message", ".rv-message .rv-message-who"],
    ["rdiff", "diff", ".rv-diff .fd-file"],
    ["rlinks", "links", ".rv-links a.msg-chip"],
    ["rtable", "table", ".rv-table table"],
    ["rtext", "text", ".rv-text"],
    ["rfiles", "files", ".rv-files .settings-row"],
  ])("%s draws as %s", async (id, format, sel) => {
    await mount(FORMATS);
    fireEvent.click(document.querySelector(`[data-review="${id}"]`)!);
    // THE MUTANT: a registry entry pointed at another renderer, or `inferFormat` bypassed.
    await waitFor(() => expect(document.querySelector(".rv-deliverable")).toHaveAttribute("data-format", format));
    expect(document.querySelector(sel)).not.toBeNull();
  });

  it("draws an email as a mail card — from, to, subject, then the text, once — with its other meta quiet above it", async () => {
    await mount(FORMATS);
    fireEvent.click(document.querySelector('[data-review="rmail"]')!);
    await waitFor(() => expect(document.querySelector(".rv-mail")).not.toBeNull());
    const head = Object.fromEntries([...document.querySelectorAll(".rv-mail-head > div")].map((r) => [r.querySelector("dt")!.textContent, r.querySelector("dd")!.textContent]));
    expect(head).toEqual({ From: "me@versed.app", To: "dana@acme.com", Subject: "Following up" });
    expect(document.querySelector(".rv-meta-rows")).toHaveTextContent("DueTue");
    expect(document.querySelector(".rv-meta-rows")).not.toHaveTextContent("Subject");
    // THE MUTANT: `drawsBody` false for email — the text under the card again, headed Message.
    expect(screen.getAllByText(/thanks for Monday/)).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Before it can send" })).toBeInTheDocument();
  });

  it("draws an email with an attachment as the card, then the file — the text still once", async () => {
    const withFile = detail("rattach", "Invoice", [it0("rattach", { files: ["out/invoice.pdf"], body: "Invoice attached.", format: "email",
      action: { connector: "mcp:gmail", verb: "send", account: "me@versed.app", to: "ap@acme.com" } })]);
    await mount([withFile]);
    await waitFor(() => expect(document.querySelector(".rv-mail")).not.toBeNull());
    // THE MUTANT: `drawsBody` left to the no-files rule — an email with a file draws its text twice.
    expect(screen.getAllByText("Invoice attached.")).toHaveLength(1);
    expect(document.querySelector(".rv-files")).toHaveTextContent("invoice.pdf");
  });

  it("names a link by the title its line gave, and otherwise by its host and path — never by a made-up title", async () => {
    await mount(FORMATS);
    fireEvent.click(document.querySelector('[data-review="rlinks"]')!);
    await waitFor(() => expect(document.querySelectorAll(".rv-links li")).toHaveLength(2));
    const rows = [...document.querySelectorAll(".rv-links li")].map((li) => [li.querySelector("a")!.textContent, li.querySelector("a")!.getAttribute("href")]);
    expect(rows).toEqual([["Attention Is All You Need", "https://arxiv.org/abs/1706.03762"], ["example.com", "https://www.example.com/post?id=4"]]);
  });

  it("lays a CSV out as a table whose number column aligns right, head and cells alike", async () => {
    await mount(FORMATS);
    fireEvent.click(document.querySelector('[data-review="rtable"]')!);
    await waitFor(() => expect(document.querySelector(".rv-table table")).not.toBeNull());
    expect([...document.querySelectorAll(".rv-table th")].map((th) => [th.textContent, th.getAttribute("align")])).toEqual([["Name", null], ["Company", null], ["Deals", "right"]]);
    expect(document.querySelector(".rv-table tbody tr:nth-child(2) td")).toHaveTextContent("Lee, Jr");
  });

  it("gives a review with no action no promise to post or send", async () => {
    await mount(FORMATS);
    fireEvent.click(document.querySelector('[data-review="rtext"]')!);
    await waitFor(() => expect(document.querySelector(".rv-text")).not.toBeNull());
    // THE MUTANT: the legacy fallback — "Nothing posts until you approve." over a note that goes nowhere.
    expect(document.querySelector(".rv-decide-note")).toHaveTextContent("Nothing leaves Realm until you approve.");
    expect(screen.getByRole("heading", { name: "Before it can go" })).toBeInTheDocument();
  });

  it("still draws a legacy slideshow batch as its strip, with its caption headed Caption", async () => {
    const slides = ["deck/01.png", "deck/02.png", "deck/03.png"];
    const legacy = detail("rold", "6 slideshows for Nathan", [it0("rold", { files: slides, body: "caption #ad", format: "images", target: { channel: "TikTok", account: "@versed.nathan" },
      action: { connector: "channel:tiktok", verb: "post", account: "@versed.nathan", to: null, legacy: 1 } })], { kind: "slideshows", channels: ["TikTok"] });
    await mount([legacy]);
    expect(document.querySelectorAll(".rv-strip .rv-slide")).toHaveLength(3);
    expect(screen.getByRole("heading", { name: "Caption" }).nextElementSibling).toHaveTextContent("caption #ad");
    expect(document.querySelector(".rv-card .rv-meta")).toHaveTextContent("TikTok");
  });
});

describe("edit, then approve", () => {
  it("swaps the text for a field, saves it as the next version, and says the version is the person's edit", async () => {
    const { api, store } = await mount(FORMATS);
    fireEvent.click(document.querySelector('[data-review="rmail"]')!);
    await waitFor(() => expect(document.querySelector(".rv-mail")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const field = screen.getByRole("textbox", { name: "The email's text" });
    expect(screen.getByRole("button", { name: "Save edit" })).toBeDisabled();
    fireEvent.change(field, { target: { value: "Hi Dana,\nthanks for the call on Monday." } });
    fireEvent.click(screen.getByRole("button", { name: "Save edit" }));
    // THE MUTANT: Save wired to Request changes, or to nothing.
    await waitFor(() => expect(api.calls).toContain("teamReviewEditItem:rmail:rmail-i0:Hi Dana,\nthanks for the call on Monday."));
    await waitFor(() => expect(document.querySelector(".rv-version")).toHaveTextContent("Version 2, with your edit to item 1."));
    expect(document.querySelector(".rv-mail-body")).toHaveTextContent("thanks for the call on Monday.");
    expect(store.getState().teamReviewDetail["rmail"]!.items[0]!.editedBy).toBe("user");
  });

  it("leaves with Escape and changes nothing", async () => {
    const { api } = await mount(FORMATS);
    fireEvent.click(document.querySelector('[data-review="rtext"]')!);
    await waitFor(() => expect(document.querySelector(".rv-text")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "The text's text" }), { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "The text's text" })).toBeNull();
    expect(api.calls.some((c) => c.startsWith("teamReviewEditItem"))).toBe(false);
  });

  it("offers no Edit for a picture, a PDF, or anything already approved", async () => {
    const approved = detail("rdone", "Approved note", [it0("rdone", { body: "done", approvedHash: "h" })], { state: "approved" });
    await mount([...FORMATS, approved]);
    for (const [id, title] of [["rimg", "One picture"], ["rpdf", "The brief"], ["rdone", "Approved note"]] as const) {
      fireEvent.click(document.querySelector(`[data-review="${id}"]`)!);
      await waitFor(() => expect(within(document.querySelector(".rv-detail")!).getByRole("heading", { level: 1 })).toHaveTextContent(title));
      // THE MUTANT: `editable` without its state or format guard.
      expect(screen.queryByRole("button", { name: "Edit" }), id).toBeNull();
    }
  });
});

describe("the renderers' parsing", () => {
  it("reads a CSV with quotes, and a TSV", () => {
    expect(parseDelimited('a,b\n"x, y","say ""hi"""\n', ",")).toEqual([["a", "b"], ["x, y", 'say "hi"']]);
    expect(parseDelimited("a\tb\r\n1\t2", "\t")).toEqual([["a", "b"], ["1", "2"]]);
    expect(numericColumns([["n", "$"], ["a", "$1,200.50"], ["b", "12%"]])).toEqual([false, true]);
  });

  it("reads links of every shape, and refuses what is not http", () => {
    expect(parseLinks("1. <https://a.com/x>\n* javascript:alert(1)\n- [T](http://b.org)")).toEqual([
      { url: "https://a.com/x", title: null, host: "a.com", path: "/x" },
      { url: "http://b.org/", title: "T", host: "b.org", path: "" },
    ]);
  });
});
