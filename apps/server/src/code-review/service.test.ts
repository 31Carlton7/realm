import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type FakeScript } from "@realm/adapters";
import { PLAN_PERMISSION_MODE, REVIEW_INSTRUCTIONS_MAX, type PrReview } from "@realm/contracts";
import { createApp, type App } from "../app";
import { ProfilesStore } from "../store/profiles";
import { ProjectsStore } from "../store/projects";
import { SpacesStore } from "../store/spaces";
import { waitFor } from "../test-utils";
import { searchQuery } from "./service";
import { PATCH, fakeGh, pr, type FakeGh, type GhFixture } from "./fake-gh.test-fakes";

/**
 * The Code Review service through the real app (`createApp` + a fake `gh` + the scripted agent), the
 * way the reviewer recipe's suite drives its own. What it holds the service to: reads are cached and
 * Refresh reads again; nothing is posted that would land off the diff or on a head nobody read; the
 * instructions are a profile's own and kept as typed; a reviewer is read-only and its findings are
 * only ever findings; and a question carries the request, then carries on.
 */
let app: App | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

const ref = { owner: "acme", repo: "widgets", number: 42 };
const HEAD = "abc1234def5678abc1234def5678abc1234def56";
const FILES = [
  { filename: "src/a.ts", status: "modified", additions: 2, deletions: 1, patch: PATCH },
  { filename: "src/b.ts", status: "added", additions: 2, deletions: 0, patch: "@@ -0,0 +1,2 @@\n+one\n+two" },
];
const FIXTURE: GhFixture = {
  user: { login: "carlton" },
  sections: { authored: ["acme/widgets#42"], review: [] },
  prs: { "acme/widgets#42": pr("acme", "widgets", 42, { title: "Stream the tokenizer", files: FILES, view: { body: "Why: speed.", changedFiles: 2 } }) },
};

/** The reviewer's reply: one finding on a line the diff shows, one off it, in the shape asked for. */
const REVIEWED = "Read it.\n\n```realm-review\n" + JSON.stringify({
  summary: "Mostly right; one line is not.",
  comments: [
    { path: "src/a.ts", line: 2, side: "RIGHT", body: "Use the constant." },
    { path: "src/a.ts", line: 9, side: "RIGHT", body: "This line is not in the diff." },
  ],
}) + "\n```";
const SCRIPT: FakeScript = [
  { on: "Review pull request", emit: [{ kind: "text", text: REVIEWED }] },
  { on: "About pull request", emit: [{ kind: "text", text: "It makes the tokenizer stream." }] },
];

