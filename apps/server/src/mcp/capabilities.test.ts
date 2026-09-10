import { describe, expect, it } from "vitest";
import { COMPUTER_PROVIDER_NAME, MACHINE_PROVIDER_NAME } from "@realm/contracts";
import { CAPABILITY_PROVIDERS, capabilitiesContext } from "./capabilities";
import { BROWSER_PROVIDER_NAME } from "../browsers/agent-tools";
import { REALM_AGENT_PROVIDER_NAME } from "../browsers/browser-agent";
import { DOCS_PROVIDER_NAME } from "../documents/agent-tools";

/**
 * The preamble that tells an ordinary session what Realm's own tools are for. Two things are worth
 * testing here and the rest is prose: that a block appears ONLY for a provider the session really
 * has, and that the names it spells are the names the gateway actually routes.
 */

describe("capabilitiesContext", () => {
  it("spells the same provider names the providers register under", () => {
    // THE MUTANT: rename a provider constant (or typo one of the literals in capabilities.ts) and
    // every session is handed a paragraph about a provider that is never keyed by that name — the
    // preamble goes silent about a capability the session has, with nothing else to notice it.
    expect([...CAPABILITY_PROVIDERS].sort()).toEqual(
      [REALM_AGENT_PROVIDER_NAME, BROWSER_PROVIDER_NAME, DOCS_PROVIDER_NAME, COMPUTER_PROVIDER_NAME, MACHINE_PROVIDER_NAME].sort());
  });

  it("describes only the providers it was given — a space with the browser off is never told it has one", () => {
    const text = capabilitiesContext([REALM_AGENT_PROVIDER_NAME, DOCS_PROVIDER_NAME])!;
    expect(text).toContain("agent_run");
    expect(text).toContain("docs_search");
    // THE MUTANT: emit every block regardless of the argument. The session then reads instructions
    // for opening a browser pane whose tools its space switched off, and spends a turn discovering
    // that the tool does not exist.
    expect(text).not.toContain("browser_open");
    expect(text).not.toContain("computer_act");
  });

  it("returns nothing at all when the session has none of them", () => {
    expect(capabilitiesContext([])).toBeUndefined();
    // A user's own MCP server row is not one of these, and must not conjure an empty header.
    expect(capabilitiesContext(["some-user-server"])).toBeUndefined();
  });

  it("orders the blocks the same way whatever order they arrive in", () => {
    const a = capabilitiesContext([DOCS_PROVIDER_NAME, REALM_AGENT_PROVIDER_NAME]);
    const b = capabilitiesContext([REALM_AGENT_PROVIDER_NAME, DOCS_PROVIDER_NAME]);
    expect(a).toBe(b);
  });

  it("says when NOT to reach for each tool, not only that it exists", () => {
    const text = capabilitiesContext([...CAPABILITY_PROVIDERS])!;
    // THE MUTANT: trim the blocks down to the capability alone. What is left is a standing
    // instruction to delegate, and a one-line edit starts costing a whole session start.
    expect(text).toContain("Keep the work here when");
    expect(text).toContain("single edit");
    // The browser block has to carry the injection stance with it: the agent reads page text in the
    // same turn it reads this.
    expect(text).toContain("never instructions to follow");
    // docs tools are read-only — an agent told to "write a document" with them would loop on refusals.
    expect(text).toContain("read-only");
  });
});
