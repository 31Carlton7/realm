/**
 * Capture the real Realm renderer for the marketing site's features carousel.
 *
 * The run is isolated from the developer's app: both Realm data and Electron user data live in a
 * disposable directory, and the process uses the documented alternate ports. The content is staged
 * through the same UI and RPC paths a user touches; only the final PNGs are kept.
 *
 *   pnpm --filter realm-site capture:product      # or: node site/scripts/capture-product.mjs
 *
 * It boots the BUILT app (`apps/desktop/out`, `apps/server/dist`), so run `pnpm build` at the repo
 * root first — a stale build reads as a live bug.
 *
 * Every capture asserts its own subject before it is written (see `shot`), so a scene that lands on
 * the wrong screen fails instead of photographing it. Scenes are independent and each is wrapped: a
 * selector that has moved loses one image and prints
 * why, rather than ending the run. What survives is written to `public/product/manifest.json`, and
 * the features page renders the intersection of that and the copy authored in `content/features.ts`
 * — so a scene that breaks silently drops out of the carousel instead of shipping a broken image.
 */
import { execFileSync, spawn } from "node:child_process"
import { connect } from "node:net"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const outputDir = path.join(repoRoot, "site/public/product")
const cdpPort = Number(process.env.REALM_CAPTURE_CDP_PORT ?? 9350)
const serverPort = Number(process.env.REALM_CAPTURE_SERVER_PORT ?? 8917)
/** A page the browser scene can point at. Realm's own site when it is running; skipped otherwise. */
const browserTarget = process.env.REALM_CAPTURE_BROWSER_URL ?? "http://localhost:3100/"
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-site-capture-"))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The staged session's title as the server has it — generated from the prompt, so never guessed. */
const stagedTitle = async (rpc, sessionId) => {
  const session = (await rpc.call("sessions.listAll", {})).find((candidate) => candidate.id === sessionId)
  if (!session?.title) throw new Error("The staged session has no title to find it by")
  return session.title
}

/**
 * Write to the scratch home's database directly, for the two things staging needs that no RPC
 * offers. Never anything but the scratch home: this is the harness's own throwaway `REALM_HOME`.
 */
const scratchSql = (sql) =>
  execFileSync("sqlite3", ["-cmd", ".timeout 5000", path.join(scratch, "home", "realm.db"), sql], { stdio: "pipe" })

/**
 * The chats every sidebar shot is taken with, and when each was last worked on.
 *
 * Spread over spaces and over the week, because the activity lens groups by day and a feed that is
 * all "Today" cannot show it; and several in the staged session's own space, because a space
 * holding one session is not a space anyone has worked in. Days back rather than hours: the lens
 * cuts on local midnight, and "three hours ago" is yesterday for a run started at one in the morning.
 */
const seededChats = [
  { space: "Product", title: "Rate-limit the public API per token", minutesAgo: 25 },
  { space: "Site", title: "Tune the hero's corridor for phones", minutesAgo: 70 },
  { space: "Realm", title: "Nest a sub-agent's calls under the one that spawned them", daysAgo: 1, at: [17, 40] },
  { space: "Product", title: "Paginate the audit log endpoint", daysAgo: 1, at: [11, 5] },
  { space: "Site", title: "Capture the features carousel from the built app", daysAgo: 2, at: [15, 20] },
  { space: "School", title: "Turn Tuesday's lecture into a study guide", daysAgo: 3, at: [20, 15] },
  { space: "Realm", title: "Profile the transcript on a ten-thousand-event session", daysAgo: 4, at: [14, 50] },
  { space: "School", title: "Check problem set 4 against the rubric", daysAgo: 5, at: [19, 30] },
  { space: "Product", title: "Move the job queue off Redis", daysAgo: 9, at: [10, 45] },
]

/** When a seeded chat was last worked on, in ms — never before today's midnight for a "today" chat. */
function lastWorked({ minutesAgo, daysAgo, at }) {
  const now = Date.now()
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  if (minutesAgo !== undefined) return Math.max(midnight.getTime() + 60_000, now - minutesAgo * 60_000)
  const day = new Date(midnight)
  day.setDate(day.getDate() - daysAgo)
  day.setHours(at[0], at[1])
  return day.getTime()
}

/**
 * The document the workspace scene opens beside the session: the design note for the very change
 * the session is making, so the hero shows a spec and the agent implementing it side by side — the
 * working relationship, not two unrelated panes that happen to share a window.
 */
const releaseBrief = `# Webhook delivery

## Why

A delivery that fails once is dropped. Most failures are a receiver restarting or a load balancer timing out, and both are gone a second later.

## What changes

- Retry 5xx responses and network errors, up to four attempts
- Back off from 250 ms to 2 s, with full jitter
- Never retry a 4xx: the request itself is wrong
- Record every attempt on the delivery, with its status

## Attempts

| Attempt | Sent after | On a 5xx |
| --- | --- | --- |
| 1 | at once | retry |
| 2 | up to 250 ms | retry |
| 3 | up to 500 ms | retry |
| 4 | up to 1 s | mark it failed |

## Rollout

Behind \`webhooks.retry\` for a week on the billing hooks, then everywhere.`

/**
 * The turn the scripted agent plays for the captures: a real-looking piece of work rather than the
 * server's UI fixtures. It reads, searches, plans, edits (which the transcript draws as diffs), writes
 * a test and runs it, revising the plan as it goes. Handed to the server as a file through
 * REALM_FAKE_AGENT_SCRIPT, whose triggers are checked before the built-in ones.
 */
const stagedPrompt = "Retry failed webhook deliveries with backoff, and cover it with tests"
const planText = [
  "## Retry webhook deliveries",
  "",
  "1. Classify failures: retry 5xx and network errors, never a 4xx.",
  "2. Back off exponentially with full jitter, capped at four attempts.",
  "3. Record each attempt on the delivery.",
  "4. Cover the backoff schedule and the 4xx short-circuit with tests.",
].join("\n")
const planSteps = (done) =>
  ["Classify failures", "Back off with jitter", "Record each attempt", "Cover it with tests"].map((text, i) => ({
    text,
    status: i < done ? "completed" : i === done ? "in_progress" : "pending",
  }))
