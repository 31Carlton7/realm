// ScrollPhase — tiny macOS helper that streams trackpad scroll *phases* as JSON lines on stdout.
//
// Why: DOM `wheel` events carry deltas but not the gesture phase (began/changed/ended) or momentum
// phase, so a web view cannot tell "fingers resting on the pad" from "fingers lifted" or "coasting".
// Realm's space swiper needs those to feel like macOS Spaces (drag, hold, release → ease).
//
// How: a listen-only CGEventTap on scroll-wheel events at the session level. It observes only
// scroll deltas/phases — never keys, never content — and Realm's main process forwards the stream
// to the renderer. Requires the "Input Monitoring" privacy permission on macOS (the OS prompts once;
// without it the tap can't be created and Realm silently falls back to timer heuristics).
//
// Build: swiftc -O -o bin/scrollphase ScrollPhase.swift   (see scripts/build-native.mjs)
// Exits when stdin closes (parent gone).

import CoreGraphics
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

// CGEventField raw values (CoreGraphics/CGEventTypes.h)
let kScrollPhase = CGEventField(rawValue: 99)!          // kCGScrollWheelEventScrollPhase
let kMomentumPhase = CGEventField(rawValue: 123)!       // kCGScrollWheelEventMomentumPhase
let kPointDeltaAxis1 = CGEventField(rawValue: 96)!      // vertical  (kCGScrollWheelEventPointDeltaAxis1)
let kPointDeltaAxis2 = CGEventField(rawValue: 97)!      // horizontal(kCGScrollWheelEventPointDeltaAxis2)

// NSEventPhase bit flags → names (matches NSEvent.Phase raw values)
func phaseName(_ v: Int64) -> String {
  if v & 1 != 0 { return "began" }
  if v & 2 != 0 { return "stationary" }
  if v & 4 != 0 { return "changed" }
  if v & 8 != 0 { return "ended" }
  if v & 16 != 0 { return "cancelled" }
  if v & 32 != 0 { return "mayBegin" }
  return "none"
}

// Watch stdin: when the parent closes it, quit.
DispatchQueue.global().async {
  while let _ = readLine() {}
  exit(0)
}

let mask = CGEventMask(1 << CGEventType.scrollWheel.rawValue)
guard let tap = CGEvent.tapCreate(
  tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .listenOnly,
  eventsOfInterest: mask,
  callback: { _, type, event, _ in
    if type == .scrollWheel {
      let ph = phaseName(event.getIntegerValueField(kScrollPhase))
      let mo = phaseName(event.getIntegerValueField(kMomentumPhase))
      if ph != "none" || mo != "none" { // trackpad-style only; plain mouse wheels have neither
        let dx = event.getDoubleValueField(kPointDeltaAxis2)
        let dy = event.getDoubleValueField(kPointDeltaAxis1)
        let ts = Double(event.timestamp) / 1_000_000_000.0
        print("{\"phase\":\"\(ph)\",\"momentum\":\"\(mo)\",\"dx\":\(dx),\"dy\":\(dy),\"ts\":\(ts)}")
      }
    } else if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      // Re-enable if the system paused us; keep the stream alive.
      if let t = tapRef { CGEvent.tapEnable(tap: t, enable: true) }
    }
    return Unmanaged.passUnretained(event)
  },
  userInfo: nil)
else {
  FileHandle.standardError.write("scrollphase: could not create event tap (Input Monitoring permission?)\n".data(using: .utf8)!)
  exit(2)
}
var tapRef: CFMachPort? = tap
let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetMain(), src, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
print("{\"ready\":true}")
CFRunLoopRun()
