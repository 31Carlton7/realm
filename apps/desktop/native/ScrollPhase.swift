// ScrollPhase — tiny macOS helper that streams trackpad scroll *phases* as JSON lines on stdout.
//
// Why: DOM `wheel` events carry deltas but not NSEvent's `phase`/`momentumPhase`, so a web view
// cannot tell "fingers resting on the pad" from "fingers lifted" or "momentum coasting". Realm's
// space swiper needs those to feel like macOS Spaces (drag, hold, release → ease). This helper
// installs a global scroll-wheel monitor (no permissions needed for scroll events; it observes only
// deltas/phases, never content) and Realm's main process forwards the stream to the renderer.
//
// Build: swiftc -O -o bin/scrollphase ScrollPhase.swift   (see package.json "build:native")
// Exits when stdin closes (parent gone).

import AppKit
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

func name(_ p: NSEvent.Phase) -> String {
  if p.contains(.began) { return "began" }
  if p.contains(.changed) { return "changed" }
  if p.contains(.ended) { return "ended" }
  if p.contains(.cancelled) { return "cancelled" }
  if p.contains(.mayBegin) { return "mayBegin" }
  if p.contains(.stationary) { return "stationary" }
  return "none"
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

// Watch stdin: when the parent closes it, quit.
DispatchQueue.global().async {
  while let _ = readLine() {}
  exit(0)
}

var handle: Any?
handle = NSEvent.addGlobalMonitorForEvents(matching: .scrollWheel) { e in
  // Only trackpad-style scrolls carry phases; mouse wheels report none/none and are ignored.
  let ph = name(e.phase), mo = name(e.momentumPhase)
  if ph == "none" && mo == "none" { return }
  let line = "{\"phase\":\"\(ph)\",\"momentum\":\"\(mo)\",\"dx\":\(e.scrollingDeltaX),\"dy\":\(e.scrollingDeltaY),\"ts\":\(e.timestamp)}"
  print(line)
}
if handle == nil { FileHandle.standardError.write("scrollphase: monitor unavailable\n".data(using: .utf8)!); exit(2) }
print("{\"ready\":true}")
RunLoop.main.run()
