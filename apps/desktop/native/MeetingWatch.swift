// MeetingWatch: what Realm has to know to tell that a meeting or a call is starting. Two modes, each
// printing JSON lines on stdout and quitting when stdin closes (parent gone).
//
//   meetingwatch calendar [--events <file>]
//     {"access":"full"}            Calendar access for the app macOS holds responsible: full, writeOnly,
//                                  denied, restricted or notDetermined. Read with the check-only call.
//     {"events":[…]}               with full access, every calendar's events over the next day: id,
//                                  title, start and end (ms since 1970), allDay, cancelled, the user's
//                                  own participation, and the url, location and notes a meeting link
//                                  can be in. Printed again when the store changes.
//     stdin "ask"                  the one thing that makes macOS ask (requestFullAccessToEvents).
//                                  Main sends it only for the button in Settings.
//     stdin "check"                read the access and the events again.
//     --events <file>              events from a JSON file in place of the calendar, for checks: each
//                                  is made into an EKEvent and goes out through the same code. The
//                                  access is not read and nothing is asked.
//
//   meetingwatch calls [--screen-recording granted|denied]
//     {"holders":["us.zoom.xos"],"titled":[{"app":"com.google.Chrome","service":"Google Meet"}]}
//                                  holders: the bundle ids of the processes Core Audio says are running
//                                  input. Properties only: no device is opened and no audio is read, so
//                                  no permission is needed.
//                                  titled: apps with a window whose title names a call, read only while
//                                  somebody holds the microphone and only when Screen Recording is
//                                  already granted (the preflight, never the request). A title is
//                                  matched here and goes nowhere: not printed, not kept.
//     --screen-recording <answer>  that answer in place of the preflight, for checks.
//
// Measured on macOS 27.3: a listener on a process's kAudioProcessPropertyIsRunningInput never fires.
// A device's kAudioDevicePropertyDeviceIsRunningSomewhere fires when a process starts input, also a
// second one, but not when one of two lets go. So the device listeners cover a start, and while
// anybody holds the microphone the list is read again once a second.
//
// Build: swiftc -O -o bin/meetingwatch MeetingWatch.swift   (see scripts/build-native.mjs)

import AppKit
import CoreAudio
import CoreGraphics
import EventKit
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

func printJSON(_ object: [String: Any]) {
  guard let json = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
  print(String(decoding: json, as: UTF8.self))
}

/// Runs `command` on the main queue for each line of stdin, and quits when stdin closes.
func readCommands(_ command: @escaping (String) -> Void) {
  Thread.detachNewThread {
    while let line = readLine() { DispatchQueue.main.async { command(line) } }
    exit(0)
  }
}

// ── Calendar ─────────────────────────────────────────────────────────────────────────────────────

func calendarAccess() -> String {
  let status = EKEventStore.authorizationStatus(for: .event)
  if #available(macOS 14.0, *) {
    if status == .fullAccess { return "full" }
    if status == .writeOnly { return "writeOnly" }
  } else if status == .authorized {
    return "full"
  }
  switch status {
  case .denied: return "denied"
  case .restricted: return "restricted"
  default: return "notDetermined"
  }
}

func participation(_ event: EKEvent) -> String {
  guard let me = event.attendees?.first(where: { $0.isCurrentUser }) else { return "none" }
  switch me.participantStatus {
  case .accepted: return "accepted"
  case .declined: return "declined"
  case .tentative: return "tentative"
  default: return "pending"
  }
}

func milliseconds(_ date: Date) -> Int { Int((date.timeIntervalSince1970 * 1000).rounded()) }

func describe(_ event: EKEvent, id: String? = nil) -> [String: Any] {
  [
    "id": id ?? event.eventIdentifier ?? "",
    "title": event.title ?? "",
    "start": milliseconds(event.startDate),
    "end": milliseconds(event.endDate),
    "allDay": event.isAllDay,
    "cancelled": event.status == .canceled,
    "participation": participation(event),
    "url": event.url?.absoluteString ?? "",
    "location": event.location ?? "",
    "notes": event.notes ?? "",
  ]
}

