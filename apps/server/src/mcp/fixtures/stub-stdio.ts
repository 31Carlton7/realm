/**
 * Serves `makeStubServer`'s stub over real stdio, so the one integration test in `hub.test.ts` can
 * exercise `StdioClientTransport` against an actual child process instead of only the in-memory
 * transport every other hub test uses. Everything about the tool behavior (echo/boom/failNext) lives in
 * `stub-server.ts` — this file's only job is the stdio plumbing.
 *
 * Launched via `tsx` (already a devDependency, used the same way by `scripts/live-*-check.ts`):
 *   node_modules/.bin/tsx apps/server/src/mcp/fixtures/stub-stdio.ts
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { makeStubServer } from "./stub-server";

const stub = makeStubServer();
await stub.server.connect(new StdioServerTransport());
