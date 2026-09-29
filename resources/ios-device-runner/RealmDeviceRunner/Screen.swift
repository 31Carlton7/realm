import Foundation
import UIKit
import XCTest

/// What is on the phone right now: which app is in front, its element tree, and a picture.
@MainActor
enum Screen {
    static let springboardId = "com.apple.springboard"

    /// The app in the foreground. The accessibility client names the active applications by pid;
    /// the XCTest daemon turns each pid into a bundle id; and the one running in the foreground is
    /// kept. SpringBoard when no other app is — the home screen, or the lock screen.
    ///
    /// MEASURED on Xcode 27: `+[XCUIApplication applicationWithPID:]`, which WebDriverAgent and
    /// Maestro use for the second step, is gone; the daemon's `requestApplicationSpecifierForPID:`
    /// answers instead. The older call is still tried, for an older Xcode. And SpringBoard is never
    /// in the active list at all, so it is the fallback rather than a candidate.
    static func foregroundApp() async -> (app: XCUIApplication, bundleId: String) {
        var candidates: [(app: XCUIApplication, bundleId: String)] = []
        for pid in activePids() {
            guard let id = await knownBundleId(forPid: pid), id != springboardId else { continue }
            candidates.append((XCUIApplication(bundleIdentifier: id), id))
        }
        return candidates.first { $0.app.state == .runningForeground } ?? (XCUIApplication(bundleIdentifier: springboardId), springboardId)
    }

    /// A pid's bundle id, asked of the daemon once per process: an app keeps its pid for as long as it
    /// runs, and every read of the screen would otherwise pay an XPC round trip per active app for an
    /// answer that has not changed.
    private static var bundleIds: [Int32: String] = [:]

    private static func knownBundleId(forPid pid: Int32) async -> String? {
        if let known = bundleIds[pid] { return known }
        var id = await bundleId(forPid: pid)
        if id == nil, let app = applicationWithPid(pid) {
            let named = bundleId(of: app)
            id = named.isEmpty ? nil : named
        }
        if let id { bundleIds[pid] = id }
        return id
    }

    private static func activePids() -> [Int32] {
        let device = XCUIDevice.shared as NSObject
        let interface = NSSelectorFromString("accessibilityInterface")
        guard device.responds(to: interface),
              let client = device.perform(interface)?.takeUnretainedValue() as? NSObject else { return [] }
        let active = NSSelectorFromString("activeApplications")
        guard client.responds(to: active),
              let elements = client.perform(active)?.takeUnretainedValue() as? [NSObject] else { return [] }
        return elements.compactMap { ($0.value(forKey: "processIdentifier") as? NSNumber)?.int32Value }.filter { $0 > 0 }
    }

    private static func bundleId(forPid pid: Int32) async -> String? {
        guard let cls = NSClassFromString("XCTRunnerDaemonSession"),
              let shared = class_getClassMethod(cls, NSSelectorFromString("sharedSession")) else { return nil }
        typealias Shared = @convention(c) (AnyClass, Selector) -> NSObject
        let session = unsafeBitCast(method_getImplementation(shared), to: Shared.self)(cls, NSSelectorFromString("sharedSession"))
        let selector = NSSelectorFromString("requestApplicationSpecifierForPID:reply:")
        guard session.responds(to: selector) else { return nil }
        typealias Request = @convention(c) (NSObject, Selector, Int32, @escaping @convention(block) (AnyObject?, NSError?) -> Void) -> Void
        let request = unsafeBitCast(session.method(for: selector), to: Request.self)
        let specifier: AnyObject? = await withCheckedContinuation { done in
            request(session, selector, pid) { specifier, _ in done.resume(returning: specifier) }
        }
        return (specifier as? NSObject)?.value(forKey: "bundleIdentifier") as? String
    }

    private static func applicationWithPid(_ pid: Int32) -> XCUIApplication? {
        let selector = NSSelectorFromString("applicationWithPID:")
        guard let method = class_getClassMethod(XCUIApplication.self, selector) else { return nil }
        typealias WithPid = @convention(c) (AnyClass, Selector, Int32) -> XCUIApplication?
        return unsafeBitCast(method_getImplementation(method), to: WithPid.self)(XCUIApplication.self, selector, pid)
    }

    static func bundleId(of app: XCUIApplication) -> String {
        (app as NSObject).value(forKey: "bundleID") as? String ?? ""
    }

    /// The screen in POINTS, portrait, from SpringBoard's own frame, and how many pixels a point is.
    static func size() -> [String: Any] {
        let frame = XCUIApplication(bundleIdentifier: springboardId).frame
        return ["width": finite(frame.width), "height": finite(frame.height), "scale": Double(UIScreen.main.scale)]
    }

