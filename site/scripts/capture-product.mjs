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
 * Scenes are independent and each is wrapped: a selector that has moved loses one image and prints
 * why, rather than ending the run. What survives is written to `public/product/manifest.json`, and
 * the features page renders the intersection of that and the copy authored in `content/features.ts`
 * — so a scene that breaks silently drops out of the carousel instead of shipping a broken image.
 */
import { spawn } from "node:child_process"
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

const releaseBrief = `# Realm 0.6

## What ships

- Computer use, off until a space asks for it
- Seven palettes across seventeen faces
- Plan and Ask, enforced by each backend
- Sub-agents nested under the call that spawned them

## Release check

Keep the work, the evidence and the handoff visible in one space.`

let electron = null

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

function connectRpc(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`)
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
    await evaluate(`document.querySelector('button[aria-label^="Unfocus"]')?.click(); true`)
    await sleep(300)
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const panes = await evaluate(`document.querySelectorAll('.panehost .panel').length`)
      if (panes <= 1) return
      await command("Close pane")
      await sleep(450)
    }
  }

  /** Select a Settings tab and prove it took: the first click after the page mounts gets dropped. */
  const tab = async (label) => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await evaluate(`(() => {
        const element = [...document.querySelectorAll('.page-rail-tab')]
          .find((candidate) => candidate.textContent.trim().startsWith(${JSON.stringify(label)}));
        if (!element) return false;
        (element.querySelector('input') ?? element).click();
        return true;
      })()`)
      await sleep(450)
      const selected = await evaluate(`document.querySelector('.page-rail-tab[data-selected]')?.textContent.trim() ?? ''`)
      if (selected.startsWith(label)) return
    }
    throw new Error(`Settings never selected the ${label} tab`)
  }

  /**
   * Fill the host with the focused pane — the app's own ⌘⇧F, so what it leaves on screen is real.
   *
   * Not fatal. A scene whose surface already fills the host is still worth capturing, and the
   * palette only offers the action when there is more than one pane to fill over.
   */
  const focusPane = async () => {
    if (await evaluate(`!!document.querySelector('button[aria-label^="Unfocus"]')`)) return
    const viaBar = await evaluate(`(() => {
      const button = document.querySelector('.panel-bar button[aria-label^="Focus"]');
      if (!button) return false;
      button.click();
      return true;
    })()`)
    if (!viaBar) {
      // The palette is already open when this throws, and leaving it open puts a dialog over the
      // next scene's subject.
      await command("Focus ").catch(() => escape())
    }
    await sleep(500)
  }

  const escape = async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await press("Escape", { vk: 27 })
      await sleep(350)
      if (!(await evaluate(`!!document.querySelector('.palette, [role="dialog"]')`))) return
    }
  }

  const shot = async (name) => {
    // Belt as well as the observer staging installs: a shot taken in the same frame as a re-render
    // should not be the one that publishes the developer's computer name.
    await evaluate(`window.__realmScrub?.(); true`)
    await sleep(350)
    const result = await page.send("Page.captureScreenshot", { format: "png", fromSurface: true })
    fs.mkdirSync(outputDir, { recursive: true })
    fs.writeFileSync(path.join(outputDir, `${name}.png`), Buffer.from(result.data, "base64"))
  }

  return { evaluate, clickText, command, escape, focusPane, press, solo, tab, shot, rpc, sleep, until }
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
      await shot("session")
    },
  },
  {
    name: "palette",
    async run({ evaluate, escape, press, shot, until }) {
      await escape()
      await press("k", { code: "KeyK", vk: 75, meta: true })
      await until(() => evaluate(`!!document.querySelector('.palette')`), 8_000, "the command palette")
      await sleep(500)
      await shot("palette")
      await escape()
    },
  },
  {
    name: "models",
    async run({ evaluate, clickText, command, escape, solo, shot, until }) {
      await escape()
      // A fresh session, so the picker opens on the real default rather than on the scripted adapter
      // the transcript was staged with — where every model reads "unavailable here", which is a fact
      // about the capture and the opposite of what this surface is for.
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
      await shot("models")
      await escape()
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
        __capture.setInput(name, 'Release brief');
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
        () => evaluate(`document.querySelector('[aria-label="Rich text editor"] h1')?.textContent === 'Realm 0.6'`),
        15_000,
        "the rich document",
      )
      await sleep(600)
      await shot("documents")
    },
  },
  {
    name: "workspace",
    async run({ evaluate, command, shot, until }) {
      await command("Split right")
      await until(() => evaluate(`document.querySelectorAll('.panehost .panel').length === 2`), 10_000, "two panes")
      // The new pane is focused and empty; put the staged session into it, so the split shows the
      // relationship the page claims — a run and the document beside it. Matching on the title
      // matters: the app also opened an untouched "New session", and that is the one a
      // first-not-the-document rule would find.
      const opened = await evaluate(`(() => {
        const row = [...document.querySelectorAll('.sidebar button, .sidebar [role="button"]')]
          .find((element) => element.textContent.includes('mapper'));
        if (!row) return false;
        row.click();
        return true;
      })()`)
      if (!opened) throw new Error("No sidebar row for the staged session")
      await sleep(1_200)
      await shot("workspace")
    },
  },
  {
    name: "terminal",
    async run({ evaluate, command, solo, shot, rpc, until }) {
      await solo()
      await command("New terminal")
      await until(() => evaluate(`!!document.querySelector('.xterm')`), 20_000, "the terminal")
      // A shell prompt on its own is not evidence of a terminal pane. The item's refId IS the
      // terminal id, so the same pty the pane is showing can be written to directly.
      const terminals = await rpc.call("items.listAll", {})
      const pty = terminals.find((item) => item.kind === "terminal")
      if (pty) {
        await rpc.call("terminals.write", {
          terminalId: pty.refId,
          // Deliberately not `ls -la`: its owner column publishes the developer's system username.
          data:
            "mkdir -p src && touch src/adapter.ts src/mapper.ts src/session.ts README.md && " +
            "git init -q && git add -A && " +
            "git -c user.name=Realm -c user.email=realm@example.com commit -qm 'Carry the plan as its own event' && " +
            "printf '# Realm\\n' > README.md && git status --short && " +
            // --no-pager: git's default pager clears the screen and leaves (END) on it.
            "git --no-pager log --oneline && ls src\r",
        })
        await sleep(2_500)
      }
      await sleep(1_000)
      await shot("terminal")
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
      await until(() => evaluate(`!!document.querySelector('.page')`), 15_000, "the space page")
      await focusPane()
      await sleep(900)
      await shot("spaces")
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
      await until(() => evaluate(`!!document.querySelector('.page')`), 15_000, "the library page")
      await focusPane()
      await clickText(".page-rail-tab, .page-rail button", "Skills")
      await sleep(1_200)
      await shot("library")
    },
  },
  {
    name: "connections",
    async run({ evaluate, command, focusPane, solo, shot, until }) {
      await solo()
      await command("Open connections")
      await until(() => evaluate(`!!document.querySelector('.page')`), 15_000, "the connections page")
      await focusPane()
      await sleep(900)
      await shot("connections")
    },
  },
  {
    name: "schedules",
    async run({ evaluate, clickText, focusPane, solo, shot, rpc, until }) {
      const spaces = await rpc.call("spaces.list", {})
      const spaceId = spaces[0].id
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
      ]
      for (const schedule of schedules) {
        await rpc.call("schedules.create", { spaceId, ...schedule }).catch((error) => {
          console.warn(`    schedules.create: ${error.message}`)
        })
      }
      await solo()
      await evaluate(`__capture.clickText('.sidebar button', 'Scheduled tasks')`)
      await until(() => evaluate(`!!document.querySelector('.page')`), 15_000, "the schedules page")
      await focusPane()
      await sleep(900)
      await shot("schedules")
    },
  },
  {
    name: "usage",
    async run({ evaluate, command, focusPane, solo, tab, shot, until }) {
      await solo()
      await command("Open settings")
      await until(() => evaluate(`!!document.querySelector('.page-rail-tab')`), 15_000, "settings")
      await focusPane()
      await tab("Usage")
      await sleep(1_200)
      await shot("usage")
    },
  },
  {
    name: "appearance",
    async run({ tab, shot }) {
      await tab("App")
      await sleep(1_200)
      await shot("appearance")
    },
  },
  {
    name: "permissions",
    async run({ tab, shot }) {
      await tab("Permissions")
      await sleep(1_200)
      await shot("permissions")
    },
  },
  {
    name: "engines",
    async run({ tab, shot }) {
      await tab("Engines")
      await sleep(1_500)
      await shot("engines")
    },
  },
  {
    name: "memory",
    async run({ evaluate, command, focusPane, solo, shot, until }) {
      await solo()
      await command("Open profile")
      await until(() => evaluate(`!!document.querySelector('.page')`), 15_000, "the profile page")
      await focusPane()
      await sleep(900)
      await shot("memory")
    },
  },
  {
    // Last in the run, first in the carousel: this is about a sidebar with things in it, and at the
    // front of the list there is one session and nothing else. `content/features.ts` orders the
    // carousel; this list only orders the capture.
    name: "sidebar",
    async run({ evaluate, solo, shot, until }) {
      await solo()
      await until(() => evaluate(`!!document.querySelector('.sidebar')`), 10_000, "the sidebar")
      // Put the staged session back in the pane. The sidebar next to a space's own settings page is
      // the `spaces` scene twice; next to a run it is what the column is actually for.
      await evaluate(`(() => {
        const row = [...document.querySelectorAll('.sidebar button, .sidebar [role="button"]')]
          .find((element) => element.textContent.includes('mapper'));
        row?.click();
        return true;
      })()`)
      await sleep(1_200)
      await shot("sidebar")
    },
  },
  {
    name: "profiles",
    async run({ evaluate, command, escape, solo, shot }) {
      await solo()
      await command("All spaces")
      await sleep(1_200)
      await shot("profiles")
      await escape()
    },
  },
  {
    name: "notifications",
    async run({ evaluate, command, focusPane, solo, shot, until }) {
      await solo()
      await command("Open notifications")
      await until(() => evaluate(`!!document.querySelector('.page')`), 15_000, "the notifications page")
      await focusPane()
      await sleep(900)
      await shot("notifications")
    },
  },
]

async function main() {
  for (const port of [cdpPort, serverPort]) {
    if (!(await portIsFree(port))) throw new Error(`Port ${port} is in use`)
  }

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

  const rpc = connectRpc(serverPort)
  await rpc.ready
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
  for (const text of ["Rework the session mapper — plan it first", "todos"]) {
    await rpc.call("sessions.send", { id: sessions[0].id, text, attachments: [], mentions: [] })
    await sleep(2_000)
  }
  // Staging is done. The scripted adapter produced the transcript — that is how the run reproduces —
  // but every surface after this states which engine the SPACE is on, and that is a fact about the
  // capture harness rather than about Realm. Hand it back to a real one.
  await rpc.call("sessions.setAgent", { id: ctx.sessionId, agentKind: "claude" }).catch(() => null)
  await sleep(800)

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
  const captured = []
  for (const scene of scenes) {
    try {
      await scene.run(ctx)
      captured.push(scene.name)
      console.log(`  ✓ ${scene.name}`)
    } catch (error) {
      console.warn(`  ✗ ${scene.name} — ${error.message}`)
      await ctx.escape().catch(() => {})
    }
  }

  fs.writeFileSync(path.join(outputDir, "manifest.json"), `${JSON.stringify(captured, null, 2)}\n`)
  rpc.close()
  page.close()
  console.log(`\n${captured.length}/${scenes.length} scenes in ${path.relative(repoRoot, outputDir)}`)
}

main()
  .catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
  .finally(() => {
    electron?.kill("SIGTERM")
    setTimeout(() => {
      electron?.kill("SIGKILL")
      fs.rmSync(scratch, { recursive: true, force: true })
      process.exit(process.exitCode ?? 0)
    }, 1_200)
  })
