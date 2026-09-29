import Foundation
import UIKit
import XCTest

/// What Realm can ask of the phone. Coordinates are in POINTS from the top-left of the portrait
/// screen — what the element tree reports, so a frame read from `/hierarchy` can be tapped as it is.
///
/// Input is taken one step at a time: a tap that arrives while a swipe is still being drawn waits for
/// it, rather than landing in the middle of it. Reads are not queued behind input — a picture taken
/// mid-swipe is still a true picture.
@MainActor
final class Routes {
    private var lastInput: Task<Response, Never>?

    func handle(_ request: Request) async -> Response {
        do {
            switch (request.method, request.path) {
            case ("GET", "/status"):
                return .json(["ok": true, "runner": "realm-device-runner", "version": 1])
            case ("GET", "/device"):
                return .json(Screen.size())
            case ("GET", "/foreground"):
                return .json(await Screen.foreground())
            case ("GET", "/hierarchy"):
                return .json(try await Screen.hierarchy())
            case ("GET", "/screenshot"):
                let format = request.query["format"] ?? "png"
                let data = Screen.screenshot(format: format,
                                             quality: Double(request.query["quality"] ?? "") ?? 0.6,
                                             scale: Double(request.query["scale"] ?? "") ?? 1)
                return Response(status: 200, contentType: format == "jpeg" ? "image/jpeg" : "image/png", body: data)
            case ("POST", "/tap"), ("POST", "/swipe"), ("POST", "/text"), ("POST", "/key"), ("POST", "/button"), ("POST", "/open"):
                let body = try object(request.body)
                return await serially { await self.act(request.path, body) }
            default:
                return .error(404, "no route \(request.method) \(request.path)")
            }
        } catch {
            return .error(500, String(describing: error))
        }
    }

    private func serially(_ work: @escaping @MainActor () async -> Response) async -> Response {
        let previous = lastInput
        let task = Task { @MainActor () -> Response in
            _ = await previous?.value
            return await work()
        }
        lastInput = task
        return await task.value
    }

    private func act(_ path: String, _ body: [String: Any]) async -> Response {
        do {
            switch path {
            case "/tap": try await tap(body)
            case "/swipe": try await swipe(body)
            case "/text": try await type(body)
            case "/key": try await key(body)
            case "/button": try button(body)
            case "/open": try open(body)
            default: return .error(404, "no route \(path)")
            }
            return .json(["ok": true])
        } catch let error as BadRequest {
            return .error(400, error.message)
        } catch {
            return .error(500, String(describing: error))
        }
    }

    /// One or two touches at a point, each held `holdMs`. Two are one gesture, so the gap between
    /// them is the device's and a double tap reads as one.
    private func tap(_ body: [String: Any]) async throws {
        let at = try point(body, "x", "y")
        let count = max(1, min(2, (body["count"] as? Int) ?? 1))
        let hold = seconds(body["holdMs"], or: 0.05)
        let record = try EventRecord()
        var t: TimeInterval = 0
        for _ in 0..<count {
            let path = try PointerEventPath.touch(at: at, offset: t)
            t += hold
            path.liftUp(at: t)
            record.add(path)
            t += 0.1
        }
        try await Daemon.synthesize(record)
    }

    /// Down at `from`, still for `holdMs`, across to `to` in `durationMs`, and up in the same beat
    /// as the last move — a pause before lifting would stop every flick dead. Unless `stopMs` asks for
    /// exactly that: a list held still before the finger lifts stops where the finger did, which is
    /// how a walk scrolls by a known amount.
    private func swipe(_ body: [String: Any]) async throws {
        let from = try point(body, "fromX", "fromY"), to = try point(body, "toX", "toY")
        let hold = seconds(body["holdMs"], or: 0)
        let travel = max(0.05, seconds(body["durationMs"], or: 0.3))
        let stop = seconds(body["stopMs"], or: 0)
        let path = try PointerEventPath.touch(at: from, offset: 0)
        if hold > 0 { path.move(to: from, at: hold) }
        path.move(to: to, at: hold + travel)
        if stop > 0 { path.move(to: to, at: hold + travel + stop) }
        path.liftUp(at: hold + travel + stop)
        let record = try EventRecord()
        record.add(path)
        try await Daemon.synthesize(record)
    }

    /// Into whatever has focus. The first character goes slowly and on its own: MEASURED by
    /// Maestro, the characters after the first are otherwise often dropped while the keyboard's
    /// autocorrection wakes up.
    private func type(_ body: [String: Any]) async throws {
        guard let text = body["text"] as? String, !text.isEmpty else { throw BadRequest("text is missing") }
        let first = String(text.prefix(1)), rest = String(text.dropFirst())
        try await typeRun(first, speed: 1)
        if !rest.isEmpty {
            try await Task.sleep(nanoseconds: 500_000_000)
            try await typeRun(rest, speed: 30)
        }
    }

    private func typeRun(_ text: String, speed: Int) async throws {
        let path = try PointerEventPath.textInput()
        path.type(text, at: 0, typingSpeed: speed)
        let record = try EventRecord()
        record.add(path)
        try await Daemon.synthesize(record)
    }

    /// The keys typing can press. MEASURED on iOS 27: the arrows, tab and escape go through the same
    /// path as text, so the arrows land in a field as the characters ← and →, tab as a tab and escape
    /// as nothing at all. None of them is offered rather than any of them pretending.
    private static let keys: [String: String] = [
        "return": XCUIKeyboardKey.return.rawValue, "delete": XCUIKeyboardKey.delete.rawValue, "space": XCUIKeyboardKey.space.rawValue,
    ]

    private func key(_ body: [String: Any]) async throws {
        guard let name = body["key"] as? String, let key = Routes.keys[name] else { throw BadRequest("no key \(body["key"] ?? "")") }
        try await typeRun(key, speed: 30)
    }

    private func button(_ body: [String: Any]) throws {
        switch body["button"] as? String {
        case "home": XCUIDevice.shared.press(.home)
        #if !targetEnvironment(simulator)
        case "volume-up": XCUIDevice.shared.press(.volumeUp)
        case "volume-down": XCUIDevice.shared.press(.volumeDown)
        #endif
        default: throw BadRequest("no button \(body["button"] ?? "")")
        }
    }

    /// A URL, opened with whatever the system opens it with.
    private func open(_ body: [String: Any]) throws {
        guard let text = body["url"] as? String, let url = URL(string: text), url.scheme != nil else { throw BadRequest("not a URL") }
        XCUIDevice.shared.system.open(url)
    }

    private func object(_ data: Data) throws -> [String: Any] {
        if data.isEmpty { return [:] }
        guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw BadRequest("the body is not a JSON object") }
        return value
    }

    private func point(_ body: [String: Any], _ x: String, _ y: String) throws -> CGPoint {
        guard let px = (body[x] as? NSNumber)?.doubleValue, let py = (body[y] as? NSNumber)?.doubleValue, px.isFinite, py.isFinite else {
            throw BadRequest("\(x) and \(y) are numbers, in points")
        }
        return CGPoint(x: px, y: py)
    }

    private func seconds(_ ms: Any?, or fallback: TimeInterval) -> TimeInterval {
        guard let n = (ms as? NSNumber)?.doubleValue, n.isFinite, n >= 0 else { return fallback }
        return n / 1000
    }
}

struct BadRequest: Error {
    let message: String
    init(_ message: String) { self.message = message }
}