    /// Which app is in front, and nothing about what it shows: the question to answer before anything
    /// else is asked of a phone somebody may be using.
    static func foreground() async -> [String: Any] {
        return ["bundleId": await foregroundApp().bundleId]
    }

    /// The foreground app's tree: every node with its XCUIElement type number, the names the app
    /// gives it, and its frame in points. Mapping the type numbers to words is Realm's job. `ms` says
    /// where the time went, because a read is the step every walk waits on.
    static func hierarchy() async throws -> [String: Any] {
        let t0 = Date()
        let front = await foregroundApp()
        let t1 = Date()
        let snapshot = try front.app.snapshot()
        let t2 = Date()
        let tree = node(snapshot)
        let ms = { (a: Date, b: Date) in Int((b.timeIntervalSince(a) * 1000).rounded()) }
        return ["bundleId": front.bundleId, "tree": tree, "ms": ["foreground": ms(t0, t1), "snapshot": ms(t1, t2), "walk": ms(t2, Date())]]
    }

    /// Every element of the foreground app whose frame holds a point, smallest first. Not "the one on
    /// top": the tree's order is not the screen's stacking order — MEASURED on iOS 27, Settings lists
    /// its floating toolbar BEFORE the list it floats over — so what can be said for certain is which
    /// elements are at the point at all.
    static func at(_ point: CGPoint) async throws -> [XCUIElementSnapshot] {
        let front = await foregroundApp()
        var here: [XCUIElementSnapshot] = []
        func walk(_ s: XCUIElementSnapshot) {
            if s.frame.contains(point) { here.append(s) }
            for child in s.children { walk(child) }
        }
        walk(try front.app.snapshot())
        return here.sorted { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
    }

    /// A key or button that starts dictation — the keyboard's microphone, or the one inside a search
    /// field — by the identifier the system gives it, or else by its name.
    static func isDictation(_ s: XCUIElementSnapshot) -> Bool {
        let id = s.identifier.lowercased(), label = s.label.lowercased()
        return id == "dictation" || label == "dictate" || label.hasPrefix("dictation")
    }

    /// An element as a refusal names it: its type number, as the tree gives it, its name and its frame.
    static func describe(_ s: XCUIElementSnapshot) -> String {
        let name = !s.label.isEmpty ? "\"\(s.label)\"" : !s.identifier.isEmpty ? "id=\(s.identifier)" : "(no name)"
        return "type \(s.elementType.rawValue) \(name) at \(Int(s.frame.minX)),\(Int(s.frame.minY)) \(Int(s.frame.width))×\(Int(s.frame.height))"
    }

    private static func node(_ s: XCUIElementSnapshot) -> [String: Any] {
        var out: [String: Any] = [
            "type": s.elementType.rawValue,
            "identifier": s.identifier,
            "label": s.label,
            "title": s.title,
            "enabled": s.isEnabled,
            "frame": [
                "x": finite(s.frame.minX), "y": finite(s.frame.minY),
                "width": finite(s.frame.width), "height": finite(s.frame.height),
            ],
        ]
        if let value = s.value { out["value"] = String(describing: value) }
        if let placeholder = s.placeholderValue { out["placeholder"] = placeholder }
        if s.isSelected { out["selected"] = true }
        if s.hasFocus { out["focused"] = true }
        out["children"] = s.children.map { node($0) }
        return out
    }

    /// JSON has no infinity and no NaN, and an element that is not on screen can report either.
    private static func finite(_ v: CGFloat) -> Double {
        let d = Double(v)
        return d.isFinite ? d : 0
    }

    /// A picture of the screen: PNG at full resolution, or a JPEG at `scale` of it for the pane's
    /// live view, where a frame a quarter the size crosses the cable four times as fast.
    static func screenshot(format: String, quality: Double, scale: Double) -> Data {
        let shot = XCUIScreen.main.screenshot()
        if format != "jpeg" { return shot.pngRepresentation }
        let image = shot.image
        let factor = min(1, max(0.1, scale))
        guard factor < 1 else { return image.jpegData(compressionQuality: quality) ?? shot.pngRepresentation }
        let pixels = CGSize(width: image.size.width * image.scale * factor, height: image.size.height * image.scale * factor)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let smaller = UIGraphicsImageRenderer(size: pixels, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: pixels))
        }
        return smaller.jpegData(compressionQuality: quality) ?? shot.pngRepresentation
    }
}
