// BackdropState: what a moving background has to know that Chromium does not tell the page. Prints
// one JSON line now and one on every change:
//   {"lowPower":true}        macOS Low Power Mode (ProcessInfo; Electron's powerMonitor has no such signal)
//   {"covered":[1234]}       which of the windows asked about cannot be seen: off screen (hidden,
//                            minimised, another Space) or every part of it under ordinary windows
// Reads lines of window numbers to watch ("1234 5678", or an empty line for none) on stdin, and looks
// once a second while there are any. Realm keeps covered windows compositing for its browser agent
// (--disable-backgrounding-occluded-windows), so the page itself is never told.
//
// Build: swiftc -O -o bin/backdropstate BackdropState.swift   (see scripts/build-native.mjs)
// Exits when stdin closes (parent gone).

import CoreGraphics
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

func reportPower() { print("{\"lowPower\":\(ProcessInfo.processInfo.isLowPowerModeEnabled)}") }

func bounds(_ w: [String: Any]) -> CGRect? {
  guard let d = w[kCGWindowBounds as String] as? NSDictionary else { return nil }
  return CGRect(dictionaryRepresentation: d)
}

/// Not listed or off screen, or every point of a 12x12 grid over it inside an opaque window of the ordinary layer
/// above it. The layer keeps out the menu bar, the Dock and overlays that draw nothing over it.
func covered(_ id: CGWindowID) -> Bool {
  // A window ordered out (hidden) is not listed at all; one minimised or on another Space is listed off screen.
  guard let me = (CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]])?.first else { return true }
  if (me[kCGWindowIsOnscreen as String] as? Bool) != true { return true }
  guard let rect = bounds(me) else { return false }
  let above = (CGWindowListCopyWindowInfo([.optionOnScreenAboveWindow, .excludeDesktopElements], id) as? [[String: Any]]) ?? []
  let opaque = above.compactMap { w -> CGRect? in
    guard (w[kCGWindowLayer as String] as? Int) == 0, ((w[kCGWindowAlpha as String] as? Double) ?? 0) >= 0.99 else { return nil }
    return bounds(w)
  }
  if opaque.isEmpty { return false }
  for i in 0..<12 {
    for j in 0..<12 {
      let p = CGPoint(x: rect.minX + (CGFloat(i) + 0.5) * rect.width / 12, y: rect.minY + (CGFloat(j) + 0.5) * rect.height / 12)
      if !opaque.contains(where: { $0.contains(p) }) { return false }
    }
  }
  return true
}

var watched: [CGWindowID] = []
var lastCovered: [CGWindowID]? = nil
func look() {
  let now = watched.filter(covered)
  if now != lastCovered {
    lastCovered = now
    print("{\"covered\":[\(now.map(String.init).joined(separator: ","))]}")
  }
}

reportPower()
NotificationCenter.default.addObserver(forName: .NSProcessInfoPowerStateDidChange, object: nil, queue: .main) { _ in reportPower() }
Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in if !watched.isEmpty { look() } }
Thread.detachNewThread {
  while let line = readLine() {
    let ids = line.split(separator: " ").compactMap { CGWindowID($0) }
    DispatchQueue.main.async { watched = ids; look() }
  }
  exit(0)
}
RunLoop.main.run()
