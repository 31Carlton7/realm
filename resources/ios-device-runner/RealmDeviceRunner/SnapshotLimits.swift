import Foundation
import ObjectiveC
import XCTest

/// How deep and how wide a snapshot of the app in front may go.
///
/// XCTest asks an app's accessibility server for the WHOLE tree, however deep, and an app whose tree
/// is deep answers slowly — MEASURED on a real iPhone: TikTok's feed took 5 to 40 s a snapshot where
/// Instagram's took a tenth of one, and every read of it timed out while the app stuttered. The client
/// that asks takes its limits from `-[XCAXClient_iOS defaultParameters]`, which WebDriverAgent and
/// Maestro both override for exactly this; so does this, with the limits Realm sends for each read.
///
/// The limits are read under a lock, on whatever thread XCTest asks from. If the class or the method is
/// not there — another Xcode — nothing is replaced and every snapshot is whole, as before: slower on a
/// deep app, never wrong.
enum SnapshotLimits {
    private static let lock = NSLock()
    private static var depth: Int?
    private static var children: Int?
    private static var replaced = false

    /// Whether the replacement is in: false on an Xcode whose client does not take parameters this way.
    static var installed: Bool { lock.lock(); defer { lock.unlock() }; return replaced }

    static func install() {
        lock.lock(); defer { lock.unlock() }
        guard !replaced,
              let cls = NSClassFromString("XCAXClient_iOS"),
              let method = class_getInstanceMethod(cls, NSSelectorFromString("defaultParameters")) else { return }
        typealias Original = @convention(c) (AnyObject, Selector) -> NSDictionary
        let original = unsafeBitCast(method_getImplementation(method), to: Original.self)
        let selector = NSSelectorFromString("defaultParameters")
        let replacement: @convention(block) (AnyObject) -> NSDictionary = { client in
            let parameters = (original(client, selector).mutableCopy() as? NSMutableDictionary) ?? NSMutableDictionary()
            let (depth, children) = SnapshotLimits.current()
            if let depth { parameters["maxDepth"] = depth }
            if let children { parameters["maxChildren"] = children }
            return parameters
        }
        method_setImplementation(method, imp_implementationWithBlock(replacement))
        replaced = true
    }

    private static func current() -> (Int?, Int?) {
        lock.lock(); defer { lock.unlock() }
        return (depth, children)
    }

    /// `work` with these limits, and XCTest's own again after it.
    static func with<T>(depth: Int?, children: Int?, _ work: () throws -> T) rethrows -> T {
        lock.lock(); self.depth = depth; self.children = children; lock.unlock()
        defer { lock.lock(); self.depth = nil; self.children = nil; lock.unlock() }
        return try work()
    }
}
