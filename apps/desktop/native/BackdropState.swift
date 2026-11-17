// BackdropState: what a moving background has to know that Chromium does not tell the page. Prints
// one JSON line now and one on every change:
//   {"lowPower":true}        macOS Low Power Mode (ProcessInfo; Electron's powerMonitor has no such signal)
//   {"covered":[1234],"asleep":[],"locked":false}
//                            which of the windows asked about cannot be seen: covered is off screen
//                            (hidden, minimised, another Space) or every part of it under ordinary
//                            windows; asleep is on displays that are all asleep; locked is the session's
//                            screen locked, whose shield is not a window of the ordinary layer
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

/// On screen, and every display it is on asleep.
func asleep(_ id: CGWindowID) -> Bool {
  guard let me = (CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]])?.first, let rect = bounds(me) else { return false }
  var displays = [CGDirectDisplayID](repeating: 0, count: 16)
  var count: UInt32 = 0
  guard CGGetDisplaysWithRect(rect, 16, &displays, &count) == .success, count > 0 else { return false }
  return displays.prefix(Int(count)).allSatisfy { CGDisplayIsAsleep($0) != 0 }
}

func sessionLocked() -> Bool {
  let session = CGSessionCopyCurrentDictionary() as? [String: Any]
  return (session?["CGSSessionScreenIsLocked"] as? Bool) == true
}

var watched: [CGWindowID] = []
var last: String? = nil
/// `locked` is what a lock notification said; the session dictionary may not have caught up with it yet.
func look(locked: Bool? = nil) {
  let ids = { (w: [CGWindowID]) in w.map(String.init).joined(separator: ",") }
  let now = "{\"covered\":[\(ids(watched.filter(covered)))],\"asleep\":[\(ids(watched.filter(asleep)))],\"locked\":\(locked ?? sessionLocked())}"
  if now != last {
    last = now
    print(now)
  }
}

reportPower()
NotificationCenter.default.addObserver(forName: .NSProcessInfoPowerStateDidChange, object: nil, queue: .main) { _ in reportPower() }
let lockEvents = DistributedNotificationCenter.default()
lockEvents.addObserver(forName: .init("com.apple.screenIsLocked"), object: nil, queue: .main) { _ in look(locked: true) }
lockEvents.addObserver(forName: .init("com.apple.screenIsUnlocked"), object: nil, queue: .main) { _ in look(locked: false) }
Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in if !watched.isEmpty { look() } }
Thread.detachNewThread {
  while let line = readLine() {
    let ids = line.split(separator: " ").compactMap { CGWindowID($0) }
    DispatchQueue.main.async { watched = ids; look() }
  }
  exit(0)
}
RunLoop.main.run()
