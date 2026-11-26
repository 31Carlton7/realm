// RealmKeys — macOS helper that reports two gestures from any app, as JSON lines on stdout: a
// double-tap of Command, and a key pressed while one chosen modifier is held alone (Fn by default).
//
// Why: Electron's globalShortcut sits on the public hot-key API, which cannot see a bare modifier or
// Fn. A session event tap can. Main (main/realm-keys.ts) starts this only while something needs it.
//
// What it reads and what it says. The tap sees key-down, key-up and modifier changes. It never
// prints, stores or sends a key: the only lines are {"t":"doubleTap"}, {"t":"chord","code":N} for a
// key code main registered, and {"t":"hold","down":…} for the chosen modifier while Settings asks.
//
// What it swallows. Only the key-down and key-up of a registered chord, pressed while the modifier is
// down with no other modifier. Everything else is returned untouched, the modifier's own
// flagsChanged included. With no chords registered it swallows nothing.
//
// Fn goes by its own key (code 63) being down, never by the flag on a key event alone: arrows,
// Home/End and the F-row carry that flag without Fn.
//
// Permission, checked and never asked for. Swallowing needs Accessibility (an active tap). Without
// it, and with Input Monitoring, the tap is listen-only: the double-tap still fires and chords are
// reported but reach the app in front. With neither, no tap is made and the helper exits 2.
//
// An active tap holds every key until its callback returns, so a helper that is slow to be scheduled
// stalls typing in every app. Without --swallow, which main passes only while a chord is registered,
// the helper never makes one. With Accessibility and no Input Monitoring that leaves it no tap to
// make, since a listen-only tap could raise the Input Monitoring prompt: it exits 3, and Settings
// names Input Monitoring. `tapPlan` is the whole choice, and `realmkeys plan` prints it.
//
// Clicks and scrolls end a double-tap (Command-click, Command-scroll). Beside an active key tap they
// are watched by a second, listen-only one, so the active one never sits in the path of the pointer.
// With Accessibility and no Input Monitoring there is no listen access to watch them with, so
// --swallow gets the key tap alone there, and a click between two taps no longer resets the double-tap.
//
// THE TAP CALLBACK MUST NOT DO I/O (ScrollPhase.swift says what happens when it does): it decides
// under a lock and appends to a buffer; a writer thread prints.
//
// From main on stdin, one JSON object per line, each replacing the last:
//   {"doubleTap":true,"command":"left","maxHold":0.25,"maxGap":0.3,"hold":"fn","chords":[49,37],"reportHold":false}
// `command` is left, right or either: the Command key the double-tap is read on, left when absent.
// `hold` is fn, rightOption or rightCommand. Until the first line arrives nothing is reported.
//
//   realmkeys            the tap. Exits when stdin closes (parent gone).
//   realmkeys --swallow  the tap, able to swallow a registered chord.
//   realmkeys plan       no tap, and no permission read: prints the taps the helper would make, or
//                        the code it would exit with, for each case of the two grants and --swallow.
//   realmkeys decide     no tap: reads the same config lines plus events, and prints what the tap
//                        would do with each as {"swallow":…,"out":[…]}. Events, times in seconds:
//                          flags <t> <keycode> <flags>     down <t> <keycode> <flags> [repeat]
//                          up <t> <keycode> <flags>        pointer <t>
//                          missed <t>                      the tap was paused and lost events
//
// For a proof run on a Mac someone is typing on (scripts/realm-keys-live.mjs):
//   --only-tagged <n>    act only on events whose source user data is n; every other event is
//                        returned untouched and unread
//   --exit-after <s>     quit after s seconds
//
// Build: swiftc -O -o bin/realmkeys RealmKeys.swift   (see scripts/build-native.mjs)

import ApplicationServices
import CoreGraphics
import Foundation

let modifierBits: CGEventFlags = [.maskCommand, .maskShift, .maskControl, .maskAlternate, .maskSecondaryFn]

// Which side a modifier is on (IOKit's NX_DEVICE*KEYMASK): the event's flags carry these beside the
// side-less masks.
let leftCommandBit: UInt64 = 0x08
let rightCommandBit: UInt64 = 0x10
let leftOptionBit: UInt64 = 0x20
let rightOptionBit: UInt64 = 0x40

enum CommandSide: String {
  case left, right, either

  func matches(_ keycode: Int64) -> Bool {
    switch self { case .left: return keycode == 55; case .right: return keycode == 54; case .either: return keycode == 55 || keycode == 54 }
  }
}