func watchCalendar(eventsFile: String?) {
  let store = EKEventStore()
  var lastAccess: String?
  var lastEvents: String?

  func printEvents(_ events: [[String: Any]]) {
    guard let json = try? JSONSerialization.data(withJSONObject: ["events": events], options: [.sortedKeys]) else { return }
    let line = String(decoding: json, as: UTF8.self)
    if line != lastEvents {
      lastEvents = line
      print(line)
    }
  }

  /// The file's events, each made into an event of the store (never saved) so it is described by the
  /// code a calendar's own are. A file cannot set an attendee or a status, so those two are carried over.
  func eventsFromFile(_ path: String) -> [[String: Any]] {
    guard let bytes = FileManager.default.contents(atPath: path),
          let rows = try? JSONSerialization.jsonObject(with: bytes) as? [[String: Any]] else { return [] }
    return rows.map { row in
      let event = EKEvent(eventStore: store)
      event.title = row["title"] as? String
      event.startDate = Date(timeIntervalSince1970: (row["start"] as? Double ?? 0) / 1000)
      event.endDate = Date(timeIntervalSince1970: (row["end"] as? Double ?? 0) / 1000)
      event.isAllDay = row["allDay"] as? Bool ?? false
      event.url = (row["url"] as? String).flatMap { URL(string: $0) }
      event.location = row["location"] as? String
      event.notes = row["notes"] as? String
      var described = describe(event, id: row["id"] as? String)
      described["cancelled"] = row["cancelled"] as? Bool ?? false
      described["participation"] = row["participation"] as? String ?? "none"
      return described
    }
  }

  func look() {
    if let eventsFile {
      if lastAccess == nil { lastAccess = "full"; printJSON(["access": "full"]) }
      printEvents(eventsFromFile(eventsFile))
      return
    }
    let access = calendarAccess()
    if access != lastAccess {
      lastAccess = access
      lastEvents = nil
      printJSON(["access": access])
    }
    guard access == "full" else { return }
    let now = Date()
    let nextDay = store.predicateForEvents(withStart: now, end: now.addingTimeInterval(24 * 60 * 60), calendars: nil)
    printEvents(store.events(matching: nextDay).map { describe($0) })
  }

  look()
  NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: store, queue: .main) { _ in look() }
  // The next day moves on with the clock, and a grant changed in System Settings posts nothing.
  Timer.scheduledTimer(withTimeInterval: 10 * 60, repeats: true) { _ in look() }
  readCommands { command in
    if command == "check" { look() }
    guard command == "ask", eventsFile == nil else { return }
    let answered: (Bool, Error?) -> Void = { _, _ in DispatchQueue.main.async { look() } }
    if #available(macOS 14.0, *) {
      store.requestFullAccessToEvents(completion: answered)
    } else {
      store.requestAccess(to: .event, completion: answered)
    }
  }
}

// ── Calls ────────────────────────────────────────────────────────────────────────────────────────

func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

func audioObjects(_ selector: AudioObjectPropertySelector) -> [AudioObjectID] {
  let system = AudioObjectID(kAudioObjectSystemObject)
  var a = address(selector)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(system, &a, 0, nil, &size) == noErr else { return [] }
  var list = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(system, &a, 0, nil, &size, &list) == noErr else { return [] }
  return list
}

/// The bundle ids of the processes running input, sorted. A process with no bundle id is left out:
/// nothing can be said about what it is.
@available(macOS 14.2, *)
func microphoneHolders() -> [String] {
  var holders = Set<String>()
  for process in audioObjects(kAudioHardwarePropertyProcessObjectList) {
    var running: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    var a = address(kAudioProcessPropertyIsRunningInput)
    guard AudioObjectGetPropertyData(process, &a, 0, nil, &size, &running) == noErr, running != 0 else { continue }
    var bundle: Unmanaged<CFString>?
    size = UInt32(MemoryLayout<CFString?>.size)
    a = address(kAudioProcessPropertyBundleID)
    guard AudioObjectGetPropertyData(process, &a, 0, nil, &size, &bundle) == noErr, let id = bundle?.takeRetainedValue() as String?, !id.isEmpty else { continue }
    holders.insert(id)
  }
  return holders.sorted()
}

