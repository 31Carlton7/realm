// realm-keys-proof — the other two ends of realm-keys-live.mjs: it posts synthetic key events for the
// key helper (native/RealmKeys.swift) to decide on, and it is the last tap in the session, standing
// in for every app after the helper.
//
// Safe on a Mac someone is typing on:
//   - Every event it posts comes from a private event source and carries TAG. Its tap removes every
//     tagged event, so nothing it posts reaches an app, and returns every other event untouched and
//     unread. The helper under test runs with --only-tagged TAG, so it does the same.
//   - Before anything else it posts one key-up of F20 and checks that its own tap removed it. If
//     not, it posts nothing more.
//   - The only keys it posts are F18, F19 and F20 and modifiers, never a letter. Its one mouse event
//     is a press of button 30 where the pointer already is, and its scroll moves nothing.
//   - It checks Accessibility without asking, and makes no tap and posts nothing without it.
//   - SIGALRM ends it at 18 s whatever it is doing.
//
// It runs one scenario per line of stdin and answers each with the tagged events that reached its
// tap, which is what an app would have received, and the longest any of them took to get there:
// {"scenario":"…","reached":["keyDown:80",…],"slowestMs":2}. slowestMs is -1 when an event was removed
// on the way, since arrivals can then no longer be matched to posts.
//
// Build: swiftc -O -o <out> realm-keys-proof.swift     Run: <out> <tag>

import ApplicationServices
import CoreGraphics
import Foundation

signal(SIGALRM, SIG_DFL)
alarm(18)

let tag: Int64 = {
  guard let given = CommandLine.arguments.dropFirst().first.flatMap({ Int64($0) }) else {
    print("{\"error\":\"usage: realm-keys-proof <tag>\"}")
    exit(64)
  }
  return given
}()
guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else {
  print("{\"error\":\"not permitted: no tap was made and nothing was posted\"}")
  exit(3)
}

func say(_ line: String) { print(line); fflush(stdout) }
func pause(_ seconds: Double) { usleep(useconds_t(seconds * 1_000_000)) }

let lock = NSLock()
var reached: [String] = []
var postedAt: [Double] = []
var reachedAt: [Double] = []
func now() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e9 }
var tailTap: CFMachPort?

func name(_ type: CGEventType) -> String {
  switch type {
  case .keyDown: return "keyDown"
  case .keyUp: return "keyUp"
  case .flagsChanged: return "flagsChanged"
  case .otherMouseDown: return "mouseDown"
  case .scrollWheel: return "scroll"
  default: return "type\(type.rawValue)"
  }
}

let tailCallback: CGEventTapCallBack = { _, type, event, _ in
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    if let tap = tailTap { CGEvent.tapEnable(tap: tap, enable: true) }
    return Unmanaged.passUnretained(event)
  }
  guard event.getIntegerValueField(.eventSourceUserData) == tag else { return Unmanaged.passUnretained(event) }
  lock.lock()
  reachedAt.append(now())
  reached.append(type == .otherMouseDown || type == .scrollWheel ? name(type) : "\(name(type)):\(event.getIntegerValueField(.keyboardEventKeycode))")
  lock.unlock()
  return nil
}

let types: [CGEventType] = [.keyDown, .keyUp, .flagsChanged, .otherMouseDown, .scrollWheel]
guard let created = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .defaultTap,
                                  eventsOfInterest: types.reduce(0) { $0 | CGEventMask(1 << $1.rawValue) },
                                  callback: tailCallback, userInfo: nil) else {
  print("{\"error\":\"no tap\"}")
  exit(2)
}
tailTap = created
CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(kCFAllocatorDefault, created, 0), .commonModes)
CGEvent.tapEnable(tap: created, enable: true)

/// A private source: what is posted from it does not join the session's modifier state.
let source = CGEventSource(stateID: .privateState)!

func post(_ event: CGEvent?) {
  guard let event else { return }
  event.setIntegerValueField(.eventSourceUserData, value: tag)
  lock.lock(); postedAt.append(now()); lock.unlock()
  event.post(tap: .cgSessionEventTap)
}

let f18: CGKeyCode = 79, f19: CGKeyCode = 80, f20: CGKeyCode = 90
let leftCommand: CGKeyCode = 55, rightCommand: CGKeyCode = 54, shift: CGKeyCode = 56, fn: CGKeyCode = 63, rightOption: CGKeyCode = 61

// A modifier's flags as a keyboard sends them: the side-less mask and which side.
let none = CGEventFlags(rawValue: 0x100)
let commandLeft = CGEventFlags(rawValue: 0x100008)
let commandRight = CGEventFlags(rawValue: 0x100010)
let commandBoth = CGEventFlags(rawValue: 0x100018)
let commandShift = CGEventFlags(rawValue: 0x120008 | 0x2)
let fnHeld = CGEventFlags(rawValue: 0x800000)
let fnShift = CGEventFlags(rawValue: 0x820002)
let optionRight = CGEventFlags(rawValue: 0x80040)

