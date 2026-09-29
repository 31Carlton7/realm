---
name: ios-simulator
description: Run, show and check an iOS or Android app on a simulator in Realm's simulator pane — open the device beside the session with the realm-simulator tools, install and launch a build, read the screen by element and screenshot it, and tap and type through serve-sim's CLI. Use when the task needs to see or interact with an iOS/iPadOS/watchOS app, check a SwiftUI screen outside Xcode, or capture proof of what an app actually renders.
---

# Running an app on a simulator in Realm

Realm has a **simulator pane**: it boots the device, streams its screen, and puts it beside the
session, where the user watches it and can use it. The `realm-simulator` tools are that pane, reached
from a tool call. Use them. Do not start `serve-sim` yourself, and never open a simulator's stream in
a browser pane — a stream in a web page is a second, worse copy of the pane, and Realm refuses
`browser_open` on one.

## Run an app

1. **Pick a device.** `simulator_list` gives each device's udid, runtime and state, and which are
   already open in a pane in this space. Never guess a udid.
2. **Open it.** `simulator_open` with the udid boots it if it is not running, opens the pane beside
   this session and waits for the screen. It returns the `simulatorId` the other tools take. A device
   already open in a pane here is brought back rather than opened twice, and a stream somebody else
   started is adopted rather than duplicated.
3. **Build it with your own tools**, as usual: `xcodebuild -scheme <App> -destination 'id=<udid>'
   build`, or Gradle for Android.
4. **Install and launch.** `simulator_install` with the absolute path to the built `.app` (or `.ipa`,
   or `.apk`), then `simulator_launch` with its bundle id — `simulator_apps` lists them.
   `simulator_open_url` follows a link, or a deep link such as `myapp://settings`, into the app.

## Read the screen

- `simulator_elements` is how you **know** what is on screen: the foreground app's accessibility
  tree, one line per element with its path, role, label, value, id and frame — points on iOS, pixels
  on Android, origin top-left. Match on `label`, `role` and `id`. For a few seconds after a boot it
  answers "not yet" while the device's accessibility framework warms up; ask again.
- `simulator_screenshot` is how you **see** it, shrunk to a size you can read. With `save: true` the
  full-resolution PNG is also kept in the space's `simulator/` folder — for a picture the user wants
  as proof, not for every check.

Verify against the tree, not the picture. After a step, read `simulator_elements` again and check the
content changed: the stream can lag a transition by a beat, so a screenshot taken straight after a
tap may still show the old screen.

## Tap and type

The tools do not tap or type. serve-sim's own CLI does, against the stream the pane is already
running — these commands start nothing (iOS only; on Android the pane itself is the input channel):

```bash
npx --yes serve-sim@latest tap 0.50 0.37 -d <udid>   # normalized 0..1 of the SCREEN
npx --yes serve-sim@latest type "hello" -d <udid>     # US keyboard only
npx --yes serve-sim@latest button home -d <udid>
npx --yes serve-sim@latest rotate landscape_left -d <udid>
npx --yes serve-sim@latest gesture '<json>' -d <udid> # swipes, pinches
```

Always pass `-d <udid>`. **Tap the element, not a guess**: take its frame from `simulator_elements`
and convert its centre against the screen size stated above the elements:

```
x = (frame.x + frame.width  / 2) / screen.width
y = (frame.y + frame.height / 2) / screen.height
```

The CLI also has `camera` (inject a synthetic feed), `permissions`, `event-log`, `ui`,
`memory-warning` and `ca-debug`. The pane's Device settings menu drives `ui`, `memory-warning` and
`ca-debug` too, so prefer the pane for those when a human is watching. `ui` takes its values from its
own table; hand it one it rejects and it prints the accepted set, which is how
`SIMULATOR_UI_OPTIONS` in `packages/contracts/src/simulator.ts` was written. Do not guess at
`text-size`'s twelve content-size categories.

## What the pane does for the person watching

- **Its bar** carries Home, the volume pair, the side button, rotate and stop, and a **Device
  settings** menu: appearance, Liquid Glass, colour filter, text size, Reduce Motion, Increase
  Contrast, Reduce Transparency, layout borders, VoiceOver, the CoreAnimation overlays, a memory
  warning and the Action button. The menu reads its values off the device each time it opens.
- **Elements** draws a box per accessibility element over the picture, each named by what the device
  calls it and each a control that taps the middle of the real thing. The device screen itself is one
  DOM node — Realm's element picker over a phone resolves to "the simulator" and nothing finer — so
  never claim to have clicked a named control "by ref" when what you sent was a coordinate.
- **Screenshot** writes a full-resolution PNG into the space's `simulator/` folder. **Apps** lists
  every installed app, the user's own first, with launch, the sixteen permissions and camera
  injection per app. **Dropping a file on the device** installs a `.app` or `.ipa`, or puts a picture
  or video into Photos.
- **Camera injection needs a NATIVE app, and Safari will not do.** The feed is injected by swizzling
  AVFoundation inside the process that is launched; WebKit captures in its own process, so a page
  calling `getUserMedia` in the simulator's Safari fails with `OverconstrainedError` however the
  injector was started. Measured, not assumed. Point it at the app under test.

## When the realm-simulator tools are not there

A space can switch them off. Then boot with `xcrun simctl boot <udid>`, start a stream scoped to it
with `npx --yes serve-sim@latest --detach <udid>`, and drive it with the CLI above. If the user wants
to watch, the phone button in the session's pane bar opens the simulator pane, which adopts the
stream you started instead of starting another. Still never open the stream in a browser pane.

## Stop it

Closing the pane leaves the device booted and the stream running, because a simulator is usually
somebody's Xcode session. If you booted a device only for this task, say so and say how to stop it.
Kill **scoped to its udid**, never unscoped — an unscoped `--kill` stops every stream on the machine,
including another session's:

```bash
npx --yes serve-sim@latest --kill <udid>
xcrun simctl shutdown <udid>   # only if you booted it
```

## Safety

serve-sim binds loopback, and that is correct. Its preview exposes a **token-gated shell-exec
route**, so `--host 0.0.0.0` puts command execution on the local network. Do not change it to share a
screen — screenshot instead.