/// Two taps of Command with nothing between.
/// A tap is: the chosen Command key goes down with no other modifier held, and comes up within
/// `maxHold` with no key, no click, no scroll, no other modifier and no second Command in between.
/// Two taps whose gap (first release to second press) is within `maxGap` fire, on the second
/// RELEASE, so a second press that turns into Command-C never fires. The other Command key, while
/// only one is chosen, is another modifier: a tap of it between two taps of the chosen one ends the pair.
struct DoubleTap {
  var side = CommandSide.left
  var maxHold = 0.25
  var maxGap = 0.30
  private var downAt: Double?
  private var lastTapUp: Double?
  private var firstOfPair = false
  private var poisoned = false

  /// A flagsChanged event. `flags` is what is held after it. Returns true when the double-tap fires.
  mutating func flags(_ flags: CGEventFlags, keycode: Int64, at t: Double) -> Bool {
    let held = flags.intersection(modifierBits)
    let isCommandKey = side.matches(keycode)
    if held.isEmpty {
      defer { downAt = nil; poisoned = false }
      guard let d = downAt, !poisoned, isCommandKey, t - d <= maxHold else { lastTapUp = nil; return false }
      if firstOfPair { lastTapUp = nil; return true }
      lastTapUp = t
      return false
    }
    if held == .maskCommand, isCommandKey, downAt == nil, !poisoned {
      downAt = t
      firstOfPair = lastTapUp.map { t - $0 <= maxGap } ?? false
      return false
    }
    poisoned = true
    lastTapUp = nil
    return false
  }

  /// A key down, a mouse button or a scroll, while or between presses.
  mutating func other() {
    if downAt != nil { poisoned = true }
    lastTapUp = nil
  }
}

enum HoldKey: String {
  case fn, rightOption, rightCommand

  var keycode: Int64 {
    switch self { case .fn: return 63; case .rightOption: return 61; case .rightCommand: return 54 }
  }

  /// After a flagsChanged of this key: whether it is now down.
  func isDown(_ flags: CGEventFlags) -> Bool {
    switch self {
    case .fn: return flags.contains(.maskSecondaryFn)
    case .rightOption: return flags.rawValue & rightOptionBit != 0
    case .rightCommand: return flags.rawValue & rightCommandBit != 0
    }
  }

  /// Whether a key event was pressed with this modifier and no other.
  func isAlone(_ flags: CGEventFlags) -> Bool {
    let held = flags.intersection([.maskCommand, .maskShift, .maskControl, .maskAlternate])
    switch self {
    case .fn: return flags.contains(.maskSecondaryFn) && held.isEmpty
    case .rightOption: return held == .maskAlternate && flags.rawValue & leftOptionBit == 0
    case .rightCommand: return held == .maskCommand && flags.rawValue & leftCommandBit == 0
    }
  }
}

/// Which key events belong to a registered chord.
struct Chords {
  var hold = HoldKey.fn { didSet { if hold != oldValue { holdDown = false } } }
  var registered: Set<Int64> = []
  private var holdDown = false
  /// Key codes whose down was swallowed, so their up is swallowed too, even after the modifier lifts.
  private var swallowedDown: Set<Int64> = []

  /// A flagsChanged event. Returns the modifier's new state when it changed.
  mutating func flags(_ flags: CGEventFlags, keycode: Int64) -> Bool? {
    guard keycode == hold.keycode else { return nil }
    let down = hold.isDown(flags)
    guard down != holdDown else { return nil }
    holdDown = down
    return down
  }

  /// A key event. `fired` is true once per press of a registered chord, not for its repeats.
  mutating func key(down: Bool, keycode: Int64, flags: CGEventFlags, isRepeat: Bool) -> (swallow: Bool, fired: Bool) {
    if !down { return (swallowedDown.remove(keycode) != nil, false) }
    // Still held after the modifier lifted: its repeats belong to the chord, not to the app in front.
    if isRepeat, swallowedDown.contains(keycode) { return (true, false) }
    // The event's own flags must agree that the modifier is held: a missed release (the tap was
    // paused) would otherwise leave every registered key swallowed while it is typed alone.
    guard holdDown, hold.isAlone(flags), registered.contains(keycode) else {
      // A new press that passes: an up this key was owed is no longer coming, and the next up is its own.
      swallowedDown.remove(keycode)
      return (false, false)
    }
    swallowedDown.insert(keycode)
    return (true, !isRepeat)
  }

  /// The tap missed events: the modifier may have lifted unseen, and so may a swallowed key.
  mutating func forget() {
    holdDown = false
    swallowedDown.removeAll()
  }
}

enum Input {
  case flags(keycode: Int64, flags: CGEventFlags)
  case key(down: Bool, keycode: Int64, flags: CGEventFlags, isRepeat: Bool)
  /// A mouse button or a scroll.
  case pointer
}

/// What to do with one event: whether to swallow it, and what to tell main.
struct Decider {
  private var doubleTapOn = false
  private var reportHold = false
  private var rule = DoubleTap()
  private var chords = Chords()

