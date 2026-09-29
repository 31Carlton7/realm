// Derived from Maestro's iOS XCTest runner (Routes/XCTest/EventRecord.swift, PointerEventPath.swift,
// RunnerDaemonProxy.swift), Copyright mobile.dev, Inc., Apache License 2.0. Changed by Realm: see
// NOTICE — the orientation is passed as an integer, and a missing private class is an error rather
// than a crash.

import Foundation
import UIKit

/// Touches and keystrokes, synthesized by the XCTest daemon at a point on the screen rather than on
/// an element. This is what lets the runner tap whatever is at a coordinate in ANY app — Settings,
/// SpringBoard, the app under test — without first resolving an `XCUIElement` there, and without
/// waiting for that app to go idle.
enum SynthesisError: Error, CustomStringConvertible {
    case missing(String)
    var description: String {
        switch self {
        case .missing(let what): return "this Xcode's XCTest has no \(what), which the runner needs to touch the screen"
        }
    }
}

/// `XCSynthesizedEventRecord`: one gesture, made of pointer paths.
final class EventRecord {
    let record: NSObject

    init() throws {
        guard let cls = objc_lookUpClass("XCSynthesizedEventRecord") else { throw SynthesisError.missing("XCSynthesizedEventRecord") }
        let alloced = cls.alloc() as! NSObject
        let selector = NSSelectorFromString("initWithName:interfaceOrientation:")
        guard alloced.responds(to: selector) else { throw SynthesisError.missing("initWithName:interfaceOrientation:") }
        typealias Init = @convention(c) (NSObject, Selector, NSString, Int) -> NSObject
        let make = unsafeBitCast(alloced.method(for: selector), to: Init.self)
        record = make(alloced, selector, "Single-Finger Touch Action" as NSString, UIInterfaceOrientation.portrait.rawValue)
    }

    func add(_ path: PointerEventPath) {
        let selector = NSSelectorFromString("addPointerEventPath:")
        typealias Add = @convention(c) (NSObject, Selector, NSObject) -> Void
        unsafeBitCast(record.method(for: selector), to: Add.self)(record, selector, path.path)
    }
}

/// `XCPointerEventPath`: one finger's (or the keyboard's) timeline, in seconds from the start of the
/// gesture.
struct PointerEventPath {
    let path: NSObject

    /// A finger that goes down at `point` at `offset`.
    static func touch(at point: CGPoint, offset: TimeInterval) throws -> PointerEventPath {
        guard let cls = objc_lookUpClass("XCPointerEventPath") else { throw SynthesisError.missing("XCPointerEventPath") }
        let alloced = cls.alloc() as! NSObject
        let selector = NSSelectorFromString("initForTouchAtPoint:offset:")
        guard alloced.responds(to: selector) else { throw SynthesisError.missing("initForTouchAtPoint:offset:") }
        typealias Init = @convention(c) (NSObject, Selector, CGPoint, TimeInterval) -> NSObject
        return PointerEventPath(path: unsafeBitCast(alloced.method(for: selector), to: Init.self)(alloced, selector, point, offset))
    }

    /// The keyboard's timeline, for typed text.
    static func textInput() throws -> PointerEventPath {
        guard let cls = objc_lookUpClass("XCPointerEventPath") else { throw SynthesisError.missing("XCPointerEventPath") }
        let alloced = cls.alloc() as! NSObject
        let selector = NSSelectorFromString("initForTextInput")
        guard alloced.responds(to: selector) else { throw SynthesisError.missing("initForTextInput") }
        typealias Init = @convention(c) (NSObject, Selector) -> NSObject
        return PointerEventPath(path: unsafeBitCast(alloced.method(for: selector), to: Init.self)(alloced, selector))
    }

    /// Move in a straight line from wherever the finger was at its previous event, arriving here at
    /// `offset`. The daemon draws the points in between.
    func move(to point: CGPoint, at offset: TimeInterval) {
        let selector = NSSelectorFromString("moveToPoint:atOffset:")
        typealias Move = @convention(c) (NSObject, Selector, CGPoint, TimeInterval) -> Void
        unsafeBitCast(path.method(for: selector), to: Move.self)(path, selector, point, offset)
    }

    func liftUp(at offset: TimeInterval) {
        let selector = NSSelectorFromString("liftUpAtOffset:")
        typealias Lift = @convention(c) (NSObject, Selector, TimeInterval) -> Void
        unsafeBitCast(path.method(for: selector), to: Lift.self)(path, selector, offset)
    }

    /// `typingSpeed` is characters per second.
    func type(_ text: String, at offset: TimeInterval, typingSpeed: Int) {
        let selector = NSSelectorFromString("typeText:atOffset:typingSpeed:shouldRedact:")
        typealias TypeText = @convention(c) (NSObject, Selector, NSString, TimeInterval, UInt64, Bool) -> Void
        unsafeBitCast(path.method(for: selector), to: TypeText.self)(path, selector, text as NSString, offset, UInt64(typingSpeed), false)
    }
}

/// The XCTest daemon's own session, which is what actually delivers a synthesized event.
@MainActor
struct Daemon {
    static func synthesize(_ record: EventRecord) async throws {
        guard let cls = NSClassFromString("XCTRunnerDaemonSession") else { throw SynthesisError.missing("XCTRunnerDaemonSession") }
        let shared = NSSelectorFromString("sharedSession")
        guard let method = class_getClassMethod(cls, shared) else { throw SynthesisError.missing("XCTRunnerDaemonSession.sharedSession") }
        typealias Shared = @convention(c) (AnyClass, Selector) -> NSObject
        let session = unsafeBitCast(method_getImplementation(method), to: Shared.self)(cls, shared)
        guard let proxy = session.perform(NSSelectorFromString("daemonProxy"))?.takeUnretainedValue() as? NSObject else {
            throw SynthesisError.missing("a daemon proxy")
        }
        let selector = NSSelectorFromString("_XCT_synthesizeEvent:completion:")
        guard proxy.responds(to: selector) else { throw SynthesisError.missing("_XCT_synthesizeEvent:completion:") }
        typealias Synthesize = @convention(c) (NSObject, Selector, NSObject, @escaping (Error?) -> Void) -> Void
        let send = unsafeBitCast(proxy.method(for: selector), to: Synthesize.self)
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
            send(proxy, selector, record.record) { error in
                if let error { done.resume(throwing: error) } else { done.resume() }
            }
        }
    }
}