func key(_ code: CGKeyCode, down: Bool, _ flags: CGEventFlags) {
  let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
  event?.flags = flags
  post(event)
}
/// A modifier going down or up: `held` is what is held after it.
func modifier(_ code: CGKeyCode, _ held: CGEventFlags) {
  let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: held != none)
  event?.type = .flagsChanged
  event?.flags = held
  post(event)
}
func press(_ code: CGKeyCode, _ flags: CGEventFlags) { key(code, down: true, flags); key(code, down: false, flags) }
func tap(_ code: CGKeyCode = leftCommand, hold: Double = 0.06) {
  modifier(code, code == leftCommand ? commandLeft : commandRight)
  pause(hold)
  modifier(code, none)
}
func shortcut(_ code: CGKeyCode) {
  modifier(leftCommand, commandLeft); pause(0.04); press(code, commandLeft); pause(0.04); modifier(leftCommand, none)
}
func mouseDown() {
  let event = CGEvent(mouseEventSource: source, mouseType: .otherMouseDown, mouseCursorPosition: CGEvent(source: nil)?.location ?? .zero, mouseButton: .center)
  event?.setIntegerValueField(.mouseEventButtonNumber, value: 30)
  post(event)
}
func scroll() {
  post(CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 1, wheel1: 0, wheel2: 0, wheel3: 0))
}

let scenarios: [String: () -> Void] = [
  "canary": { key(f20, down: false, none) },

  "two taps 120 ms apart": { tap(); pause(0.12); tap() },
  "left then right Command": { tap(); pause(0.12); tap(rightCommand) },
  "three taps": { tap(); pause(0.12); tap(); pause(0.12); tap() },
  "Command and a key, then a tap": { shortcut(f19); pause(0.12); tap() },
  "a tap, then Command and a key": { tap(); pause(0.12); shortcut(f19) },
  "Command and a key, twice": { shortcut(f18); pause(0.12); shortcut(f18) },
  "Command held 600 ms, then a tap": { tap(hold: 0.6); pause(0.12); tap() },
  "a tap, then Command held 600 ms": { tap(); pause(0.12); tap(hold: 0.6) },
  "two taps 500 ms apart": { tap(); pause(0.5); tap() },
  "Command-Shift, then a tap": {
    modifier(leftCommand, commandLeft); modifier(shift, commandShift); modifier(shift, commandLeft); modifier(leftCommand, none)
    pause(0.12); tap()
  },
  "both Command keys overlapping": {
    modifier(leftCommand, commandLeft); pause(0.03); modifier(rightCommand, commandBoth); pause(0.03)
    modifier(rightCommand, commandLeft); pause(0.03); modifier(leftCommand, none)
  },
  "Command-click, then a tap": {
    modifier(leftCommand, commandLeft); pause(0.03); mouseDown(); pause(0.03); modifier(leftCommand, none)
    pause(0.12); tap()
  },
  "a tap, a click, a tap": { tap(); pause(0.06); mouseDown(); pause(0.06); tap() },
  "Command-scroll, then a tap": {
    modifier(leftCommand, commandLeft); pause(0.03); scroll(); pause(0.03); modifier(leftCommand, none)
    pause(0.12); tap()
  },
  "a tap, a scroll, a tap": { tap(); pause(0.06); scroll(); pause(0.06); tap() },

  "Fn and the registered key": { modifier(fn, fnHeld); press(f19, fnHeld); modifier(fn, none) },
  "Fn and an unregistered key": { modifier(fn, fnHeld); press(f18, fnHeld); modifier(fn, none) },
  "the registered key alone": { press(f19, none) },
  "the registered key with the Fn flag and no Fn key": { press(f19, fnHeld) },
  "Fn, Shift and the registered key": { modifier(fn, fnHeld); modifier(shift, fnShift); press(f19, fnShift); modifier(shift, fnHeld); modifier(fn, none) },
  "Right Option and the registered key": { modifier(rightOption, optionRight); press(f19, optionRight); modifier(rightOption, none) },
]

Thread.detachNewThread {
  while let scenario = readLine() {
    guard let run = scenarios[scenario] else { say("{\"error\":\"unknown scenario\"}"); continue }
    run()
    // Until nothing more arrives: one run's events after a mouse-down came more than 150 ms late.
    var count = -1
    for _ in 0..<8 {
      pause(0.15)
      lock.lock(); let arrived = reached.count; lock.unlock()
      if arrived == count { break }
      count = arrived
    }
    lock.lock()
    let seen = reached
    let slowest = postedAt.count == reachedAt.count ? zip(postedAt, reachedAt).map { $1 - $0 }.max() ?? 0 : -0.001
    reached = []; postedAt = []; reachedAt = []
    lock.unlock()
    say("{\"scenario\":\"\(scenario)\",\"reached\":[\(seen.map { "\"\($0)\"" }.joined(separator: ","))],\"slowestMs\":\(Int((slowest * 1000).rounded()))}")
    if scenario == "canary", seen != ["keyUp:\(f20)"] {
      say("{\"error\":\"the canary was not removed by this tap; nothing else is posted\"}")
      exit(4)
    }
  }
  exit(0)
}
CFRunLoopRun()
