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
// THE TAP CALLBACK MUST NOT DO I/O. It runs inline in the system's event-dispatch path: a `write`
// that blocks on a full stdout pipe (parent busy) stalls every scroll in every app, and macOS then
// rips the tap out with kCGEventTapDisabledByTimeout — which reads to the user as scrolling that is
// choppy and randomly stops dead. So the callback only appends to an in-memory buffer under a lock;
// a dedicated thread does the writing. Same-phase deltas coalesce while that thread is busy, which
// also collapses the 120 Hz `changed` storm into roughly one line per frame.
//
// Build: swiftc -O -o bin/scrollphase ScrollPhase.swift   (see scripts/build-native.mjs)
// Exits when stdin closes (parent gone).

import CoreGraphics
import Foundation

// Full buffering: each flush becomes one write(2) instead of one per line.
setvbuf(stdout, nil, _IOFBF, 1 << 16)

// CGEventField raw values (CoreGraphics/CGEventTypes.h)
let kScrollPhase = CGEventField(rawValue: 99)!          // kCGScrollWheelEventScrollPhase
let kMomentumPhase = CGEventField(rawValue: 123)!       // kCGScrollWheelEventMomentumPhase
let kPointDeltaAxis1 = CGEventField(rawValue: 96)!      // vertical  (kCGScrollWheelEventPointDeltaAxis1)
let kPointDeltaAxis2 = CGEventField(rawValue: 97)!      // horizontal(kCGScrollWheelEventPointDeltaAxis2)

// CGScrollPhase (NOT NSEventPhase bit flags): 1 began, 2 changed, 4 ended, 8 cancelled, 128 mayBegin.
func phaseName(_ v: Int64) -> String {
  switch v { case 1: return "began"; case 2: return "changed"; case 4: return "ended"; case 8: return "cancelled"; case 128: return "mayBegin"; default: return "none" }
}
// CGMomentumScrollPhase: 0 none, 1 began, 2 continue, 3 ended.
func momentumName(_ v: Int64) -> String {
  switch v { case 1: return "began"; case 2: return "changed"; case 3: return "ended"; default: return "none" }
}

struct Sample {
  let phase: String
  let momentum: String
  var dx: Double
  var dy: Double
  var ts: Double
}

/// Lock-guarded hand-off from the tap callback to the writer thread.
///
/// Coalescing is keyed on (phase, momentum): a run of `changed` events merges into one record with
/// summed deltas, but any phase transition starts a new record, so the ordering the swiper's state
/// machine depends on — began → changed… → ended → momentum… — survives intact.
final class Emitter {
  private let cond = NSCondition()
  private var pending: [Sample] = []
  /// Distinct phase transitions are few, so coalescing bounds this naturally; the cap is only a
  /// guard against a parent that has stopped reading entirely.
  private let cap = 512

  func push(phase: String, momentum: String, dx: Double, dy: Double, ts: Double) {
    cond.lock()
    if var last = pending.last, last.phase == phase, last.momentum == momentum {
      last.dx += dx; last.dy += dy; last.ts = ts
      pending[pending.count - 1] = last
    } else if pending.count < cap {
      pending.append(Sample(phase: phase, momentum: momentum, dx: dx, dy: dy, ts: ts))
    }
    cond.signal()
    cond.unlock()
  }

  private func drain() -> [Sample] {
    cond.lock()
    while pending.isEmpty { cond.wait() }
    let batch = pending
    pending.removeAll(keepingCapacity: true)
    cond.unlock()
    return batch
  }

  func runWriter() -> Never {
    while true {
      for s in drain() {
        print("{\"phase\":\"\(s.phase)\",\"momentum\":\"\(s.momentum)\",\"dx\":\(s.dx),\"dy\":\(s.dy),\"ts\":\(s.ts)}")
      }
      fflush(stdout)
      // A coalescing window, not a rate limit: the first event of a burst has already gone out, and
      // whatever arrives during these 4ms merges into one line instead of a hundred. Well under a
      // frame either way, so the swiper never sees a phase transition late enough to matter.
      usleep(4_000)
    }
  }
}

let emitter = Emitter()
var tapRef: CFMachPort?

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
      let mo = momentumName(event.getIntegerValueField(kMomentumPhase))
      if ph != "none" || mo != "none" { // trackpad-style only; plain mouse wheels have neither
        emitter.push(phase: ph, momentum: mo,
                     dx: event.getDoubleValueField(kPointDeltaAxis2),
                     dy: event.getDoubleValueField(kPointDeltaAxis1),
                     ts: Double(event.timestamp) / 1_000_000_000.0)
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
tapRef = tap
let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetMain(), src, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
print("{\"ready\":true}")
fflush(stdout)

let writer = Thread { emitter.runWriter() }
writer.name = "scrollphase.writer"
writer.qualityOfService = .userInteractive
writer.start()

CFRunLoopRun()
