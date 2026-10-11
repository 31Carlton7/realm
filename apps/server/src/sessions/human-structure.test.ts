import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the server may say that a person sent a message, held to by reading the source as text, the
 * way `delegation/structure.test.ts` holds its own rules and with the same search.
 *
 * `human` is false unless a call site says otherwise, and the call sites that may are the two that
 * take a message from a prompter over RPC: `sessions.send` and `codeReview.ask`. Everything between
 * them and the adapter carries the value it was given, under a guard, and never writes the literal.
 * The types cannot hold that. A carrier that wrote it would mark every message that passes through
 * it, a goal's continuation and a peer's question among them, and Claude Code would take a keyword
 * in any of those for a person's. The search is over comments too, so a comment may not hold the
 * text either.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const LITERAL = "human: true";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "fixtures") out.push(...sourceFiles(p)); continue; }
    if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith("test-utils.ts")) out.push(p);
  }
  return out;
}

/** Files (relative to src/) whose text holds `needle`, comments included. */
function filesMentioning(needle: string): string[] {
  return sourceFiles(SRC)
    .filter((p) => readFileSync(p, "utf8").includes(needle))
    .map((p) => relative(SRC, p))
    .sort();
}

const source = (file: string): string => readFileSync(join(SRC, file), "utf8");
/** The one line of `rpc/methods.ts` that registers a method's handler. */
const handlerOf = (method: string): string => source("rpc/methods.ts").split("\n").find((line) => line.includes(`reg("${method}"`)) ?? "";

describe("where the server says a person sent a message", () => {
  it("writes the literal in the RPC layer and the code review service, and in no other source file", () => {
    expect(filesMentioning(LITERAL)).toEqual(["code-review/service.ts", "rpc/methods.ts"]);
  });

  it("writes it twice in the code review service, once for each of the two sends a question can take", () => {
    expect(source("code-review/service.ts").split(LITERAL)).toHaveLength(3);
  });

  it("leaves the send of a reviewer's prompt as it was, with no flag", () => {
    expect(source("code-review/service.ts")).toContain("this.d.sessions.send(session.id, { text: prompt, attachments: [] })");
  });

  it("leaves the literal a peer's question is handed over in as it was, with no flag", () => {
    expect(source("sessions/service.ts")).toContain("await handle.send({ text: msg.text, attachments: [] });");
  });

  it("has the sessions.send handler say it by name", () => {
    expect(handlerOf("sessions.send")).toContain("...(p.human ? { human: true as const } : {})");
  });

  it("has the sessions.send handler name its fields, with no spread of its params", () => {
    expect(handlerOf("sessions.send")).toMatch(/^(?!.*\.\.\.p\b).*text: p\.text, attachments: p\.attachments,/);
  });

  it("has the codeReview.ask handler pass the flag by name, with no spread of its params and not its params whole", () => {
    expect(handlerOf("codeReview.ask")).toMatch(/^(?!.*\.\.\.p\b)(?!.*ask\(p\)).*human: p\.human/);
  });
});
