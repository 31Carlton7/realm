import { describe, expect, it } from "vitest";
import {
  CHIP_LABEL_MAX, MAX_MENTION_REFS, MentionRefSchema, Methods, SessionEventSchema, fileLabelCandidates, isSecretPath, keepLiveRefs,
  macSkillContext, mentionRefContext, mentionRefLabel, type MentionRef,
} from "./index";

const file = (label: string, path: string): MentionRef => ({ kind: "file", label, path });
const app = (label: string, bundleId: string): MentionRef => ({ kind: "app", label, name: label, bundleId, path: `/Applications/${label}.app` });

describe("isSecretPath", () => {
  it("refuses the files that exist to hold a secret, wherever in the tree they sit", () => {
    for (const p of [".env", "apps/server/.env.local", ".env.production", ".envrc", ".npmrc", ".netrc", "deploy/server.key",
      "certs/site.pem", "id_ed25519", "config/credentials.json", "client_secret_123.apps.json", ".ssh/config", "home/.aws/config"]) {
      expect(isSecretPath(p), p).toBe(true);
    }
  });

  it("keeps templates, public halves and code ABOUT secrets", () => {
    // THE over-eager mutant: anything that sounds secret. `secrets.ts` is the code that handles them.
    for (const p of [".env.example", "apps/web/.env.sample", "id_ed25519.pub", "src/secrets.ts", "docs/environment.md", "src/.envoy.ts", "key.ts"]) {
      expect(isSecretPath(p), p).toBe(false);
    }
  });
});

describe("chip labels for named things", () => {
  it("prefers the file's name, then its parent, then a number", () => {
    expect(mentionRefLabel(fileLabelCandidates("src/auth.ts"), [])).toBe("auth.ts");
    expect(mentionRefLabel(fileLabelCandidates("src/server/auth.ts"), ["auth.ts"])).toBe("server/auth.ts");
    expect(mentionRefLabel(["Mail"], ["Mail"])).toBe("Mail 2");
  });

  it("never lets a label carry the characters that would end or split its token", () => {
    expect(mentionRefLabel(["report [draft] @v2.md"], [])).toBe("report draft v2.md");
  });

  it("makes room for a suffix on a label already at the cap", () => {
    const long = "x".repeat(CHIP_LABEL_MAX + 10);
    const first = mentionRefLabel([long], []);
    const second = mentionRefLabel([long], [first]);
    expect(second).not.toBe(first);
    expect(second.length).toBeLessThanOrEqual(CHIP_LABEL_MAX);
    expect(second.endsWith(" 2")).toBe(true);
  });

  it("keeps an entry exactly as long as its token survives in the draft", () => {
    const refs = [file("auth.ts", "/r/src/auth.ts"), app("Messages", "com.apple.MobileSMS")];
    expect(keepLiveRefs("compare @[auth.ts] and text @[Messages] ", refs)).toEqual(refs);
    expect(keepLiveRefs("compare @[auth.ts] and text Messages", refs)).toEqual([refs[0]]);
    expect(keepLiveRefs("", refs)).toEqual([]);
  });
});

describe("what the agent is told", () => {
  it("names each file against its chip, and says nothing for a message with none", () => {
    expect(mentionRefContext([])).toBe("");
    const ctx = mentionRefContext([file("auth.ts", "/r/src/auth.ts")]);
    expect(ctx).toContain("@[auth.ts] — /r/src/auth.ts");
    expect(ctx).not.toContain("computer");
  });

  it("says an app mention is computer use for THAT app, with the approval and the mode still in force", () => {
    const ctx = mentionRefContext([app("Sketch", "com.bohemian.sketch3")]);
    expect(ctx).toContain("@[Sketch] — Sketch, com.bohemian.sketch3");
    expect(ctx).toMatch(/Computer use is on for this session for these apps and no others/);
    expect(ctx).toMatch(/first action in each app waits for the user's approval/);
    expect(ctx).toMatch(/permission mode applies to every action/);
    expect(ctx).not.toContain("`mac`"); // Sketch is not one the CLI drives
  });

  it("points an app the mac CLI drives at the CLI — only when the skill is there to say how", () => {
    const refs = [app("Messages", "com.apple.MobileSMS")];
    expect(mentionRefContext(refs, { macSkill: "/home/skills/mac/SKILL.md" })).toContain("`mac messages`");
    expect(mentionRefContext(refs, { macSkill: "/home/skills/mac/SKILL.md" })).toContain("/home/skills/mac/SKILL.md");
    expect(mentionRefContext(refs, {})).not.toContain("`mac messages`");
  });

  it("hands @mac over by its instructions when it could not be invoked natively", () => {
    expect(macSkillContext("/h/skills/mac/SKILL.md")).toMatch(/Read its instructions at \/h\/skills\/mac\/SKILL\.md first/);
    expect(macSkillContext("/h/skills/mac/SKILL.md")).not.toContain("@"); // the wire carries no @name, not even Realm's
  });
});

describe("the wire", () => {
  it("accepts the three kinds and refuses a relative path or a bundle id that cannot be one", () => {
    expect(MentionRefSchema.safeParse(file("a.ts", "/r/a.ts")).success).toBe(true);
    expect(MentionRefSchema.safeParse({ kind: "library", label: "r.pdf", path: "/h/r.pdf" }).success).toBe(true);
    expect(MentionRefSchema.safeParse(app("Mail", "com.apple.mail")).success).toBe(true);
    expect(MentionRefSchema.safeParse(file("a.ts", "src/a.ts")).success).toBe(false);
    expect(MentionRefSchema.safeParse({ ...app("Mail", "com.apple.mail"), bundleId: "com.apple.mail; rm -rf" }).success).toBe(false);
  });

  it("bounds how many a message may carry, and keeps them on the transcript's user_message", () => {
    const params = Methods["sessions.send"].params;
    const refs = Array.from({ length: MAX_MENTION_REFS + 1 }, (_, i) => file(`f${i}`, `/r/f${i}`));
    expect(params.safeParse({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", text: "x", mentionRefs: refs.slice(0, MAX_MENTION_REFS) }).success).toBe(true);
    expect(params.safeParse({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", text: "x", mentionRefs: refs }).success).toBe(false);
    const ev = SessionEventSchema.parse({ type: "user_message", ts: 1, payload: { text: "x", attachments: [], refs: [refs[0]] } });
    expect(ev.type === "user_message" && ev.payload.refs).toEqual([refs[0]]);
    // An event written before mentions existed still parses.
    expect(SessionEventSchema.safeParse({ type: "user_message", ts: 1, payload: { text: "x", attachments: [] } }).success).toBe(true);
  });
});
