---
name: ios-simulator
description: Open an Apple Simulator in a Realm pane, read its accessibility tree, and drive it — tap elements by label, type, gestures, hardware buttons, rotation, camera and permissions. Use when the task needs to see or interact with an iOS/iPadOS/watchOS app, check a SwiftUI screen outside Xcode, or capture proof of what an app actually renders.
---

# Driving an Apple Simulator from a Realm pane

`serve-sim` captures a booted simulator's framebuffer (direct IOSurface, zero-copy) and serves it over
loopback. Realm has a **simulator pane** of its own that streams it: the session bar's phone button
opens one, its empty state lists this Mac's devices, and picking one boots the device, starts
`serve-sim` and shows the screen. A person can tap and type in that pane directly.

**Prefer the pane when a human is watching** — it is one button, and it adopts a stream that is
already running rather than starting a second one. What follows is the same thing done from a shell,
which is what you want when nobody asked for a pane, when the device has to be driven
deterministically, or when you need `/ax`.

Three surfaces, and keeping them straight is most of the skill: the **pane** shows a human what is
happening, `/ax` is how you **know** what is on screen, and the `serve-sim` CLI is how you **drive**
the device. Input never goes through the pane's picture.

## Start it, from a shell

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

5. **Show it, if a human wants to watch.** The simulator button in a session's pane bar opens
   Realm's own pane, which finds the stream you just started and shows it. `browser_open` on `url`
   still works and gives you serve-sim's own web UI instead — its tools panel and DevTools live
   there, and nowhere else.

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

- **Realm's own pane** — its bar carries Home, the volume pair, the side button, rotate and stop,
  and a **Device settings** menu that reaches everything `serve-sim ui` can set (appearance, Liquid
  Glass, colour filter, text size, Reduce Motion, Increase Contrast, Reduce Transparency, layout
  borders, VoiceOver) plus the CoreAnimation debug overlays, a memory warning and the Action button.
  The menu reads its values off the device each time it opens, so it agrees with `serve-sim ui
  status`. Under the device is the frame picker — a chassis and its finish, which is decoration and
  changes nothing about the device.
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

  Also available: `camera` (inject a synthetic feed), `permissions`, `event-log` — and `ui`,
  `memory-warning` and `ca-debug`, which the pane's Device settings menu now drives, so prefer the
  pane for those when a human is watching.

  `ui` takes its values from its own table; hand it one it rejects and it prints the accepted set,
  which is how `SIMULATOR_UI_OPTIONS` in `packages/contracts/src/simulator.ts` was written. Do not
  guess at `text-size`'s twelve content-size categories.

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

## What the pane can and cannot see

**The device screen is one DOM node.** `browser_snapshot` reports it as a single `generic ""` box;
every icon, row and control inside it is pixels as far as the page is concerned. So Realm's element
picker over a phone resolves to "the simulator" and nothing finer — there are no element chips for
anything on the device, and you must never claim to have clicked a named control "by ref" when what
you sent was a coordinate.

**The pane's Elements toggle is the answer to that.** It reads the same `/ax` tree and draws a box
per element over the picture, each named by what the DEVICE calls it, each a control that taps the
middle of the real thing. A human can point at "General" and hit it; the tree is re-read on demand,
because it is a snapshot of a screen that moves. Use it when a person is watching. Use `/ax` and the
CLI when you need to know rather than to show.

The route is `/helper/<udid>/ax`, and what it answers with is a NESTED array of nodes —
`{ AXLabel, AXValue, AXUniqueId, enabled, frame, type, children }`, frames in POINTS. The flat
`{screen, elements}` body described above is an older shape; the unscoped `/ax` on this build answers
with an SSE keepalive and no tree at all, which reads as "no elements" rather than as "wrong route".

## What else the pane does now

- **Screenshot** — `simctl io screenshot` at the device's full resolution, into the space's own
  `simulator/` folder, revealed in Finder. Not opened in the documents pane: that caps its reads at
  2 MB and a phone screenshot is three or four.
- **Apps** — every installed app (`simctl listapps`, the user's own first), and per app: launch,
  grant/revoke/reset any of the sixteen permissions, and inject a camera feed.
- **Drop a file on the device** — a `.app` or `.ipa` installs, a picture or video lands in Photos.
- **Camera injection needs a NATIVE app, and Safari will not do.** The feed is injected by swizzling
  AVFoundation inside the process that is launched; WebKit captures in its own process, so a page
  calling `getUserMedia` in the simulator's Safari fails with `OverconstrainedError` however the
  injector was started. Measured, not assumed. Point it at the app under test.

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