  mutating func handle(_ input: Input, at t: Double) -> (swallow: Bool, lines: [String]) {
    switch input {
    case let .flags(keycode, flags):
      var lines: [String] = []
      if let down = chords.flags(flags, keycode: keycode), reportHold { lines.append("{\"t\":\"hold\",\"down\":\(down)}") }
      if rule.flags(flags, keycode: keycode, at: t), doubleTapOn { lines.append("{\"t\":\"doubleTap\"}") }
      return (false, lines)
    case let .key(down, keycode, flags, isRepeat):
      if down { rule.other() }
      let chord = chords.key(down: down, keycode: keycode, flags: flags, isRepeat: isRepeat)
      return (chord.swallow, chord.fired ? ["{\"t\":\"chord\",\"code\":\(keycode)}"] : [])
    case .pointer:
      rule.other()
      return (false, [])
    }
  }

  /// One line from main. False when it is not a config this helper understands; nothing changes then.
  mutating func configure(_ line: String) -> Bool {
    guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)), let config = object as? [String: Any],
          let hold = HoldKey(rawValue: config["hold"] as? String ?? ""), let codes = config["chords"] as? [Int] else { return false }
    doubleTapOn = config["doubleTap"] as? Bool ?? false
    reportHold = config["reportHold"] as? Bool ?? false
    if let maxHold = config["maxHold"] as? Double { rule.maxHold = maxHold }
    if let maxGap = config["maxGap"] as? Double { rule.maxGap = maxGap }
    rule.side = CommandSide(rawValue: config["command"] as? String ?? "") ?? .left
    chords.hold = hold
    chords.registered = Set(codes.map(Int64.init))
    return true
  }

  mutating func forget() {
    chords.forget()
    rule.other()
  }
}

struct TapSpec {
  let active: Bool
  let keys: Bool
  let pointer: Bool
}

enum TapPlan {
  case taps([TapSpec])
  /// macOS grants neither Accessibility nor Input Monitoring.
  case denied
  /// Accessibility without Input Monitoring, and nothing to swallow: the only tap macOS would allow
  /// is an active one.
  case needsListenAccess

  var exitCode: Int32? {
    switch self { case .taps: return nil; case .denied: return 2; case .needsListenAccess: return 3 }
  }
}

/// Which taps to make. `canSwallow` is Accessibility, `canListen` is Input Monitoring, and `swallow`
/// is main asking for a helper that can keep a chord back.
func tapPlan(canSwallow: Bool, canListen: Bool, swallow: Bool) -> TapPlan {
  if canListen {
    guard canSwallow, swallow else { return .taps([TapSpec(active: false, keys: true, pointer: true)]) }
    return .taps([TapSpec(active: true, keys: true, pointer: false), TapSpec(active: false, keys: false, pointer: true)])
  }
  guard canSwallow else { return .denied }
  return swallow ? .taps([TapSpec(active: true, keys: true, pointer: false)]) : .needsListenAccess
}

let arguments = Array(CommandLine.arguments.dropFirst())

if arguments.first == "plan" {
  for canSwallow in [false, true] {
    for canListen in [false, true] {
      for swallow in [false, true] {
        let plan = tapPlan(canSwallow: canSwallow, canListen: canListen, swallow: swallow)
        var taps: [String] = []
        if case let .taps(specs) = plan {
          taps = specs.map { "{\"options\":\"\($0.active ? "default" : "listenOnly")\",\"keys\":\($0.keys),\"pointer\":\($0.pointer)}" }
        }
        let exits = plan.exitCode.map { ",\"exit\":\($0)" } ?? ""
        print("{\"accessibility\":\(canSwallow),\"inputMonitoring\":\(canListen),\"swallow\":\(swallow),\"taps\":[\(taps.joined(separator: ","))]\(exits)}")
      }
    }
  }
  exit(0)
}

if arguments.first == "decide" {
  var decider = Decider()
  while let line = readLine() {
    if line.hasPrefix("{") {
      if !decider.configure(line) { print("{\"error\":\"config\"}") }
      continue
    }
    let parts = line.split(separator: " ").map(String.init)
    guard parts.count >= 2, let t = Double(parts[1]) else { print("{\"error\":\"event\"}"); continue }
    if parts[0] == "missed" { decider.forget(); continue }
    let keycode = parts.count > 2 ? Int64(parts[2]) ?? 0 : 0
    let flags = CGEventFlags(rawValue: parts.count > 3 ? UInt64(parts[3]) ?? 0 : 0)
    let input: Input
    switch parts[0] {
    case "flags": input = .flags(keycode: keycode, flags: flags)
    case "down": input = .key(down: true, keycode: keycode, flags: flags, isRepeat: parts.last == "repeat")
    case "up": input = .key(down: false, keycode: keycode, flags: flags, isRepeat: false)
    case "pointer": input = .pointer
    default: print("{\"error\":\"event\"}"); continue
    }
    let decision = decider.handle(input, at: t)
    print("{\"swallow\":\(decision.swallow),\"out\":[\(decision.lines.joined(separator: ","))]}")
  }
  exit(0)
}