const stagedTurn = [
  {
    on: "webhook deliveries",
    emit: [
      { kind: "text", text: "I'll look at how deliveries are sent now, then add a retry that backs off and gives up on errors a retry can't fix." },
      {
        kind: "tool",
        name: "Read",
        input: { file_path: "src/webhooks/deliver.ts" },
        result: "export async function deliver(hook: Hook, event: Event) {\n  const init = signedRequest(hook, event)\n  const res = await fetch(hook.url, init)\n  if (!res.ok) throw new DeliveryError(res.status)\n  return res\n}",
      },
      {
        kind: "tool",
        name: "Grep",
        input: { pattern: "deliver\\(", path: "src" },
        result: "src/webhooks/deliver.ts:18\nsrc/billing/invoices.ts:64\nsrc/orders/fulfilment.ts:131",
      },
      { kind: "plan", planId: "retry", text: planText, steps: planSteps(0) },
      {
        kind: "tool",
        name: "Edit",
        input: {
          file_path: "src/webhooks/deliver.ts",
          old_string: "  const res = await fetch(hook.url, init)\n  if (!res.ok) throw new DeliveryError(res.status)\n  return res",
          new_string:
            "  for (let attempt = 1; ; attempt++) {\n    const res = await fetch(hook.url, init).catch(() => null)\n    if (res?.ok) return res\n    if (res && res.status < 500) throw new DeliveryError(res.status)\n    if (attempt === MAX_ATTEMPTS) throw new DeliveryError(res?.status ?? 0)\n    await sleep(backoff(attempt))\n  }",
        },
        result: "The file src/webhooks/deliver.ts has been updated.",
      },
      { kind: "plan", planId: "retry", text: planText, steps: planSteps(2) },
      {
        kind: "tool",
        name: "Edit",
        input: {
          file_path: "src/webhooks/deliver.ts",
          old_string: "const MAX_ATTEMPTS = 4",
          new_string:
            "const MAX_ATTEMPTS = 4\n\n/** 250 ms, 500 ms, 1 s… with full jitter, never more than 2 s. */\nexport const backoff = (attempt: number) =>\n  Math.random() * Math.min(2000, 250 * 2 ** (attempt - 1))",
        },
        result: "The file src/webhooks/deliver.ts has been updated.",
      },
      { kind: "plan", planId: "retry", text: planText, steps: planSteps(3) },
      {
        kind: "tool",
        name: "Write",
        input: {
          file_path: "src/webhooks/deliver.test.ts",
          content:
            'import { describe, expect, it, vi } from "vitest"\nimport { backoff, deliver } from "./deliver"\n\ndescribe("deliver", () => {\n  it("retries a 503 and succeeds", async () => { /* … */ })\n  it("never retries a 404", async () => { /* … */ })\n  it("gives up after four attempts", async () => { /* … */ })\n})\n\ndescribe("backoff", () => {\n  it("doubles from 250 ms", () => { /* … */ })\n  it("stays inside its jitter bounds", () => { /* … */ })\n  it("never waits more than 2 s", () => { /* … */ })\n})',
        },
        result: "File created successfully at: src/webhooks/deliver.test.ts",
      },
      {
        kind: "tool",
        name: "Bash",
        input: { command: "pnpm vitest run src/webhooks" },
        result: " ✓ src/webhooks/deliver.test.ts (6 tests) 38ms\n\n Test Files  1 passed (1)\n      Tests  6 passed (6)\n   Duration  412ms",
      },
      { kind: "plan", planId: "retry", text: planText, steps: planSteps(4) },
      // The work done and the one thing left, which is what keeps the list pinned above the composer
      // — a real turn ends with something still to decide, and the strip is what shows it.
      {
        kind: "tool",
        name: "TodoWrite",
        input: {
          todos: [
            ...["Classify failures", "Back off with jitter", "Record each attempt", "Cover it with tests"].map((content) => ({
              content,
              status: "completed",
              activeForm: content,
            })),
            { content: "Open a pull request", status: "pending", activeForm: "Opening a pull request" },
          ],
        },
        result: "Todos have been modified successfully",
      },
      {
        kind: "text",
        text: "Done. `deliver()` now retries 5xx responses and network failures up to four times, backing off from 250 ms to 2 s with full jitter, and gives up at once on a 4xx — a retry won't change those. Six tests cover the schedule, the jitter bounds and the 4xx short-circuit; all pass. I haven't opened the pull request yet.",
      },
    ],
  },
]


/**
 * The space's checkout: the project the staged session is working on, so the terminal and the
 * editor show the code the transcript edited rather than a second, unrelated project.
 *
 * `src/webhooks/deliver.ts` is the file as it stood before the session — the function its Read
 * returned. The terminal scene commits these, then writes `sessionWork` over them, so `git status`
 * shows the session's work as the uncommitted change it is.
 */
const checkoutFiles = {
  "README.md": `# Product

The delivery service: every webhook signed, sent, and recorded.

    pnpm install
    pnpm test
`,
  "package.json": `{
  "name": "product",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.9.2",
    "vitest": "^3.2.4"
  }
}
`,
  "src/api/rate-limit.ts": `/** A token bucket per API token: \`limit\` requests, refilled evenly over \`windowMs\`. */
export function rateLimiter(limit: number, windowMs: number) {
  const buckets = new Map<string, { tokens: number; at: number }>()
  return (token: string, now = Date.now()): boolean => {
    const bucket = buckets.get(token) ?? { tokens: limit, at: now }
    bucket.tokens = Math.min(limit, bucket.tokens + ((now - bucket.at) / windowMs) * limit)
    bucket.at = now
    buckets.set(token, bucket)
    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    return true
  }
}
`,
  "src/webhooks/sign.ts": `import { createHmac } from "node:crypto"

/** The request a receiver can verify: the exact body, and an HMAC of it under the hook's secret. */
export function signedRequest(hook: Hook, event: Event): RequestInit {
  const body = JSON.stringify(event)
  const signature = createHmac("sha256", hook.secret).update(body).digest("hex")
  return {
    method: "POST",
    headers: { "content-type": "application/json", "x-webhook-signature": \`sha256=\${signature}\` },
    body,
  }
}
`,
  "src/webhooks/deliver.ts": `import { sleep } from "../lib/time"
import { signedRequest } from "./sign"

const MAX_ATTEMPTS = 4

export class DeliveryError extends Error {
  constructor(readonly status: number) {
    super(\`Webhook delivery failed with \${status}\`)
  }
}

export async function deliver(hook: Hook, event: Event) {
  const init = signedRequest(hook, event)
  const res = await fetch(hook.url, init)
  if (!res.ok) throw new DeliveryError(res.status)
  return res
}
`,
  "src/lib/time.ts": `export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
`,
}

/**
 * What the staged session leaves in the checkout, derived from its own tool calls rather than
 * written out a second time: its Edits applied in order to the file it Read, and the test it Wrote.
 * A terminal diff that disagreed with the transcript beside it would be the one capture anyone
 * checked.
 */
const sessionWork = (() => {
  const calls = stagedTurn[0].emit.filter((step) => step.kind === "tool")
  const edited = calls
    .filter((call) => call.name === "Edit")
    .reduce((text, { input }) => {
      if (!text.includes(input.old_string)) throw new Error(`A staged edit does not apply: ${input.old_string}`)
      return text.replace(input.old_string, input.new_string)
    }, checkoutFiles["src/webhooks/deliver.ts"])
  const written = calls.find((call) => call.name === "Write")
  return { "src/webhooks/deliver.ts": edited, [written.input.file_path]: `${written.input.content}\n` }
})()

/** Write files under the checkout, creating their folders. Existing files are left alone unless asked. */
function writeCheckout(checkout, files, { overwrite = false } = {}) {
  for (const [relative, text] of Object.entries(files)) {
    const target = path.join(checkout, relative)
    if (!overwrite && fs.existsSync(target)) continue
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, text)
  }
}

/** The staged session's working directory, which is the space's checkout. */
const checkoutOf = async (rpc, sessionId) => {
  const session = (await rpc.call("sessions.listAll", {})).find((candidate) => candidate.id === sessionId)
  if (!session?.cwd) throw new Error("The staged session has no working directory")
  return session.cwd
}

let electron = null
/** The live RPC client, so the shutdown at the bottom of the file can reach the server. */
let liveRpc = null

/** Ask realm-server to stop the way the product asks, and wait for the port to actually go quiet. */
async function stopDaemon() {
  if (!liveRpc) return
  await liveRpc.call("daemon.stop", {}).catch(() => null)
  liveRpc.close()
  liveRpc = null
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await portIsFree(serverPort)) return
    await sleep(250)
  }
  console.warn(`  realm-server is still on ${serverPort} after daemon.stop`)
}

async function portIsFree(port) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" })
    socket.once("connect", () => {
      socket.destroy()
      resolve(false)
    })
    socket.once("error", () => resolve(true))
  })
}

