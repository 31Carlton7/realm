// front: who is in front, read-only, for the quick chat panel's live check
// (../quick-chat-panel-live.mjs). One JSON line per call.
//   front state [pid…]     the frontmost app, the app Accessibility says holds the keyboard, and for each
//                          pid given: activation policy, active/hidden, and its windows as the window
//                          server lists them (level, alpha, sharing state, on screen)
//   front owners <name…>   how many on-screen windows each named owner has (to spot a system dialog)
//   front activate <pid>   hand the front back to an app (only used to restore the app that was in front)
// Build: swiftc -O -o bin/front src/front.swift
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

func json(_ o: Any) { print(String(data: try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]), encoding: .utf8)!) }
let args = Array(CommandLine.arguments.dropFirst())
let all = (CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]]) ?? []

if args.first == "owners" {
  var counts: [String: Int] = [:]
  for w in all where (w[kCGWindowIsOnscreen as String] as? Bool) == true {
    let owner = w[kCGWindowOwnerName as String] as? String ?? "?"
    if args.dropFirst().contains(owner) { counts[owner, default: 0] += 1 }
  }
  json(counts)
  exit(0)
}

if args.first == "activate", args.count == 2, let pid = Int32(args[1]), let app = NSRunningApplication(processIdentifier: pid) {
  json(["activated": app.activate(options: [])])
  exit(0)
}

var result: [String: Any] = [:]
if let f = NSWorkspace.shared.frontmostApplication {
  result["front"] = ["pid": Int(f.processIdentifier), "bundle": f.bundleIdentifier ?? "?"]
  var win: CFTypeRef?
  if AXUIElementCopyAttributeValue(AXUIElementCreateApplication(f.processIdentifier), kAXFocusedWindowAttribute as CFString, &win) == .success, let w = win {
    var fs: CFTypeRef?
    if AXUIElementCopyAttributeValue(w as! AXUIElement, "AXFullScreen" as CFString, &fs) == .success { result["frontWindowFullScreen"] = fs as? Bool ?? false }
  }
}
var focused: CFTypeRef?
if AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute as CFString, &focused) == .success, let app = focused {
  var pid: pid_t = 0
  AXUIElementGetPid(app as! AXUIElement, &pid)
  result["axFocusedAppPid"] = Int(pid)
}
var apps: [String: Any] = [:]
for arg in args.dropFirst() {
  guard let pid = Int32(arg) else { continue }
  var entry: [String: Any] = [:]
  if let app = NSRunningApplication(processIdentifier: pid) {
    entry["policy"] = ["regular", "accessory", "prohibited"][app.activationPolicy.rawValue]
    entry["active"] = app.isActive
    entry["hidden"] = app.isHidden
  }
  entry["windows"] = all.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid }.map { w -> [String: Any] in
    let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    return [
      "id": w[kCGWindowNumber as String] ?? 0, "layer": w[kCGWindowLayer as String] ?? 0, "alpha": w[kCGWindowAlpha as String] ?? 0,
      "sharing": w[kCGWindowSharingState as String] ?? -1, "onscreen": w[kCGWindowIsOnscreen as String] ?? false,
      "w": b["Width"] ?? 0, "h": b["Height"] ?? 0,
    ]
  }.filter { ($0["w"] as? Double ?? 0) > 1 }
  apps[arg] = entry
}
if !apps.isEmpty { result["apps"] = apps }
json(result)
