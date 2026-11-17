#if DEBUG
import QuartzCore
import UIKit

/// Each frame's length as the display link sees it, written to `Caches/frames.log` as "wall-clock
/// seconds, frame milliseconds" lines, so a script driving a scroll on the simulator can read the frames
/// it caused. Started by `-frameMeter YES`; never in a release build.
@MainActor
final class FrameMeter: NSObject {
    static let shared = FrameMeter()
    private var link: CADisplayLink?
    private var last: CFTimeInterval = 0
    private var lines: [String] = []
    private let file = URL.cachesDirectory.appending(path: "frames.log")

    func start() {
        try? Data().write(to: file)
        link = CADisplayLink(target: self, selector: #selector(tick(_:)))
        link?.add(to: .main, forMode: .common)
    }

    @objc private func tick(_ link: CADisplayLink) {
        if last > 0 { lines.append(String(format: "%.4f %.2f", Date().timeIntervalSince1970, (link.timestamp - last) * 1000)) }
        last = link.timestamp
        if lines.count >= 60, let handle = try? FileHandle(forWritingTo: file) {
            handle.seekToEndOfFile()
            handle.write(Data((lines.joined(separator: "\n") + "\n").utf8))
            try? handle.close()
            lines.removeAll(keepingCapacity: true)
        }
    }
}
#endif