let callTitles: [(service: String, pattern: NSRegularExpression)] = [
  ("Google Meet", #"\bMeet [-–] [a-z]{3}-[a-z]{4}-[a-z]{3}\b"#),
  ("Zoom", #"\bZoom\b"#),
  ("Microsoft Teams", #"\bMicrosoft Teams\b"#),
  ("Webex", #"\bWebex\b"#),
].map { ($0.0, try! NSRegularExpression(pattern: $0.1)) }

/// The apps with an ordinary window whose title names a call, as "bundle id, service" pairs. Every
/// window is listed, not only those on screen: a call's tab is often on another desktop. macOS fills
/// in another app's titles only with Screen Recording, so without it this finds nothing.
func appsWithCallTitles() -> [[String: String]] {
  let windows = (CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
  var bundles: [pid_t: String?] = [:]
  var found = Set<[String]>()
  for window in windows {
    guard (window[kCGWindowLayer as String] as? Int) == 0,
          let title = window[kCGWindowName as String] as? String, !title.isEmpty,
          let pid = window[kCGWindowOwnerPID as String] as? pid_t else { continue }
    let range = NSRange(title.startIndex..., in: title)
    guard let service = callTitles.first(where: { $0.pattern.firstMatch(in: title, range: range) != nil })?.service else { continue }
    if bundles[pid] == nil { bundles[pid] = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier }
    if let bundle = bundles[pid] ?? nil { found.insert([bundle, service]) }
  }
  return found.sorted { $0.joined() < $1.joined() }.map { ["app": $0[0], "service": $0[1]] }
}

@available(macOS 14.2, *)
func watchCalls(screenRecording: Bool?) {
  var holders: [String] = []
  var last: String?

  func look() {
    holders = microphoneHolders()
    let mayReadTitles = screenRecording ?? CGPreflightScreenCaptureAccess()
    let titled = !holders.isEmpty && mayReadTitles ? appsWithCallTitles() : []
    guard let json = try? JSONSerialization.data(withJSONObject: ["holders": holders, "titled": titled], options: [.sortedKeys]) else { return }
    let line = String(decoding: json, as: UTF8.self)
    if line != last {
      last = line
      print(line)
    }
  }

  // A device plugged in later gets its listener then.
  var heard = Set<AudioObjectID>()
  func listenToDevices() {
    for device in audioObjects(kAudioHardwarePropertyDevices) where heard.insert(device).inserted {
      var a = address(kAudioDevicePropertyDeviceIsRunningSomewhere)
      AudioObjectAddPropertyListenerBlock(device, &a, .main) { _, _ in look() }
    }
  }
  for selector in [kAudioHardwarePropertyDevices, kAudioHardwarePropertyProcessObjectList] {
    var a = address(selector)
    AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &a, .main) { _, _ in
      listenToDevices()
      look()
    }
  }
  listenToDevices()
  look()
  Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in if !holders.isEmpty { look() } }
  readCommands { _ in }
}

// ── Modes ────────────────────────────────────────────────────────────────────────────────────────

let arguments = Array(CommandLine.arguments.dropFirst())
func value(after flag: String) -> String? {
  guard let at = arguments.firstIndex(of: flag), at + 1 < arguments.count else { return nil }
  return arguments[at + 1]
}

switch arguments.first {
case "calendar":
  watchCalendar(eventsFile: value(after: "--events"))
case "calls":
  guard #available(macOS 14.2, *) else {
    // Core Audio has no list of processes before 14.2, so nobody is ever reported holding.
    printJSON(["holders": [String](), "titled": [[String: String]]()])
    readCommands { _ in }
    break
  }
  let answer = value(after: "--screen-recording")
  watchCalls(screenRecording: answer.map { $0 == "granted" })
default:
  FileHandle.standardError.write("usage: meetingwatch calendar [--events <file>] | calls [--screen-recording granted|denied]\n".data(using: .utf8)!)
  exit(2)
}
RunLoop.main.run()
