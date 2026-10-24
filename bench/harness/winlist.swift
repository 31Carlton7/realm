// winlist <pid>...: on-screen windows (layer 0, at least 100x100) owned by any of the pids, one per line.
import CoreGraphics
import Foundation
let pids = Set(CommandLine.arguments.dropFirst().compactMap { Int32($0) })
let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
for w in info {
  guard let pid = w[kCGWindowOwnerPID as String] as? Int32, pids.contains(pid),
        let layer = w[kCGWindowLayer as String] as? Int, layer == 0,
        let b = w[kCGWindowBounds as String] as? [String: CGFloat], (b["Width"] ?? 0) >= 100, (b["Height"] ?? 0) >= 100 else { continue }
  print(pid, Int(b["Width"]!), Int(b["Height"]!))
}
