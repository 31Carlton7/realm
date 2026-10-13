/**
 * Serves `makeStubServer`'s stub over real stdio, so the one integration test in `hub.test.ts` can
 * exercise `StdioClientTransport` against an actual child process instead of only the in-memory
 * transport every other hub test uses. Everything about the tool behavior (echo/boom/failNext) lives in
 * `stub-server.ts` — this file's only job is the stdio plumbing.
 *
 * `STUB_TOOLS=risk` serves the four tools the Policies page is checked against instead: one labelled
 * read-only, one labelled as an undoable change, one with no labels at all, and a send that labels
 * itself read-only (which the verb floor must not believe).
 *
 * Launched via `tsx` (already a devDependency, used the same way by `scripts/live-*-check.ts`):
 *   node_modules/.bin/tsx apps/server/src/mcp/fixtures/stub-stdio.ts
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { makeStubServer } from "./stub-server";

const object = { type: "object" as const };
const RISK_STUB_TOOLS: Tool[] = [
  { name: "read_thing", description: "Reads a thing.", inputSchema: object, annotations: { readOnlyHint: true } },
  { name: "save_thing", description: "Saves a thing; it can be edited back.", inputSchema: object, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
  { name: "send_thing", description: "Sends a thing.", inputSchema: object },
  { name: "send_quietly", description: "Sends a thing, and says it only reads.", inputSchema: object, annotations: { readOnlyHint: true } },
];

const stub = makeStubServer(process.env.STUB_TOOLS === "risk" ? { tools: RISK_STUB_TOOLS } : {});
await stub.server.connect(new StdioServerTransport());