async function wsClient(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: any) => void>(); const events: any[] = [];
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); else events.push(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<any>((res, rej) => {
    const id = String(++n);
    pending.set(id, (v) => (v.ok ? res(v.result) : rej(Object.assign(new Error(v.error.message), { code: v.error.code }))));
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call, events, close: () => ws.close() };
}

async function boot(fixture: GhFixture = FIXTURE, home = tempDir("realm-cr-")) {
  const gh: FakeGh = fakeGh(fixture);
  const fake = new FakeAdapter({ script: SCRIPT, delayMs: 2 });
  app = await createApp({ home, port: 0, adapters: { fake }, codeReview: { gh: gh.command, timeouts: { budgetMs: 5000, pollMs: 20 } } });
  const profiles = new ProfilesStore(app.db);
  const profile = profiles.list()[0] ?? profiles.create({ name: "P", icon: "x", color: "#000" });
  const spaces = new SpacesStore(app.db, home);
  const space = spaces.list(profile.id)[0] ?? spaces.create({ profileId: profile.id, name: "S", icon: "folder" });
  return { home, gh, rpc: await wsClient(app.port), profileId: profile.id, space };
}

const ghCalls = (gh: FakeGh, pred: (args: string[]) => boolean) => gh.calls().filter((c) => pred(c.args));

describe("reads are held, and Refresh reads again", () => {
  it("serves a list from the cache inside its minute, and asks gh again when forced", async () => {
    const { gh, rpc } = await boot();
    const first = await rpc.call("codeReview.list", { section: "authored" });
    expect(first.prs.map((p: any) => p.title)).toEqual(["Stream the tokenizer"]);
    await rpc.call("codeReview.list", { section: "authored" });
    expect(ghCalls(gh, (a) => a[1] === "graphql")).toHaveLength(1);
    await rpc.call("codeReview.list", { section: "authored", force: true });
    expect(ghCalls(gh, (a) => a[1] === "graphql")).toHaveLength(2);
  });

  it("reads a request's files once per head and parses only the patches asked for", async () => {
    const { gh, rpc } = await boot();
    const files = await rpc.call("codeReview.files", { ref, headSha: HEAD });
    expect(files).toMatchObject({ headSha: HEAD, total: 2, truncated: false });
    const { patches } = await rpc.call("codeReview.patches", { ref, headSha: HEAD, paths: ["src/b.ts", "not/in/it.ts"] });
    // A path the request does not touch is left out, not answered with a patch it never had.
    expect(patches.map((p: any) => p.path)).toEqual(["src/b.ts"]);
    expect(patches[0].hunks[0].lines.map((l: any) => [l.kind, l.newLine])).toEqual([["add", 1], ["add", 2]]);
    await rpc.call("codeReview.patches", { ref, headSha: HEAD, paths: ["src/a.ts"] });
    expect(ghCalls(gh, (a) => a[1]?.includes("/files?") ?? false)).toHaveLength(1);
  });

  it("reports gh as missing where none was configured, without spawning anything", async () => {
    app = await createApp({ home: tempDir("realm-cr-none-"), port: 0, adapters: {} });
    const rpc = await wsClient(app.port);
    expect(await rpc.call("codeReview.status", {})).toEqual({ state: "missing", login: null, reason: null });
    await expect(rpc.call("codeReview.list", { section: "review" })).rejects.toMatchObject({ code: "GH_MISSING" });
  });
});

describe("searching", () => {
  it("asks GitHub for each section's own requests — the team's without those asked of me by name, so none is listed twice", async () => {
    const { gh, rpc } = await boot();
    for (const section of ["authored", "review", "team"]) await rpc.call("codeReview.list", { section });
    const queries = ghCalls(gh, (a) => a[1] === "graphql").map((c) => c.args.find((a) => a.startsWith("q="))?.slice(2));
    expect(queries).toEqual([
      "is:pr is:open archived:false author:@me sort:updated-desc",
      "is:pr is:open archived:false user-review-requested:@me sort:updated-desc",
      "is:pr is:open archived:false review-requested:@me -user-review-requested:@me sort:updated-desc",
    ]);
  });

  it("searches the requests I am part of for plain words, and takes GitHub's qualifiers as typed", () => {
    expect(searchQuery("tokenizer")).toBe("is:pr archived:false involves:@me sort:updated-desc tokenizer");
    expect(searchQuery("repo:acme/widgets parser")).toBe("is:pr repo:acme/widgets parser");
    expect(searchQuery("-author:@me draft")).toBe("is:pr -author:@me draft");
  });
});

describe("submit — nothing posted that GitHub would refuse, or that nobody read", () => {
  const review = { ref, headSha: HEAD, event: "COMMENT", body: "Looks close.", comments: [{ path: "src/a.ts", line: 2, side: "RIGHT", body: "Here." }] };
  const posts = (gh: FakeGh) => ghCalls(gh, (a) => a.includes("POST"));

  it("posts a review whose comments are on the diff", async () => {
    const { gh, rpc } = await boot();
    expect(await rpc.call("codeReview.submit", review)).toEqual({ id: 1001, url: "https://github.com/acme/widgets/pull/42#pullrequestreview-1001" });
    expect(posts(gh)).toHaveLength(1);
  });

  it("refuses a comment on a line the diff does not show before anything is sent", async () => {
    const { gh, rpc } = await boot();
    // THE MUTANT: no check, so GitHub's 422 names neither file nor line — or a LEFT/RIGHT mix-up lands.
    await expect(rpc.call("codeReview.submit", { ...review, comments: [{ path: "src/a.ts", line: 2, side: "LEFT", body: "x" }] }))
      .resolves.toBeTruthy(); // line 2 is on the base side too (the removed "two")
    await expect(rpc.call("codeReview.submit", { ...review, comments: [{ path: "src/a.ts", line: 21, side: "LEFT", body: "x" }] }))
      .rejects.toMatchObject({ code: "COMMENT_OFF_DIFF", message: expect.stringContaining("src/a.ts line 21") });
    await expect(rpc.call("codeReview.submit", { ...review, comments: [{ path: "src/zzz.ts", line: 1, side: "RIGHT", body: "x" }] }))
      .rejects.toMatchObject({ code: "COMMENT_OFF_DIFF" });
    expect(posts(gh)).toHaveLength(1);
  });

  it("refuses line comments read at a head the request has moved past", async () => {
    const { gh, rpc } = await boot();
    await expect(rpc.call("codeReview.submit", { ...review, headSha: "0000000000000000000000000000000000000000" }))
      .rejects.toMatchObject({ code: "HEAD_MOVED" });
    expect(posts(gh)).toHaveLength(0);
  });

  it("refuses a review with no comment, whatever the event", async () => {
    const { gh, rpc } = await boot();
    for (const event of ["COMMENT", "APPROVE", "REQUEST_CHANGES"]) {
      await expect(rpc.call("codeReview.submit", { ...review, event, body: "   ", comments: [] })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    }
    expect(posts(gh)).toHaveLength(0);
  });

  it("reads the request again after posting, so its reviews are the new ones", async () => {
    const { gh, rpc } = await boot();
    await rpc.call("codeReview.detail", { ref });
    await rpc.call("codeReview.submit", { ...review, comments: [] });
    await rpc.call("codeReview.detail", { ref });
    expect(ghCalls(gh, (a) => a[0] === "pr" && a[1] === "view")).toHaveLength(2);
  });
});

describe("review instructions — one set per profile, kept as typed", () => {
  it("starts empty, keeps exactly what was saved, and keeps profiles apart", async () => {
    const { rpc, profileId } = await boot();
    const other = new ProfilesStore(app!.db).create({ name: "School", icon: "x", color: "#000" });
    expect(await rpc.call("codeReview.instructions", { profileId })).toEqual({ text: "" });
    const text = "  I care most about the data model.\n\nSkip style nits.  ";
    expect(await rpc.call("codeReview.setInstructions", { profileId, text })).toEqual({ text });
    expect(await rpc.call("codeReview.instructions", { profileId })).toEqual({ text });
    expect(await rpc.call("codeReview.instructions", { profileId: other.id })).toEqual({ text: "" });
  });

  it("refuses instructions past the limit by name, and never trims them to fit", async () => {
    const { rpc, profileId } = await boot();
    await rpc.call("codeReview.setInstructions", { profileId, text: "keep me" });
    await expect(rpc.call("codeReview.setInstructions", { profileId, text: "x".repeat(REVIEW_INSTRUCTIONS_MAX + 1) }))
      .rejects.toMatchObject({ code: "INSTRUCTIONS_TOO_LONG", message: expect.stringContaining("8,000") });
    expect(await rpc.call("codeReview.instructions", { profileId })).toEqual({ text: "keep me" });
    expect(await rpc.call("codeReview.setInstructions", { profileId, text: "x".repeat(REVIEW_INSTRUCTIONS_MAX) })).toEqual({ text: "x".repeat(REVIEW_INSTRUCTIONS_MAX) });
  });

  it("are still there for the next server over the same home", async () => {
    const home = tempDir("realm-cr-home-");
    const first = await boot(FIXTURE, home);
    await first.rpc.call("codeReview.setInstructions", { profileId: first.profileId, text: "Flag missing tests." });
    await app!.close(); app = undefined;
    const second = await boot(FIXTURE, home);
    expect(await second.rpc.call("codeReview.instructions", { profileId: first.profileId })).toEqual({ text: "Flag missing tests." });
  });

  it("refuses a profile that does not exist", async () => {
    const { rpc } = await boot();
    await expect(rpc.call("codeReview.setInstructions", { profileId: "01HQ0000000000000000000000", text: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("pins", () => {
  it("keeps the newest pin first, one per request, and lets one go by its address", async () => {
    const { rpc, profileId } = await boot();
    const [row] = (await rpc.call("codeReview.list", { section: "authored" })).prs;
    await rpc.call("codeReview.setPinned", { profileId, pr: { ...row, ref: { ...row.ref, number: 7 } }, pinned: true });
    const pins = (await rpc.call("codeReview.setPinned", { profileId, pr: row, pinned: true })).pins;
    expect(pins.map((p: any) => p.ref.number)).toEqual([42, 7]);
    // Re-pinned, it moves to the top rather than appearing twice — under any casing of its name.
    const again = (await rpc.call("codeReview.setPinned", { profileId, pr: { ...row, ref: { ...row.ref, number: 7, owner: "ACME" } }, pinned: true })).pins;
    expect(again.map((p: any) => p.ref.number)).toEqual([7, 42]);
    expect((await rpc.call("codeReview.setPinned", { profileId, pr: row, pinned: false })).pins.map((p: any) => p.ref.number)).toEqual([7]);
  });
});

describe("Review with… — a read-only reviewer whose findings are only findings", () => {
  const settled = (rpc: Awaited<ReturnType<typeof wsClient>>) => async () =>
    rpc.events.some((e) => e.event === "codeReview.reviewChanged" && e.payload.review?.state === "done");

  it("runs a plan-mode session on the chosen model, under the profile's instructions, over the fenced diff", async () => {
    const { gh, rpc, profileId, space } = await boot();
    await rpc.call("codeReview.setInstructions", { profileId, text: "I care most about the data model." });
    const started: PrReview = await rpc.call("codeReview.review", { ref, profileId, spaceId: space.id, agentKind: "fake", model: "fake-pro" });
    expect(started).toMatchObject({ state: "running", headSha: HEAD, agentKind: "fake", model: "fake-pro", findings: [] });
    const session = app!.sessions.get(started.sessionId);
    // THE MUTANT: a reviewer born in the space's default mode could edit the checkout.
    expect(session.permissionMode).toBe(PLAN_PERMISSION_MODE);
    expect(session.dispatchedBy).toEqual({ sessionId: null, kind: "review" });
    expect(session.model).toBe("fake-pro");
    expect(app!.codeReview.isReviewer(session.id)).toBe(true);
    expect(app!.codeReview.extraSystemContext(session.id)).toContain("READ-ONLY");
    await waitFor(settled(rpc));
    const prompt = app!.sessions.events(session.id, 0, 100).find((e) => e.event.type === "user_message")!;
    const text = (prompt.event.payload as { text: string }).text;
    expect(text).toContain("I care most about the data model.");
    expect(text).toContain("THE PULL REQUEST'S DIFF");
    expect(text).toContain("+++ b/src/a.ts");
    // Nothing reached GitHub but reads: a finding is the person's to post.
    expect(gh.calls().some((c) => c.args.includes("POST"))).toBe(false);
  });

  it("anchors a finding to a line the diff shows, and keeps one off the diff as text", async () => {
    const { rpc, profileId, space } = await boot();
    await rpc.call("codeReview.review", { ref, profileId, spaceId: space.id, agentKind: "fake" });
    await waitFor(settled(rpc));
    const { review } = await rpc.call("codeReview.reviewGet", { ref });
    expect(review.summary).toBe("Mostly right; one line is not.");
    expect(review.findings).toEqual([
      { id: "f1", path: "src/a.ts", line: 2, side: "RIGHT", body: "Use the constant.", anchored: true },
      { id: "f2", path: "src/a.ts", line: 9, side: "RIGHT", body: "This line is not in the diff.", anchored: false },
    ]);
  });

  it("refuses an agent it cannot hold to read-only, and a second review while one runs", async () => {
    const { rpc, profileId, space } = await boot();
    await expect(rpc.call("codeReview.review", { ref, profileId, spaceId: space.id, agentKind: "acp:cursor" }))
      .rejects.toMatchObject({ code: "REVIEWER_NOT_READ_ONLY" });
    await rpc.call("codeReview.review", { ref, profileId, spaceId: space.id, agentKind: "fake" });
    await expect(rpc.call("codeReview.review", { ref, profileId, spaceId: space.id, agentKind: "fake" }))
      .rejects.toMatchObject({ code: "REVIEW_IN_FLIGHT" });
  });
});

describe("Ask about this pull request", () => {
  it("starts a session with the request attached, then carries the next question on in it", async () => {
    const { rpc, space } = await boot();
    const first = await rpc.call("codeReview.ask", { ref, spaceId: space.id, agentKind: "fake", text: "What does this change?" });
    expect(first.itemId).toEqual(expect.any(String));
    // Nothing chosen on the card is the model's own level, at its own speed.
    expect(app!.sessions.get(first.sessionId)).toMatchObject({ effort: null, fastMode: false });
    expect(await rpc.call("codeReview.thread", { ref })).toEqual({ sessionId: first.sessionId, spaceId: space.id });
    const second = await rpc.call("codeReview.ask", { ref, spaceId: space.id, agentKind: "fake", text: "And the tests?" });
    expect(second.sessionId).toBe(first.sessionId);
    await waitFor(() => app!.sessions.events(first.sessionId, 0, 100).filter((e) => e.event.type === "user_message").length === 2);
    const sent = app!.sessions.events(first.sessionId, 0, 100).filter((e) => e.event.type === "user_message").map((e) => e.event.payload as { text: string; attachments: { path: string }[] });
    // The person's words lead the transcript; the request rides as one attached file, once.
    expect(sent[0]!.text).toBe("About pull request acme/widgets#42 (attached): What does this change?");
    expect(sent[0]!.attachments).toHaveLength(1);
    expect(sent[1]).toMatchObject({ text: "And the tests?", attachments: [] });
    const context = readFileSync(sent[0]!.attachments[0]!.path, "utf8");
    expect(context).toContain("# Pull request acme/widgets#42: Stream the tokenizer");
    expect(context).toContain("Why: speed.");
    expect(context).toContain("+++ b/src/a.ts");
    expect(context).toContain("is not a checkout of acme/widgets");
  });

  it("starts the session at the level, speed and permission the prompter's card was set to", async () => {
    // Set before there was a session to set them on — the prompter holds them, and this is where they
    // land. THE MUTANT: create without them, and the card's every press is dropped at the first question.
    const { rpc, space } = await boot();
    const asked = await rpc.call("codeReview.ask", { ref, spaceId: space.id, agentKind: "fake", text: "Quick read?",
      effort: "max", fastMode: true, permissionMode: "acceptEdits" });
    expect(app!.sessions.get(asked.sessionId)).toMatchObject({ effort: "max", fastMode: true, permissionMode: "acceptEdits" });
  });

  it("says when the chosen project is a checkout of the request's repository", async () => {
    const { rpc, space, home } = await boot();
    const repo = tempDir("realm-cr-repo-");
    execFileSync("git", ["init", "-q", "-b", "feature", repo]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:Acme/Widgets.git"]);
    const project = new ProjectsStore(app!.db).create({ spaceId: space.id, name: "widgets", rootPath: repo, defaultBranch: "main" });
    void home;
    const { places } = await rpc.call("codeReview.places", { profileId: space.profileId });
    expect(places.find((p: any) => p.projectId === project.id)).toMatchObject({ repo: "Acme/Widgets", branch: "feature" });
    const asked = await rpc.call("codeReview.ask", { ref, spaceId: space.id, projectId: project.id, agentKind: "fake", text: "Is it right?" });
    expect(app!.sessions.get(asked.sessionId).cwd).toBe(repo);
    const [msg] = app!.sessions.events(asked.sessionId, 0, 100).filter((e) => e.event.type === "user_message");
    const context = readFileSync((msg!.event.payload as { attachments: { path: string }[] }).attachments[0]!.path, "utf8");
    expect(context).toContain(`runs in a checkout of Acme/Widgets at ${repo}, on branch feature`);
    expect(context).toContain("the one checked out");
  });
});
