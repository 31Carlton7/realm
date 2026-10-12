/**
 * Token shapes a memory must never hold (the spec: "No secrets"). Shapes, not values: `mcp/redact.ts`
 * scrubs secrets Realm already knows, and a token an agent was just shown is not one of them.
 */
const SECRET_SHAPES: readonly [RegExp, string][] = [
  [/\bsk-[A-Za-z0-9_-]{20,}/, "an API key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "a GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/, "a GitHub token"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, "an AWS access key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "a Google API key"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, "a JSON web token"],
];

/** What kind of secret `text` looks like it holds, or null. */
export function secretShapeIn(text: string): string | null {
  for (const [re, what] of SECRET_SHAPES) if (re.test(text)) return what;
  return null;
}
