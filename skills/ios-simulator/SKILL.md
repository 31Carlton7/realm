---
name: ios-simulator
description: Mirror a booted Apple Simulator into a Realm browser pane with serve-sim, read its accessibility tree, and drive it — tap elements by label, type, gestures, hardware buttons, rotation, camera and permissions. Use when the task needs to see or interact with an iOS/iPadOS/watchOS app, check a SwiftUI screen outside Xcode, or capture proof of what an app actually renders.
---

# Driving an Apple Simulator from a Realm pane

`serve-sim` captures a booted simulator's framebuffer (direct IOSurface, zero-copy) and serves it as a
web page. Realm already renders web pages in panes, so the simulator becomes an ordinary browser pane
the user can watch — no simulator pane, no `simctl` screenshot polling.

Three surfaces, and keeping them straight is most of the skill: the **pane** shows a human what is
happening, `/ax` is how you **know** what is on screen, and the `serve-sim` CLI is how you **drive**
the device. Input never goes through the pane.

## Start it

1. **Pick a UDID.** `xcrun simctl list devices available` — never guess, and never target "booted"
   when more than one is up.
2. **Boot it** if needed: `xcrun simctl boot <udid>`. Already-booted is not an error worth reporting.
3. **Serve it, detached.** Daemon mode, so nothing depends on a terminal staying alive:

   ```bash
   npx --yes serve-sim@latest --detach <udid>
   ```

4. **Read the URL from `--list`**, which prints JSON — do not scrape the human-readable banner:

   ```bash
   npx --yes serve-sim@latest --list
   # {"running":true,"url":"http://127.0.0.1:3200", ... ,"device":"<udid>","pid":17016}
   ```

5. **Open `url` with `browser_open`.** From here it is a normal pane.

## Verify before reporting

A loaded page is not proof the stream is healthy — the UI renders fine while showing "Connecting…".
`browser_screenshot` and confirm **both**: the header reads `● live` (not `connecting`), and the device
frame shows real content. If it is still connecting after a few seconds, the simulator is booted but
not rendering; opening `Simulator.app` once (`open -a Simulator`) is usually enough.

## Read the screen

`serve-sim` publishes the simulator's **accessibility tree** — this is how you address things on the
device, not by guessing at pixels. `GET /ax` on the preview server is an SSE stream; the first
`data:` line is a complete snapshot:

```bash
curl -sN http://127.0.0.1:<port>/ax | head -c 20000
```

```jsonc
{ "screen": { "width": 402, "height": 874 },       // POINTS, not pixels
  "elements": [
    { "id": "com.apple.settings.general", "path": "0.1.1", "label": "General", "value": "",
      "role": "button", "type": "Button", "enabled": true,
      "frame": { "x": 16, "y": 293.3, "width": 370, "height": 44 } } ] }
```

`id` and `path` are stable handles; `label`, `role` and `enabled` are what you match on. Under the
Connect middleware the route is `{basePath}/ax` (default `/.sim/ax`); standalone it is just `/ax`.

A 503 means the simulator's AX framework is still warming up after boot — poll, do not conclude it
is unsupported.

## Drive it

Two channels, and each has a job:

- **The preview UI's own controls** — `browser_snapshot` lists them, `browser_act` clicks them by ref:
  `Home`, `Screenshot`, `Rotate device`, `Show accessibility overlay`, `Open tools panel`,
  `Open WebKit DevTools`, plus hardware `Action` / `Volume Up` / `Volume Down` / `Power`. These are
  real page elements and behave like any other pane.
- **The device itself** — the `serve-sim` CLI, always with `-d <udid>`:

  ```bash
  npx --yes serve-sim@latest tap 0.50 0.37 -d <udid>   # normalized 0..1 of the SCREEN
  npx --yes serve-sim@latest type "hello" -d <udid>     # US keyboard only
  npx --yes serve-sim@latest button home -d <udid>
  npx --yes serve-sim@latest rotate landscape_left -d <udid>
  npx --yes serve-sim@latest gesture '<json>' -d <udid> # swipes, pinches
  ```

  Also available: `camera` (inject a synthetic feed), `permissions`, `ui`, `memory-warning`,
  `ca-debug`, `event-log`.

**Tap the element, not a guess.** Take the target's `frame` from `/ax` and convert its centre against
`screen`:

```
x = (frame.x + frame.width  / 2) / screen.width
y = (frame.y + frame.height / 2) / screen.height
```

**Verify against the tree, not the picture.** Re-read `/ax` and check the content changed — a back
button appeared, the heading is the new screen. The video stream can lag a transition by a beat, so a
screenshot taken straight after a tap may still show the old screen while the tap has already landed.
Screenshots are for showing the user; `/ax` is for knowing.

## What the pane cannot see

**The device screen is one DOM node.** `browser_snapshot` reports it as a single `generic ""` box;
every icon, row and control inside it is pixels as far as the page is concerned.

So: **there are no element chips for anything on the device.** Realm's element picker resolves the DOM
node under the pointer, and over the phone that node is the whole screen — picking gives the user a
chip meaning "the simulator", not "the General row". Do not tell the user they can pick device
elements into the prompter, and never claim to have clicked a named control "by ref" when what you
sent was a coordinate.

This is a limit of the *pane*, not of what you can know: `/ax` above gives you labels, roles and
frames for everything on screen. Address the device through the tree and the CLI; use the pane to
show a human what is happening.

## Stop it

Kill **scoped to the UDID you started**, always. An unscoped `--kill` stops every stream on the
machine, including another session's:

```bash
npx --yes serve-sim@latest --kill <udid>
xcrun simctl shutdown <udid>   # only if you booted it
```

Leave the simulator running if the user is still looking at the pane; say what you left up and how to
stop it.

## Safety

Bind to loopback only. `serve-sim`'s preview exposes a **token-gated shell-exec route**, so
`--host 0.0.0.0` puts command execution on the local network. The default (`127.0.0.1`) is correct;
do not change it to share a screen — screenshot instead.