async function until(read, timeout, label) {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`)
    await sleep(150)
  }
}

function connectCdp(url) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let id = 0
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data)
    if (message.id === undefined) return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result)
  })
  return {
    ready: new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve)
      socket.addEventListener("error", reject)
    }),
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const requestId = ++id
        pending.set(requestId, { resolve, reject })
        socket.send(JSON.stringify({ id: requestId, method, params }))
      })
    },
    close: () => socket.close(),
  }
}

/**
 * The RPC socket now takes a token, and it travels as the WebSocket subprotocol `realm.<token>` —
 * the one channel both `ws` and a browser can set (apps/server/src/rpc/server.ts). realm-server mints
 * it at boot and writes it to `daemon.json` under REALM_HOME, which is the only place it exists; an
 * untokened upgrade is refused with a non-101 and reads here as an unexplained network error.
 */
function connectRpc(port, token) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, [`realm.${token}`])
  const pending = new Map()
  let id = 0
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data)
    if (message.id === undefined) return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.ok) request.resolve(message.result)
    else request.reject(new Error(message.error?.message ?? "RPC failed"))
  })
  return {
    ready: new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve)
      socket.addEventListener("error", reject)
    }),
    call(method, params) {
      return new Promise((resolve, reject) => {
        const requestId = String(++id)
        pending.set(requestId, { resolve, reject })
        socket.send(JSON.stringify({ id: requestId, method, params }))
      })
    },
    close: () => socket.close(),
  }
}

const helpers = String.raw`
window.__capture = window.__capture ?? {
  setInput(element, value) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  },
  clickText(selector, text) {
    const element = [...document.querySelectorAll(selector)]
      .find((candidate) => candidate.textContent.trim().startsWith(text));
    if (!element) return false;
    element.click();
    return true;
  },
  key(key, options = {}) {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...options }));
  },
  /**
   * What surface is actually on screen, as the app itself names it.
   *
   * Every page pane carries its own class (connections-page-pane, schedules-page, ...) and its own
   * heading in .page-title h1. A bare .page carries neither, which is why waiting on one is not
   * waiting for anything in particular.
   */
  onPage(kind, heading, tab) {
    const page = document.querySelector("." + kind);
    if (!page || page.offsetParent === null) return false;
    if (heading !== undefined && page.querySelector(".page-title h1")?.textContent.trim() !== heading) return false;
    if (tab === undefined) return true;
    const selected = page.querySelector(".page-rail-tab[data-selected]");
    return !!selected && selected.textContent.trim().startsWith(tab);
  },
  /** Everything a failed expectation should say, so the log names the screen it found instead. */
  onScreen() {
    const page = document.querySelector(".page");
    const title = page?.querySelector(".page-title h1")?.textContent.trim();
    const panes = [...document.querySelectorAll(".panehost .panel")].length;
    return [
      page ? "page " + page.className + (title ? " titled “" + title + "”" : "") : "no page pane",
      page?.querySelector(".page-rail-tab[data-selected]")
        ? "tab " + page.querySelector(".page-rail-tab[data-selected]").textContent.trim()
        : null,
      document.querySelector(".documents-code") ? "code editor" : null,
      document.querySelector(".documents-pane") ? "documents pane" : null,
      document.querySelector(".xterm") ? "terminal" : null,
      document.querySelector(".transcript") ? "transcript" : null,
      document.querySelector(".palette") ? "palette open" : null,
      document.querySelector(".page-overlay")
        ? "overlay “" + document.querySelector(".page-overlay").getAttribute("aria-label") + "”"
        : "no page overlay",
      [...document.querySelectorAll("[role=\"dialog\"]")].map((d) => d.getAttribute("aria-label") || "(unlabelled)")
        .join(" + ") || null,
      panes + " pane(s)",
    ].filter(Boolean).join("; ");
  },
};
void 0`

function makeContext(page, rpc) {
  const evaluate = async (expression) => {
    const result = await page.send("Runtime.evaluate", {
      expression: `${helpers};\n${expression}`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    }
    return result.result.value
  }

  const clickText = async (selector, text, label = text) => {
    const clicked = await evaluate(`__capture.clickText(${JSON.stringify(selector)}, ${JSON.stringify(text)})`)
    if (!clicked) throw new Error(`No ${selector} reading “${label}”`)
    return true
  }

  /**
   * A real key event through the input pipeline, not a synthesised `KeyboardEvent`.
   *
   * The command palette closes on Escape and a dispatched event never closed it: the handler is on
   * the window's real key stream, which `new KeyboardEvent(...)` does not reach. Everything that
   * types goes through here now, so what the capture drives is what a keyboard drives.
   */
  const press = async (key, { code = key, vk, meta = false, shift = false } = {}) => {
    const modifiers = (meta ? 4 : 0) | (shift ? 8 : 0)
    const common = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
    await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...common })
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...common })
  }

  /** Open ⌘K and take the row whose label starts with `label`, then wait for the palette to leave. */
  const command = async (label) => {
    await evaluate(`document.activeElement?.blur?.(); true`)
    await press("k", { code: "KeyK", vk: 75, meta: true })
    await until(() => evaluate(`!!document.querySelector('.palette')`), 8_000, "the command palette")
    await clickText(".palette-opt", label)
    await until(() => evaluate(`!document.querySelector('.palette')`), 8_000, "the palette to close")
    await sleep(400)
  }

  /**
   * Back to one pane. Scenes leave panes behind — that is what a workspace does — but a screenshot
   * of ONE surface should not also be showing the three before it. "Layout: 1-up" is not this: it
   * lays every open item into columns, which is the opposite. One pane, not none: closing the last
   * one makes the app open a fresh session, which is a worse leftover than the one being removed.
   */
  const solo = async () => {
    // A page over the pane host is not "one pane" either, and every scene that opens one opens it
    // after this. Closing it here also means a page scene that fails does not leave its page sitting
    // over the sidebar scenes at the end of the run.
    await closePage()
    await evaluate(`document.querySelector('button[aria-label^="Unfocus"]')?.click(); true`)
    await sleep(300)
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const panes = await evaluate(`document.querySelectorAll('.panehost .panel').length`)
      if (panes <= 1) return
      await command("Close pane")
      await sleep(450)
    }
  }

  /**
   * Select a rail tab and prove it took: the first click after a page mounts gets dropped.
   *
   * The proof reads the CLICKED tab's own `data-selected`, not the document's first selected tab.
   * Two rails can be mounted at once — a space page in one pane and Settings in another — and asking
   * the document for "the selected tab" then answers with whichever rail comes first in the DOM,
   * which is not the one being driven. That made every `tab()` call fail for the rest of a run as
   * soon as any scene left a space page open, and the failure read as "Settings never selected", a
   * page that was in fact perfectly fine.
   */
  const tab = async (label) => {
    const find = `[...document.querySelectorAll('.page-rail-tab')]
      .find((candidate) => candidate.textContent.trim().startsWith(${JSON.stringify(label)}))`
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await evaluate(`(() => {
        const element = ${find};
        if (!element) return false;
        (element.querySelector('input') ?? element).click();
        return true;
      })()`)
      await sleep(450)
      if (await evaluate(`(() => { const element = ${find}; return element ? element.hasAttribute('data-selected') : false; })()`)) return
    }
    const seen = await evaluate(`[...document.querySelectorAll('.page-rail-tab')].map((t) => t.textContent.trim()).join(' | ')`)
    throw new Error(`never selected the ${label} tab — rails on screen: ${seen || "(none)"}`)
  }

  /**
   * Fill the host with the focused pane — the app's own ⌘⇧F, so what it leaves on screen is real.
   *
   * Not fatal. A scene whose surface already fills the host is still worth capturing, and the
   * palette only offers the action when there is more than one pane to fill over.
   */
  const focusPane = async () => {
    /*
     * A page already covers the pane host, so there is nothing here to fill — and asking anyway was
     * the bug that put the code editor under four different captions.
     *
     * The palette has no row starting with "Focus " while a page is up, so the fallback below threw,
     * and its old `.catch(() => escape())` then pressed Escape — which a page overlay listens for,
     * being `role="dialog"`. Every page scene therefore opened its page, passed the wait, and closed
     * it again one line before the screenshot. The capture was of whatever the last pane scene had
     * left behind, and nothing in the run could tell.
     */
    if (await evaluate(`!!document.querySelector('.page-overlay')`)) return
    if (await evaluate(`!!document.querySelector('button[aria-label^="Unfocus"]')`)) return
    const viaBar = await evaluate(`(() => {
      const button = document.querySelector('.panel-bar button[aria-label^="Focus"]');
      if (!button) return false;
      button.click();
      return true;
    })()`)
    if (!viaBar) {
      // The palette is already open when this throws, and leaving it open puts a dialog over the
      // next scene's subject. Dismiss the PALETTE, not "whatever is on top" — see above.
      await command("Focus ").catch(() => dismissPalette())
    }
    await sleep(500)
  }

  /** Escape until the palette is gone, and stop there. Anything under it is somebody's subject. */
  const dismissPalette = async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!(await evaluate(`!!document.querySelector('.palette')`))) return
      await press("Escape", { vk: 27 })
      await sleep(300)
    }
  }

  /** Put away an app-level page. It answers to Escape because it is a `role="dialog"`. */
  const closePage = async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!(await evaluate(`!!document.querySelector('.page-overlay')`))) return
      await press("Escape", { vk: 27 })
      await sleep(350)
    }
  }

  const escape = async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await press("Escape", { vk: 27 })
      await sleep(350)
      if (!(await evaluate(`!!document.querySelector('.palette, [role="dialog"]')`))) return
    }
  }

  /**
   * Write one capture — but only once the screen has proved it is the subject.
   *
   * `expect` is not optional, and that is the point. Four slides once shipped as the same photograph
   * of the code editor: a scene that failed to change screens left the app wherever the last one had
   * put it, the scenes after it waited on `.page` — already satisfied by the page that was hanging
   * around — and so they reported `✓` while photographing somebody else's subject. Nothing about a
   * generic wait can catch that, because a generic wait is the bug. A capture now asserts the thing
   * its caption will claim, in the same frame it is taken, and a scene that cannot get there fails
   * loudly and drops out of the manifest rather than overwriting a good file with a wrong one.
   */
  const shot = async (name, expect) => {
    if (typeof expect !== "string" || !expect.trim()) {
      throw new Error(`shot("${name}") was given no expectation — every capture must prove its subject`)
    }
    // Belt as well as the observer staging installs: a shot taken in the same frame as a re-render
    // should not be the one that publishes the developer's computer name.
    await evaluate(`window.__realmScrub?.(); true`)
    await sleep(350)
    if (!(await evaluate(expect))) {
      throw new Error(`${name}: expected ${expect} — on screen instead: ${await evaluate(`__capture.onScreen()`)}`)
    }
    const result = await page.send("Page.captureScreenshot", { format: "png", fromSurface: true })
    fs.mkdirSync(outputDir, { recursive: true })
    fs.writeFileSync(path.join(outputDir, `${name}.png`), Buffer.from(result.data, "base64"))
  }

  return { evaluate, clickText, closePage, command, dismissPalette, escape, focusPane, press, solo, tab, shot, rpc, sleep, until }
}

/**
 * Every scene leaves the app in a state the next one can start from, so the order is part of the
 * script rather than incidental: the session is staged first because half the later scenes are
 * drawn over it.
 */
const scenes = [
  {
    name: "session",
    async run({ evaluate, shot, until }) {
      await until(
        () => evaluate(`document.querySelectorAll('.transcript .plan-card, .transcript [data-plan-id]').length > 0`),
        30_000,
        "the session plan",
      )
      // Open the calls that did the editing, and the first edit in them: the claim is that a diff
      // renders as a diff, and a capture of the folded row is evidence of the folding only.
      await evaluate(`(() => {
        const groups = [...document.querySelectorAll('.transcript .tool-group-row')];
        // Its title reads like "5 tools · 2 files · 1 command": only the editing group ran one.
        const edits = groups.find((row) => /command/.test(row.getAttribute('title') ?? '')) ?? groups.at(-1);
        if (edits && edits.getAttribute('aria-expanded') !== 'true') edits.click();
        return true;
      })()`)
      await sleep(500)
      await evaluate(`(() => {
        const edit = document.querySelector('.transcript .tool-row[aria-label="Edit tool call"]');
        if (edit && edit.getAttribute('aria-expanded') !== 'true') edit.click();
        return true;
      })()`)
      await sleep(900)
      // Then bring the opened turn — "Worked for", its calls, the diff — up to the top. At rest the
      // transcript sits at its end, which cut the diff off above the fold: a diff without its header
      // is some green lines.
      const placed = await evaluate(`(() => {
        const scroller = document.querySelector('.transcript');
        const group = document.querySelector('.transcript .tool-group-row[aria-expanded="true"]');
        if (!scroller || !group) return false;
        scroller.scrollTop += group.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16;
        return true;
      })()`)
      if (!placed) throw new Error("No opened tool group to bring into view")
      await sleep(700)
      await shot(
        "session",
        `(() => {
          const view = document.querySelector('.transcript')?.getBoundingClientRect();
          const edit = document.querySelector('.transcript .tool-row[aria-label="Edit tool call"][aria-expanded="true"]')?.getBoundingClientRect();
          return !!view && !!edit && edit.top >= view.top && edit.bottom <= view.bottom;
        })()`,
      )
    },
  },
  {
    name: "palette",
    async run({ evaluate, escape, press, shot, until }) {
      await escape()
      await press("k", { code: "KeyK", vk: 75, meta: true })
      await until(() => evaluate(`!!document.querySelector('.palette')`), 8_000, "the command palette")
      await sleep(500)
      await shot("palette", `!!document.querySelector('.palette .palette-opt')`)
      await escape()
    },
  },
  {
    name: "models",
    async run({ evaluate, clickText, command, escape, solo, shot, until, rpc, sessionId }) {
      await escape()
      // A fresh session, because one that has already run is held to its agent (`sessions.setAgent`
      // refuses it), and this surface is about choosing among all of them.
      const spaceId = (await rpc.call("spaces.list", {}))[0].id
      const before = new Set((await rpc.call("sessions.list", { spaceId })).map((session) => session.id))
      await solo()
      await command("New session")
      await until(() => evaluate(`!!document.querySelector('.composer')`), 15_000, "a new session")
      await sleep(900)
      const opened = await evaluate(`(() => {
        const chip = document.querySelector('.composer-controls [data-model-chip], .composer button[aria-label*="Model"], .composer-controls button');
        if (!chip) return false;
        chip.click();
        return true;
      })()`)
      if (!opened) throw new Error("No model chip in the composer")
      await until(
        () => evaluate(`!!document.querySelector('.model-picker, [role="dialog"][aria-label*="odel"], .menu[role="menu"]')`),
        8_000,
        "the model picker",
      )
      // Narrow to one maker, so the detail pane is showing a model rather than the scripted adapter
      // the capture runs on.
      await evaluate(`__capture.clickText('.model-picker button, [role="dialog"] button', 'Claude')`)
      await sleep(700)
      await shot("models", `!!document.querySelector('.model-picker, [role="dialog"][aria-label*="odel"], .menu[role="menu"]')`)
      await escape()
      // That session was a stand for the picker and nothing more. Left behind it is an untitled "New
      // session" in every sidebar shot after this one, so the staged run goes back into the pane —
      // deleting the session a pane is showing would close the last pane, and the app answers that by
      // opening another fresh one — and then the stand is deleted.
      const title = await stagedTitle(rpc, sessionId)
      await evaluate(`(() => {
        const row = [...document.querySelectorAll('.sidebar button, .sidebar [role="button"]')]
          .find((element) => element.textContent.includes(${JSON.stringify(title)}));
        row?.click();
        return true;
      })()`)
      await sleep(900)
      for (const session of await rpc.call("sessions.list", { spaceId })) {
        if (before.has(session.id)) continue
        await rpc.call("sessions.delete", { id: session.id }).catch((error) => console.warn(`    sessions.delete: ${error.message}`))
      }
      await sleep(600)
    },
  },
  {
    name: "documents",
    async run({ evaluate, clickText, command, solo, shot, until }) {
      await solo()
      await command("Documents")
      await until(() => evaluate(`!!document.querySelector('.documents-pane')`), 20_000, "the documents pane")
      await evaluate(`document.querySelector('.documents-new').click(); true`)
      await until(() => evaluate(`!!document.querySelector('.menu [role="menuitem"]')`), 8_000, "the document menu")
      await evaluate(`__capture.clickText('.menu [role="menuitem"]', 'New document')`)
      await until(() => evaluate(`!!document.querySelector('.documents-name-input')`), 15_000, "the new document")
      await evaluate(`(() => {
        const name = document.querySelector('.documents-name-input');
        __capture.setInput(name, 'Webhook delivery');
        name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return true;
      })()`)
      await until(() => evaluate(`!!document.querySelector('[aria-label="Rich text editor"]')`), 15_000, "the editor")
      await evaluate(`__capture.clickText('.documents-modes button', 'Source')`)
      await until(() => evaluate(`!!document.querySelector('.documents-source')`), 8_000, "source mode")
      await evaluate(`(() => {
        const source = document.querySelector('.documents-source');
        __capture.setInput(source, ${JSON.stringify(releaseBrief)});
        return true;
      })()`)
      await sleep(1_000)
      await evaluate(`__capture.clickText('.documents-modes button', 'Rich')`)
      await until(
        () => evaluate(`document.querySelector('[aria-label="Rich text editor"] h1')?.textContent === 'Webhook delivery'`),
        15_000,
        "the rich document",
      )
      await sleep(600)
      await shot("documents", `document.querySelector('[aria-label="Rich text editor"] h1')?.textContent === 'Webhook delivery'`)
    },
  },
  {
    name: "workspace",
    async run({ evaluate, command, shot, until, rpc, sessionId }) {
      await command("Split right")
      await until(() => evaluate(`document.querySelectorAll('.panehost .panel').length === 2`), 10_000, "two panes")
      // The new pane is focused and empty; put the staged session into it, so the split shows the
      // relationship the page claims — a run and the document beside it. Matching on the title
      // matters: the space holds the seeded chats too, and any of them is what a
      // first-not-the-document rule would find. The title is generated from the staged prompt, so it
      // is asked for rather than guessed — and the open document shares the session's subject, so a
      // match on the subject alone could click the document instead.
      const title = await stagedTitle(rpc, sessionId)
      const opened = await evaluate(`(() => {
        const row = [...document.querySelectorAll('.sidebar button, .sidebar [role="button"]')]
          .find((element) => element.textContent.includes(${JSON.stringify(title)}));
        if (!row) return false;
        row.click();
        return true;
      })()`)
      if (!opened) throw new Error("No sidebar row for the staged session")
      await sleep(1_200)
      await shot("workspace", `document.querySelectorAll('.panehost .panel').length === 2 && !!document.querySelector('.documents-pane') && !!document.querySelector('.transcript')`)
    },
  },
  {
    name: "terminal",
    async run({ evaluate, command, solo, shot, rpc, until, sessionId }) {
      await solo()
      await command("New terminal")
      await until(() => evaluate(`!!document.querySelector('.xterm')`), 20_000, "the terminal")
      // A shell prompt on its own is not evidence of a terminal pane. The item's refId IS the
      // terminal id, so the same pty the pane is showing can be written to directly.
      const terminals = await rpc.call("items.listAll", {})
      const pty = terminals.find((item) => item.kind === "terminal")
      if (!pty) throw new Error("No terminal item to type into")
      const type = (data) => rpc.call("terminals.write", { terminalId: pty.refId, data })
      // The project's history is made in this shell and then cleared, so what the pane shows is
      // someone looking at their checkout rather than the harness building one. It is also what
      // makes the folder a git checkout for the editor scene after this. `;` rather than `&&`: a
      // step that fails must not stop the chain before the `clear`.
      const checkout = await checkoutOf(rpc, sessionId)
      writeCheckout(checkout, checkoutFiles)
      const commit = (paths, message) =>
        `git add ${paths}; git -c user.name=Product -c user.email=dev@example.com commit -qm '${message}'`
      await type(
        [
          "git init -q",
          commit("README.md package.json src/lib", "Start the delivery service"),
          commit("src/webhooks", "Sign each delivery with its hook secret"),
          commit("src/api", "Rate-limit the public API per token"),
          commit("'Webhook delivery.md'", "Write up retrying failed deliveries"),
          "clear",
        ].join("; ") + "\r",
      )
      await sleep(2_500)
      // Then the session's work lands on top, uncommitted, and the shell is asked what changed.
      // --no-pager: git's default pager clears the screen and leaves (END) on it. And deliberately
      // no `ls -la`: its owner column publishes the developer's system username.
      writeCheckout(checkout, sessionWork, { overwrite: true })
      for (const line of ["git --no-pager log --oneline --decorate -4", "git status --short", "git --no-pager diff"]) {
        await type(`${line}\r`)
        await sleep(900)
      }
      await sleep(1_000)
      await shot("terminal", `!!document.querySelector('.xterm')`)
    },
  },
  {
    // After the terminal, which is what makes the space's folder a git checkout: ⌘P and ⌘⇧P fall
    // back to a directory walk outside a repository, and a capture of the fallback under a caption
    // about `git grep` would be showing the weaker search.
    name: "editor",
    async run({ evaluate, command, escape, focusPane, press, solo, shot, rpc, until, sessionId }) {
      await solo()
      await command("Documents")
      await until(() => evaluate(`!!document.querySelector('.documents-pane')`), 20_000, "the documents pane")
      const spaces = await rpc.call("spaces.list", {})
      const spaceId = spaces[0].id
      // The terminal scene wrote the checkout; this only fills in what is missing, so a diagnostic
      // run of this scene alone still has files to find.
      writeCheckout(await checkoutOf(rpc, sessionId), checkoutFiles)
      // The file the staged session edited, as it left it.
      await rpc.call("documents.openPath", { spaceId, path: "src/webhooks/deliver.ts" })
      // `.cm-content` rather than the editor's `aria-label`: the label is set once the file's
      // language mode has loaded, so waiting on it is waiting on a dynamic import.
      await until(() => evaluate(`!!document.querySelector('.documents-code .cm-content')`), 20_000, "the code editor")
      await focusPane()
      // ⌘P has no palette row — the keymap is the only way in — so it goes through the real key
      // stream like everything else that types. An empty query is legal there and means "the first
      // files in the checkout", which is what the finder shows before a keystroke.
      await evaluate(`document.activeElement?.blur?.(); true`)
      await press("p", { code: "KeyP", vk: 80, meta: true })
      await until(() => evaluate(`!!document.querySelector('.palette-opt')`), 10_000, "the file finder")
      await sleep(600)
      await shot("editor", `!!document.querySelector('.documents-code .cm-content') && !!document.querySelector('.palette-opt')`)
      await escape()
    },
  },
  {
    // NOTE: there is deliberately no browser scene. The browser pane is a native `WebContentsView`,
    // and `Page.captureScreenshot` on the renderer cannot see its pixels — a capture of it is an
    // empty rectangle where the page should be. Showing that would be worse than not showing it.
    name: "spaces",
    async run({ evaluate, command, focusPane, solo, shot, until }) {
      await solo()
      await command("Open space")
      await until(() => evaluate(`__capture.onPage('space-page-pane')`), 15_000, "the space page")
      await focusPane()
      await sleep(900)
      await shot("spaces", `__capture.onPage('space-page-pane')`)
    },
  },
  {
    // The space page again, a tab along. Like the Settings run below, the page is opened once and
    // the two scenes after it only change tabs — `Open space` lands on whichever tab was last
    // selected, so `spaces` above has to come first or it captures this one's.
    name: "commands",
    async run({ evaluate, command, focusPane, solo, tab, shot, rpc, until }) {
      const spaces = await rpc.call("spaces.list", {})
      const spaceId = spaces[0].id
      const scripts = [
        { id: null, name: "Test", command: "pnpm -r test", cwd: null },
        { id: null, name: "Typecheck", command: "pnpm -r typecheck", cwd: null },
        // No `cwd` on any of them: a relative folder is resolved against the space's own folder, and
        // naming one this staged space does not have would put a script in the shot that cannot run.
        { id: null, name: "Dev server", command: "pnpm dev --port 3100", cwd: null },
      ]
      for (const script of scripts) {
        await rpc.call("scripts.save", { spaceId, script }).catch((error) => {
          console.warn(`    scripts.save ${script.name}: ${error.message}`)
        })
      }
      await solo()
      await command("Open space")
      await until(() => evaluate(`__capture.onPage('space-page-pane')`), 15_000, "the space page")
      await focusPane()
      await tab("Scripts")
      await until(() => evaluate(`document.querySelectorAll('.settings-list .settings-row').length > 0`), 10_000, "the scripts list")
      await sleep(900)
      await shot("commands", `__capture.onPage('space-page-pane') && document.querySelectorAll('.settings-list .settings-row').length > 0`)
    },
  },
  {
    name: "sandbox",
    async run({ evaluate, tab, shot, until }) {
      await tab("Sandbox")
      // Left at the posture it ships with. The panel states that posture itself, and turning it on
      // here would put a Seatbelt policy under every terminal the rest of the run opens.
      await until(() => evaluate(`!!document.querySelector('.sandbox-choice')`), 10_000, "the sandbox postures")
      await sleep(900)
      await shot("sandbox", `__capture.onPage('space-page-pane') && !!document.querySelector('.sandbox-choice')`)
    },
  },
  {
    name: "rewind",
    async run({ evaluate, clickText, escape, tab, shot, until }) {
      await tab("History")
      const opened = await evaluate(`(() => {
        const row = document.querySelector('.page-content button.page-row[aria-label*="open checkpoints"]');
        if (!row) return false;
        row.click();
        return true;
      })()`)
      if (!opened) throw new Error("No checkout on the History tab to open checkpoints for")
      await until(() => evaluate(`!!document.querySelector('.cp-list .cp-row')`), 15_000, "the checkpoints")
      await clickText(".cp-row button", "Restore")
      await until(() => evaluate(`!!document.querySelector('.cp-hazard')`), 10_000, "the restore confirmation")
      // The sentence this scene exists to show. A checkpoint with no provider cursor behind it says
      // the opposite — "Files only" — and that is the honest answer for it, so the scene fails here
      // and drops out rather than publishing a screenshot its caption contradicts.
      const rewinds = await evaluate(
        `[...document.querySelectorAll('.cp-note')].some((note) => note.textContent.includes('The conversation rewinds too'))`,
      )
      if (!rewinds) throw new Error("This checkpoint restores files only — there is no conversation rewind to show")
      await sleep(600)
      await shot("rewind", `__capture.onPage('space-page-pane') && !!document.querySelector('.cp-hazard')`)
      await escape()
    },
  },
  {
    name: "library",
    async run(ctx) {
      const { evaluate, command, clickText, focusPane, solo, shot, until, rpc } = ctx
      // The session scenes are done. Hand the space back to a real engine before the page scenes:
      // several of these pages state which engine the space is on, and "Fake agent does not connect
      // to MCP servers" is a fact about the capture harness rather than about Realm.
      await rpc.call("sessions.setAgent", { id: ctx.sessionId, agentKind: "claude" }).catch(() => null)
      await ctx.solo()
      await command("Open library")
      await until(() => evaluate(`__capture.onPage('library-page-pane', 'Library')`), 15_000, "the library page")
      await focusPane()
      await clickText(".page-rail-tab, .page-rail button", "Skills")
      await sleep(1_200)
      await shot("library", `__capture.onPage('library-page-pane', 'Library')`)
    },
  },
  {
    name: "connections",
    async run({ evaluate, command, focusPane, solo, shot, until }) {
      await solo()
      await command("Open connections")
      await until(() => evaluate(`__capture.onPage('connections-page-pane', 'Connections')`), 15_000, "the connections page")
      await focusPane()
      await sleep(900)
      await shot("connections", `__capture.onPage('connections-page-pane', 'Connections')`)
    },
  },
  {
    name: "schedules",
    async run({ evaluate, clickText, focusPane, solo, shot, rpc, until }) {
      const spaces = await rpc.call("spaces.list", {})
      const spaceId = spaces[0].id
      // Enough of them that the page is doing its job — a list of standing work — rather than
      // two rows adrift in an empty pane.
      const schedules = [
        {
          title: "Morning triage",
          goal: "Read the overnight CI failures and open one issue per distinct cause.",
          cron: "0 9 * * 1-5",
        },
        {
          title: "Weekly dependency sweep",
          goal: "Check every workspace for outdated dependencies and open one PR per package.",
          cron: "0 7 * * 1",
        },
        {
          title: "Flaky test hunt",
          goal: "Re-run yesterday's failed CI jobs three times and file the tests that pass and fail at random.",
          cron: "30 2 * * *",
        },
        {
          title: "Changelog draft",
          goal: "Read the week's merged pull requests and draft the changelog entry for review.",
          cron: "0 16 * * 5",
        },
        {
          title: "Docs link check",
          goal: "Crawl the docs and open one pull request fixing every broken link it finds.",
          cron: "0 6 * * 0",
        },
        {
          title: "Stale branch sweep",
          goal: "List branches untouched for a month and ask their authors before deleting any.",
          cron: "0 10 1 * *",
        },
      ]
      for (const schedule of schedules) {
        await rpc.call("schedules.create", { spaceId, ...schedule }).catch((error) => {
          console.warn(`    schedules.create: ${error.message}`)
        })
      }
      await solo()
      await evaluate(`__capture.clickText('.sidebar button', 'Scheduled tasks')`)
      await until(() => evaluate(`__capture.onPage('schedules-page', 'Scheduled tasks')`), 15_000, "the schedules page")
      await focusPane()
      await sleep(900)
      await shot("schedules", `__capture.onPage('schedules-page', 'Scheduled tasks')`)
    },
  },
  {
    name: "usage",
    async run({ evaluate, command, focusPane, solo, tab, shot, until }) {
      await solo()
      await command("Open settings")
      await until(() => evaluate(`__capture.onPage('settings-page-pane', 'Settings')`), 15_000, "settings")
      await focusPane()
      await tab("Usage")
      await sleep(1_200)
      await shot("usage", `__capture.onPage('settings-page-pane', 'Settings', 'Usage')`)
    },
  },
  {
    name: "appearance",
    async run({ tab, shot }) {
      await tab("App")
      await sleep(1_200)
      await shot("appearance", `__capture.onPage('settings-page-pane', 'Settings', 'App')`)
    },
  },
  {
    name: "permissions",
    async run({ tab, shot }) {
      await tab("Permissions")
      await sleep(1_200)
      await shot("permissions", `__capture.onPage('settings-page-pane', 'Settings', 'Permissions')`)
    },
  },
  {
    name: "engines",
    async run({ tab, shot }) {
      await tab("Engines")
      await sleep(1_500)
      await shot("engines", `__capture.onPage('settings-page-pane', 'Settings', 'Engines')`)
    },
  },
  {
    name: "keys",
    async run({ evaluate, tab, shot, until }) {
      await tab("Keys")
      // The panel reads the file before it can draw a chord, so a fixed wait would sometimes
      // capture "Loading…".
      await until(
        () => evaluate(`document.querySelectorAll('.settings-list .settings-row').length > 0`),
        15_000,
        "the shortcut list",
      )
      await sleep(1_200)
      await shot("keys", `__capture.onPage('settings-page-pane', 'Settings', 'Keys') && document.querySelectorAll('.settings-list .settings-row').length > 0`)
    },
  },
  {
    name: "memory",
    async run({ evaluate, command, focusPane, solo, shot, until }) {
      await solo()
      await command("Open profile")
      await until(() => evaluate(`__capture.onPage('profile-page-pane')`), 15_000, "the profile page")
      await focusPane()
      await sleep(900)
      await shot("memory", `__capture.onPage('profile-page-pane')`)
    },
  },
  {
    // Last in the run, first in the carousel: this is about a sidebar with things in it, and at the
    // front of the list there is one session and nothing else. `content/features.ts` orders the
    // carousel; this list only orders the capture.
    name: "sidebar",
    async run({ evaluate, solo, shot, until, rpc, sessionId }) {
      await solo()
      await until(() => evaluate(`!!document.querySelector('.sidebar')`), 10_000, "the sidebar")
      // Put the staged session back in the pane. The sidebar next to a space's own settings page is
      // the `spaces` scene twice; next to a run it is what the column is actually for.
      const title = await stagedTitle(rpc, sessionId)
      await evaluate(`(() => {
        const row = [...document.querySelectorAll('.sidebar button, .sidebar [role="button"]')]
          .find((element) => element.textContent.includes(${JSON.stringify(title)}));
        row?.click();
        return true;
      })()`)
      await sleep(1_200)
      await shot("sidebar", `!!document.querySelector('.sidebar') && !!document.querySelector('.transcript')`)
    },
  },
  {
    // Straight after `sidebar`, because it is the same column under a different lens and the pane
    // beside it is already the staged run.
    name: "activity",
    async run({ evaluate, shot, until }) {
      // The lens is every chat under the PROFILE, across spaces and days — which is why staging
      // seeds chats in four spaces and dates them back through the week (`seededChats`).
      const lens = await evaluate(`(() => {
        const button = document.querySelector('.sb-toggle[aria-label="Activity"]');
        if (!button) return false;
        button.click();
        return true;
      })()`)
      if (!lens) throw new Error("No activity lens toggle in the sidebar")
      await until(() => evaluate(`!!document.querySelector('.sb-activity .sb-chat-row')`), 15_000, "the activity lens")
      await sleep(900)
      await shot("activity", `document.querySelectorAll('.sb-activity .sb-chat-day').length > 1`)
      // Back to the space lens. The sidebar is in every shot after this one, and leaving it on the
      // feed would put this scene's subject behind the next two.
      await evaluate(`document.querySelector('.sb-toggle[aria-label="Activity"]')?.click(); true`)
      await sleep(400)
    },
  },
  {
    name: "profiles",
    async run({ evaluate, command, escape, solo, shot }) {
      await solo()
      await command("All spaces")
      await sleep(1_200)
      await shot("profiles", `!!document.querySelector('.profile-switch, [role="dialog"]')`)
      await escape()
    },
  },
  {
    name: "notifications",
    async run({ evaluate, command, focusPane, solo, shot, until }) {
      await solo()
      await command("Open notifications")
      await until(() => evaluate(`__capture.onPage('notifications-page-pane', 'Notifications')`), 15_000, "the notifications page")
      await focusPane()
      await sleep(900)
      await shot("notifications", `__capture.onPage('notifications-page-pane', 'Notifications')`)
    },
  },
]

async function main() {
  for (const port of [cdpPort, serverPort]) {
    if (!(await portIsFree(port))) throw new Error(`Port ${port} is in use`)
  }

  const stagedScriptPath = path.join(scratch, "staged-turn.json")
  fs.writeFileSync(stagedScriptPath, JSON.stringify(stagedTurn))

  const wrapper = path.join(scratch, "wrapper.mjs")
  fs.writeFileSync(
    wrapper,
    [
      'import { app } from "electron";',
      'app.setPath("userData", process.env.REALM_CAPTURE_USER_DATA);',
      "await import(process.env.REALM_CAPTURE_MAIN);",
    ].join("\n"),
  )

  const electronBinary =
    process.platform === "darwin"
      ? path.join(
          repoRoot,
          "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
        )
      : path.join(repoRoot, "apps/desktop/node_modules/.bin/electron")

  electron = spawn(electronBinary, [wrapper], {
    env: {
      ...process.env,
      REALM_HOME: path.join(scratch, "home"),
      REALM_ENABLE_FAKE_AGENT: "1",
      REALM_FAKE_AGENT_SCRIPT: stagedScriptPath,
      // Paced like work rather than a fixture, so the transcript's "Worked for" reads as a real run.
      REALM_FAKE_AGENT_DELAY_MS: "2400",
      REALM_PORT: String(serverPort),
      REALM_DEVTOOLS_PORT: String(cdpPort),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_CAPTURE_USER_DATA: path.join(scratch, "userData"),
      REALM_CAPTURE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js"),
    },
    stdio: ["ignore", "ignore", "ignore"],
  })

  const targets = () =>
    fetch(`http://127.0.0.1:${cdpPort}/json/list`)
      .then((response) => response.json())
      .catch(() => [])
  const target = await until(
    async () => (await targets()).find((candidate) => candidate.type === "page" && candidate.url.startsWith("file://")),
    40_000,
    "the renderer",
  )
  const page = connectCdp(target.webSocketDebuggerUrl)
  await page.ready
  await page.send("Runtime.enable")
  await page.send("Page.enable")
  // Retina. The carousel shows these near full width on a laptop, where a 1x capture reads soft.
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  })

  const token = await until(
    () => {
      try {
        return JSON.parse(fs.readFileSync(path.join(scratch, "home", "daemon.json"), "utf8")).token ?? null
      } catch {
        return null
      }
    },
    20_000,
    "realm-server's token",
  )
  const rpc = connectRpc(serverPort, token)
  await rpc.ready
  liveRpc = rpc
  const ctx = makeContext(page, rpc)

  // ---- stage: past onboarding, one session with something in it ------------------
  await until(
    () => ctx.evaluate(`!!document.querySelector('.onboarding input:not([type=radio])')`),
    30_000,
    "onboarding",
  )
  await ctx.evaluate(`(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    __capture.setInput(input, 'Product');
    input.closest('form').requestSubmit();
    return true;
  })()`)
  await until(() => ctx.evaluate(`!!document.querySelector('.composer')`), 30_000, "the first session")

  const sessions = await until(
    async () => {
      const value = await rpc.call("sessions.listAll", {})
      return value.length ? value : null
    },
    20_000,
    "a session",
  )
  // A workspace with one space in it cannot show what spaces are for. Two profiles and a handful of
  // spaces is the smallest arrangement in which the sidebar's strip, the profile scoping and the
  // all-spaces overview are all showing something true.
  const [personal] = await rpc.call("profiles.list", {})
  const work = await rpc.call("profiles.create", { name: "Client work", color: "#f59e0b" }).catch((error) => {
    console.warn(`    profiles.create: ${error.message}`)
    return null
  })
  const seededSpaces = [
    { profileId: personal.id, name: "Realm", icon: "folder", color: "#7c6cff" },
    { profileId: personal.id, name: "Site", icon: "folder", color: "#34d399" },
    { profileId: personal.id, name: "School", icon: "folder", color: "#38bdf8" },
    ...(work ? [{ profileId: work.id, name: "Atlas", icon: "folder", color: "#f472b6" }] : []),
  ]
  for (const space of seededSpaces) {
    await rpc.call("spaces.create", space).catch((error) => {
      console.warn(`    spaces.create ${space.name}: ${error.message}`)
    })
  }

  ctx.sessionId = sessions[0].id
  await rpc.call("sessions.setAgent", { id: ctx.sessionId, agentKind: "fake" })
  await rpc.call("sessions.send", { id: sessions[0].id, text: stagedPrompt, attachments: [], mentions: [] })
  // Paced at 2.4 s a step, the turn takes about half a minute; wait for its last sentence rather
  // than a guessed sleep, so no scene photographs it half-finished.
  await until(
    () => ctx.evaluate(`document.querySelector('.transcript')?.textContent.includes('all pass') ?? false`),
    90_000,
    "the staged turn to finish",
  )
  await sleep(1_000)

  // The chats every sidebar shot is taken with. Created, not sent to: an unstarted session is an
  // ordinary row, and starting nine would be nine agent CLIs.
  const spaces = await rpc.call("spaces.list", {})
  const dated = []
  for (const chat of seededChats) {
    const space = spaces.find((candidate) => candidate.name === chat.space)
    if (!space) continue
    const created = await rpc
      .call("sessions.create", { spaceId: space.id, agentKind: "claude", title: chat.title })
      .catch((error) => console.warn(`    sessions.create ${chat.title}: ${error.message}`))
    if (created) dated.push({ id: created.session.id, at: lastWorked(chat) })
  }

  /*
   * Two rows no RPC will change, rewritten in the scratch database and then read again by reloading
   * the window.
   *
   * The seeded chats are dated back across the week: `updatedAt` is what the activity lens groups
   * by, and nothing sets it but work. Both rows — the session's, and the sidebar item's, which is
   * what the palette sorts and dates by.
   *
   * And the staged session goes back to a real agent. The scripted adapter wrote its transcript —
   * that is how the run reproduces — but the composer names the session's agent in every shot after
   * this, and "Fake" is a fact about the harness, not about Realm. `sessions.setAgent` is not the way:
   * it refuses a session that has already run, and this used to call it and swallow the refusal, so
   * "Fake" shipped under the prompter of four slides.
   */
  const ids = [ctx.sessionId, ...dated.map(({ id }) => id)]
  if (!ids.every((id) => /^[0-9A-Za-z]+$/.test(id))) throw new Error("A session id is not safe to write into SQL")
  scratchSql(
    [
      ...dated.flatMap(({ id, at }) => [
        `UPDATE sessions SET created_at = ${at}, updated_at = ${at} WHERE id = '${id}';`,
        `UPDATE items SET created_at = ${at}, updated_at = ${at} WHERE ref_id = '${id}';`,
      ]),
      `UPDATE sessions SET agent_kind = 'claude', model = NULL WHERE id = '${ctx.sessionId}';`,
    ].join("\n"),
  )
  await page.send("Page.reload", {})
  await sleep(1_500)
  await until(
    () =>
      ctx
        .evaluate(`document.querySelector('.transcript')?.textContent.includes('all pass') ?? false`)
        .catch(() => false),
    30_000,
    "the staged session after the reload",
  )
  await sleep(1_500)
  // The rewrite is only worth anything if the window read it back. Fail the run here rather than
  // photograph "Fake" under every prompter after this.
  if (await ctx.evaluate(`(document.querySelector('.composer')?.textContent ?? '').includes('Fake')`)) {
    throw new Error("The staged session's composer still names the scripted agent after the reload")
  }

  // The machine name is the developer's; the site is not the place to publish it.
  //
  // Two things this got wrong before. It was matched by pattern, and the pattern was written inside
  // a template literal, where `\\w` collapses to `w` and the regex silently stopped matching — so it
  // asks the server for the exact string instead. And it ran once, but the composer's understrip
  // redraws on its own (git status, a changed file) and brought the name back before the shot, so
  // an observer keeps it scrubbed.
  const system = await rpc.call("system.info", {}).catch(() => null)
  if (system?.machineName) {
    await ctx.evaluate(`(() => {
      const from = ${JSON.stringify(system.machineName)};
      const to = 'MacBook Pro';
      const scrub = () => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.nodeValue.includes(from)) node.nodeValue = node.nodeValue.split(from).join(to);
        }
        for (const element of document.querySelectorAll('[title]')) {
          const title = element.getAttribute('title');
          if (title.includes(from)) element.setAttribute('title', title.split(from).join(to));
        }
      };
      window.__realmScrub = scrub;
      new MutationObserver(scrub).observe(document.body, { subtree: true, childList: true, characterData: true });
      scrub();
      return true;
    })()`)
  } else {
    console.warn("    system.info gave no machine name — nothing scrubbed")
  }

  // ---- run the scenes ------------------------------------------------------------
  /* REALM_CAPTURE_ONLY=spaces,connections runs a subset. The scenes are order-dependent — each
     leaves the app where the next one starts — so a subset is a diagnostic tool, not a way to
     refresh one slide. Skipped scenes keep their file and their manifest entry. */
  const only = (process.env.REALM_CAPTURE_ONLY ?? "").split(",").map((n) => n.trim()).filter(Boolean)
  const captured = []
  for (const scene of scenes) {
    if (only.length && !only.includes(scene.name)) continue
    try {
      await scene.run(ctx)
      captured.push(scene.name)
      console.log(`  ✓ ${scene.name}`)
    } catch (error) {
      console.warn(`  ✗ ${scene.name} — ${error.message}`)
      const where = await ctx.evaluate(`__capture.onScreen()`).catch(() => null)
      if (where) console.warn(`      screen: ${where}`)
      await ctx.escape().catch(() => {})
    }
  }

  /**
   * The manifest is a UNION, not a replacement.
   *
   * A slug listed here means "there is a usable `<slug>.png` on disk", which is what the site reads
   * it for. A scene that fails now leaves the previous file untouched — `shot` refuses to write
   * unless the screen proves it is the subject — so dropping the slug would delete a working slide
   * from the site to record a fact about this run instead. It cost four slides once: a diagnostic
   * re-run of a few scenes rewrote the manifest down to its own successes and the site quietly lost
   * library, usage, appearance and engines. A slug whose file is gone is still dropped.
   */
  const manifestPath = path.join(outputDir, "manifest.json")
  const previous = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : []
  const kept = previous.filter((slug) => fs.existsSync(path.join(outputDir, `${slug}.png`)))
  const manifest = [...new Set([...kept, ...captured])]
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  page.close()
  console.log(`\n${captured.length}/${scenes.length} scenes captured; ${manifest.length} slides in ${path.relative(repoRoot, outputDir)}`)
  const stale = manifest.filter((slug) => !captured.includes(slug))
  if (stale.length) console.log(`  kept from an earlier run: ${stale.join(", ")}`)
}

main()
  .catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
  .finally(async () => {
    /*
     * Stop the SERVER, not just the window.
     *
     * realm-server is spawned by the desktop app and outliving the window is the whole point of it —
     * so killing the Electron this script started reparents the server to init and leaves it holding
     * the scratch home and REALM_PORT. The next run then dies on "Port 8917 is in use" and the temp
     * home never gets removed. `daemon.stop` is how the product itself asks, so it is what this
     * asks; the SIGKILL below stays as the answer for a server that will not.
     */
    await stopDaemon().catch(() => {})
    electron?.kill("SIGTERM")
    setTimeout(() => {
      electron?.kill("SIGKILL")
      fs.rmSync(scratch, { recursive: true, force: true })
      process.exit(process.exitCode ?? 0)
    }, 1_200)
  })
