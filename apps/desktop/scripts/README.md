# Live checks

A live check boots the BUILT app on a scratch home and drives it over CDP. Build first, then run it:

```sh
pnpm build
node apps/desktop/scripts/<name>-live.mjs
```

That is quiet already. Nothing reaches the screen: no window, no Dock icon, no focus taken, no
sound, notification or dialog. And whatever the check started is reaped when it ends, including
the server that outlives a killed Electron. The window still paints and lays out, so screenshots
and measurements are real.

A check that is its own Electron main (`*-live.cjs`) runs through the same launcher:

```sh
node apps/desktop/scripts/lib/live-app.mjs apps/desktop/scripts/<name>-live.cjs
```

## Writing one

Start Electron through `lib/live-app.mjs`, never by its binary path. `live-app.test.ts` fails a
script that does otherwise.

- `launchLiveApp({ name, env, inspect, rendererUrl })` does the whole boot: a scratch home, free
  ports, quiet mode, CDP to the page (`app.page`) and, with `inspect`, to main (`app.main`).
  `app.stop()` tears it all down.
- `spawnLiveElectron(args, options)` is a drop-in for `spawn(electronBin, args, options)`, for a
  script with its own wrapper.
- A `*-live.cjs` requires `./lib/quiet-electron.cjs` first. It constructs windows with
  `...QUIET_WINDOW_OPTIONS` last, then calls `show()`.

How quiet mode works, and what it records instead of showing (`quietWindowsLog`), is in
`src/main/quiet-windows.ts`. The parts a check notices:

- Windows sit above everything at alpha 1/255, and the mouse passes through them. Alpha 0 or a
  covered window gets no frames, and a browser pane in it never settles.
- The window main showed or focused last is key (`isFocused`, `isWindowKey`). The page is
  focus-emulated, so it doesn't dim itself.
- Secrets are sealed with the mock Keychain, because the real one asks for the login password
  when a binary it has not seen reads an item. A check of the Keychain itself sets
  `REALM_QUIET_KEYCHAIN=real` and names its own item (`profiles-live.mjs`).
- `Page.captureScreenshot` is the DOM only. For a native pane, capture the view's own
  `webContents.capturePage()` through `app.main`.

## The checks that are seen

Some evidence only exists on the real screen. These opt out with `visible: "<why>"`, which prints
the reason when they run. Run them when nobody is using the Mac.

| Check | Why |
| --- | --- |
| `real-screen-live.mjs` with `LIVE_FRONT=1` | native material, menus, Quick Look and Share are captured with `screencapture` |
| `security-codes-live.mjs` with `LIVE_FRONT=1` | the code menu and the pane under it are native, captured with `screencapture` |
| `pane-material-live.mjs` | the sidebar material is composited by the window server |
| `about-links-live.mjs` | the About panel is a native NSPanel |
| `browser-pane-live.cjs` | check 6 samples the screen where the native view composites over the DOM |
| `power-audit.mjs` | it prices drawing the window on screen |
| `unlock-policy-live.mjs` | step 4 raises macOS's own device-owner prompt (its window is quiet) |
