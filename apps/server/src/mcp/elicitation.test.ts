import { describe, expect, it } from "vitest";
import type { AskCard } from "@realm/contracts";
import type { AskOutcome } from "../browsers/permissions";
import { createHubElicitation } from "./elicitation";

function setup(outcome: AskOutcome) {
  const asked: AskCard[] = [];
  const elicit = createHubElicitation({
    broker: { ask: async (_s, card) => { asked.push(card); return card.refused ? { outcome: "refused" } : outcome; } },
    serverName: () => "Linear",
  });
  const run = (params: Record<string, unknown>) => elicit({ serverId: "srv", sessionId: "s1", params: params as never, signal: new AbortController().signal });
  return { run, asked };
}
const form = { mode: "form", message: "Create the issue", requestedSchema: { type: "object", required: ["team"], properties: {
  team: { type: "string", title: "Team", oneOf: [{ const: "eng", title: "Engineering" }] }, estimate: { type: "integer", title: "Estimate" } } } };

describe("an MCP server's question, on Realm's card", () => {
  it("names the server as the server, and accepts with the form's own types", async () => {
    const { run, asked } = setup({ outcome: "answered", answers: { team: "eng", estimate: "3" } });
    expect(await run(form)).toEqual({ action: "accept", content: { team: "eng", estimate: 3 } });
    expect(asked[0]).toMatchObject({ asker: { kind: "server", name: "Linear" }, mode: "form", message: "Create the issue" });
  });

  it("declines what the user declined, and cancels what nobody answered", async () => {
    expect(await setup({ outcome: "skipped" }).run(form)).toEqual({ action: "decline" });
    expect(await setup({ outcome: "timeout" }).run(form)).toEqual({ action: "cancel" });
    expect(await setup({ outcome: "cancelled" }).run(form)).toEqual({ action: "cancel" });
  });

  it("declines a form asking for a key without the user ever seeing a field for it", async () => {
    const { run, asked } = setup({ outcome: "answered", answers: { key: "x" } });
    const credential = { mode: "form", message: "Connect", requestedSchema: { type: "object", properties: { api_key: { type: "string", title: "API key" } } } };
    expect(await run(credential)).toEqual({ action: "decline" });
    expect(asked[0]!.refused).toMatch(/password or a key/);
  });

  it("accepts a page to open as consent alone, with nothing to send back", async () => {
    const { run, asked } = setup({ outcome: "answered", answers: { url: "opened" } });
    expect(await run({ mode: "url", message: "Authorize access", url: "https://linear.app/oauth?x=1", elicitationId: "e1" })).toEqual({ action: "accept" });
    expect(asked[0]!.questions[0]).toMatchObject({ kind: "link", url: "https://linear.app/oauth?x=1" });
  });
});
