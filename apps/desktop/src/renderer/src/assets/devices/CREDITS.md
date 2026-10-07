# Device art

The frames the simulator pane draws around a stream. Fetched by
`apps/desktop/scripts/fetch-device-frames.mjs` from
[MockUPhone](https://github.com/oursky/mockuphone.com) at commit `7e570f420ad9`
(the project is Apache-2.0; each frame's own credit is below, taken from that repo's
`device_info.json`).

- `iphone.png` — iPhone 15 Pro (Black Titanium) — Apple Design Resources
- `ipad.png` — iPad Pro 11-inch (Space Grey) — Apple Design Resources
- `android-phone.png` — Google Pixel 8 (Obsidian) — Sajjad Mohammadi Nia

The Apple frames are credited to Apple Design Resources, whose terms cover designing apps for Apple
platforms and do not grant redistribution inside another product. Anything shipped from here is a
call for whoever ships Realm, and it is deliberately one directory and one table wide: delete the
file, drop its row, and the pane falls back to the frame Realm draws itself.