func argument(after name: String) -> String? {
  guard let at = arguments.firstIndex(of: name), at + 1 < arguments.count else { return nil }
  return arguments[at + 1]
}
let onlyTagged = argument(after: "--only-tagged").flatMap { Int64($0) }

/// The decider behind one lock, and the hand-off from the tap callback to the writer thread.
final class Keys {
  private let cond = NSCondition()
  private var decider = Decider()
  private var pending: [String] = []

  func take(_ input: Input, at t: Double) -> Bool {
    cond.lock()
    let decision = decider.handle(input, at: t)
    if !decision.lines.isEmpty {
      pending.append(contentsOf: decision.lines)
      cond.signal()
    }
    cond.unlock()
    return decision.swallow
  }

  func configure(_ line: String) {
    cond.lock()
    _ = decider.configure(line)
    cond.unlock()
  }

  func forget() {
    cond.lock()
    decider.forget()
    cond.unlock()
  }

  func runWriter() -> Never {
    while true {
      cond.lock()
      while pending.isEmpty { cond.wait() }
      let lines = pending
      pending.removeAll(keepingCapacity: true)
      cond.unlock()
      for line in lines { print(line) }
      fflush(stdout)
    }
  }
}

let keys = Keys()
var taps: [CFMachPort] = []

let callback: CGEventTapCallBack = { _, type, event, _ in
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    keys.forget()
    for tap in taps { CGEvent.tapEnable(tap: tap, enable: true) }
    return Unmanaged.passUnretained(event)
  }
  if let tag = onlyTagged, event.getIntegerValueField(.eventSourceUserData) != tag { return Unmanaged.passUnretained(event) }
  let input: Input
  switch type {
  case .flagsChanged:
    input = .flags(keycode: event.getIntegerValueField(.keyboardEventKeycode), flags: event.flags)
  case .keyDown, .keyUp:
    input = .key(down: type == .keyDown, keycode: event.getIntegerValueField(.keyboardEventKeycode), flags: event.flags,
                 isRepeat: event.getIntegerValueField(.keyboardEventAutorepeat) != 0)
  default:
    input = .pointer
  }
  let swallow = keys.take(input, at: Double(DispatchTime.now().uptimeNanoseconds) / 1e9)
  return swallow ? nil : Unmanaged.passUnretained(event)
}

func mask(_ types: CGEventType...) -> CGEventMask { types.reduce(0) { $0 | CGEventMask(1 << $1.rawValue) } }
let keyMask = mask(.keyDown, .keyUp, .flagsChanged)
let pointerMask = mask(.leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel)

func install(_ eventMask: CGEventMask, options: CGEventTapOptions) {
  guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: options,
                                    eventsOfInterest: eventMask, callback: callback, userInfo: nil) else {
    FileHandle.standardError.write("realmkeys: could not create event tap\n".data(using: .utf8)!)
    exit(2)
  }
  taps.append(tap)
  CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0), .commonModes)
  CGEvent.tapEnable(tap: tap, enable: true)
}

// Check-only calls: none of these asks.
let canSwallow = AXIsProcessTrusted() && CGPreflightPostEventAccess()
let canListen = CGPreflightListenEventAccess()
let plan = tapPlan(canSwallow: canSwallow, canListen: canListen, swallow: arguments.contains("--swallow"))
if let code = plan.exitCode {
  let why = code == 2 ? "neither Accessibility nor Input Monitoring is granted" : "Input Monitoring is not granted, and no chord needs an active tap"
  FileHandle.standardError.write("realmkeys: \(why); no tap was made\n".data(using: .utf8)!)
  exit(code)
}

// Watch stdin: config lines from main, and when the parent closes it, quit.
Thread.detachNewThread {
  while let line = readLine() { keys.configure(line) }
  exit(0)
}

if let seconds = argument(after: "--exit-after").flatMap({ Double($0) }) {
  DispatchQueue.global().asyncAfter(deadline: .now() + seconds) { exit(0) }
}

if case let .taps(specs) = plan {
  for spec in specs {
    install((spec.keys ? keyMask : 0) | (spec.pointer ? pointerMask : 0), options: spec.active ? .defaultTap : .listenOnly)
  }
}
// What macOS allows, not which tap is installed: Settings reads it to say whether a chord could be kept back.
print("{\"ready\":true,\"active\":\(canSwallow)}")
fflush(stdout)

let writer = Thread { keys.runWriter() }
writer.name = "realmkeys.writer"
writer.qualityOfService = .userInteractive
writer.start()

CFRunLoopRun()
