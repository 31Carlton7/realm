import { describe, expect, it } from "vitest";
import { hideHomeFolders, scrubSecrets } from "./scrub";

/** Shapes built at run time, so no credential-looking literal sits in the repository for a scanner
 *  to flag — and so each one is exactly as long as the real thing. */
const tail = (n: number, alphabet = "aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z") => Array.from({ length: n }, (_, i) => alphabet[i % alphabet.length]).join("");

describe("scrubSecrets", () => {
  const cases: [string, string][] = [
    ["an sk-ant- API key", `key is sk-ant-api03-${tail(40)} ok`],
    ["an OpenAI project key", `OPENAI says sk-proj-${tail(48)}`],
    ["a GitHub token", `ghp_${tail(36)}`],
    ["a fine-grained GitHub token", `github_pat_${tail(70)}`],
    ["a GitLab token", `glpat-${tail(20)}`],
    ["a Slack bot token", `xoxb-${tail(12)}-${tail(12)}`],
    ["an AWS access key id", `AKIA${tail(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")}`],
    ["a Google API key", `AIza${tail(35)}`],
    ["a Stripe live key", `sk_live_${tail(24)}`],
    ["a Stripe webhook secret", `whsec_${tail(32)}`],
    ["an npm token", `npm_${tail(36)}`],
    ["a Hugging Face token", `hf_${tail(34)}`],
    ["a SendGrid key", `SG.${tail(22)}.${tail(43)}`],
    ["a JWT", `eyJ${tail(20)}.eyJ${tail(30)}.${tail(43)}`],
    ["a Slack webhook", `https://hooks.slack.com/services/T000/B000/${tail(24)}`],
  ];
  for (const [what, text] of cases) {
    it(`hides ${what}`, () => {
      const r = scrubSecrets(text);
      expect(r.hidden).toBe(1);
      expect(r.text).toContain("[hidden]");
      // Nothing of the credential's body survives.
      expect(r.text).not.toContain(tail(12));
    });
  }

  it("hides a private key block whole, header to footer", () => {
    const pem = `before\n-----BEGIN OPENSSH PRIVATE KEY-----\n${tail(64)}\n${tail(64)}\n-----END OPENSSH PRIVATE KEY-----\nafter`;
    expect(scrubSecrets(pem)).toEqual({ text: "before\n[hidden]\nafter", hidden: 1 });
  });

  it("keeps what names a secret, and hides only the secret", () => {
    expect(scrubSecrets(`curl -H "Authorization: Bearer ${tail(32)}" x`).text).toBe('curl -H "Authorization: Bearer [hidden]" x');
    expect(scrubSecrets("postgres://app:hunter2hunter@db.local/prod").text).toBe("postgres://app:[hidden]@db.local/prod");
    expect(scrubSecrets(`export DB_PASSWORD="${tail(14)}"`).text).toBe('export DB_PASSWORD="[hidden]"');
    expect(scrubSecrets(`STRIPE_SECRET_KEY=${tail(20)}`).text).toBe("STRIPE_SECRET_KEY=[hidden]");
    expect(scrubSecrets(`{"client_secret": "${tail(24)}"}`).text).toBe('{"client_secret": "[hidden]"}');
    expect(scrubSecrets(`password: '${tail(12)}'`).text).toBe("password: '[hidden]'");
  });

  it("counts a token once when its variable's name would also have caught it", () => {
    expect(scrubSecrets(`GITHUB_TOKEN=ghp_${tail(36)}`)).toEqual({ text: "GITHUB_TOKEN=[hidden]", hidden: 1 });
  });

  it("leaves what only looks random alone", () => {
    const ordinary = [
      "commit 7e91a782c0ffee1234567890abcdef1234567890",
      "id 0b9f6a7e-3c1d-4e5f-8a9b-1c2d3e4f5a6b",
      "session 01JAZ3K7Q8R9S0T1V2W3X4Y5Z6",
      "a risk-based plan with sk-learn and task-runner",
      "const token = getToken(); let password = prompt();",
      "MAX_TOKENS=8192 and MAX_TOKENS: 128000000",
      "Bearer of good news",
      "the API_KEY variable is read at boot",
      "https://example.com/path?with=query&and=more",
    ];
    for (const text of ordinary) expect(scrubSecrets(text), text).toEqual({ text, hidden: 0 });
  });

  it("writes the mark it is given", () => {
    expect(scrubSecrets(`ghp_${tail(36)}`, "\uE000").text).toBe("\uE000");
  });
});

describe("hideHomeFolders", () => {
  it("writes a home folder as ~ where a path starts", () => {
    expect(hideHomeFolders("/Users/bob/src/app.ts")).toBe("~/src/app.ts");
    expect(hideHomeFolders("cd /Users/bob && ls")).toBe("cd ~ && ls");
    expect(hideHomeFolders('open "/Users/bob.smith/a b.png"')).toBe('open "~/a b.png"');
    expect(hideHomeFolders("(/Users/bob/a)")).toBe("(~/a)");
    expect(hideHomeFolders("PATH=/Users/bob/bin:/Users/bob/.local/bin")).toBe("PATH=~/bin:~/.local/bin");
    expect(hideHomeFolders("file:///Users/bob/notes.md")).toBe("file://~/notes.md");
    expect(hideHomeFolders("/home/bob/x")).toBe("~/x");
    expect(hideHomeFolders("C:\\Users\\bob\\x")).toBe("~\\x");
    expect(hideHomeFolders("saved in /Users/bob.")).toBe("saved in ~.");
  });

  it("leaves a path that is not someone's home, and the same letters inside a URL", () => {
    expect(hideHomeFolders("/Users/Shared/Previously Relocated Items")).toBe("/Users/Shared/Previously Relocated Items");
    expect(hideHomeFolders("https://example.com/Users/bob/profile")).toBe("https://example.com/Users/bob/profile");
    expect(hideHomeFolders("src/Users/bob.ts")).toBe("src/Users/bob.ts");
  });
});
