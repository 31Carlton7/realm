import Foundation
import Observation
import RealmKit

/// Phase 1's measurements, taken on the phone and sent to the Mac with `debug.report`:
/// - request round trip: `ping`, 50 times, p50 and p95;
/// - handshake and connect time, from the connection;
/// - time to the first row of `session.open`;
/// - event latency: from `session.send` to the arrival of the `user` row that echoes it.
@MainActor
@Observable
final class Diagnostics {
    static let reportName = "ios-diagnostics"

    var pings = 50
    var echoes = LaunchOptions.diagnosticsEchoes ?? 5
    /// The session to open; nil means the first idle one Home lists.
    var sessionId: String?

    private(set) var running = false
    private(set) var status: String?
    private(set) var problems: [String] = []
    private(set) var pingSamples: [Duration] = []
    private(set) var eventSamples: [Duration] = []
    private(set) var firstRow: Duration?
    private(set) var measuredSession: String?
    private(set) var report: JSONValue?
    private(set) var reportSent = false

    var pingP50: Duration? { LatencySamples.percentile(pingSamples, 0.5) }
    var pingP95: Duration? { LatencySamples.percentile(pingSamples, 0.95) }
    var eventP50: Duration? { LatencySamples.percentile(eventSamples, 0.5) }
    var eventP95: Duration? { LatencySamples.percentile(eventSamples, 0.95) }

    func run(using model: AppModel, sendReport: Bool) async {
        guard !running else { return }
        guard let api = model.api, model.isConnected else {
            status = "Connect to your Mac first."
            return
        }
        running = true
        defer { running = false }
        problems = []
        pingSamples = []
        eventSamples = []
        firstRow = nil
        report = nil
        reportSent = false

        status = "Pinging your Mac…"
        for _ in 0..<pings {
            let start = ContinuousClock.now
            do {
                _ = try await api.ping()
                pingSamples.append(.now - start)
            } catch {
                problems.append("ping: \(AppModel.describe(error))")
                break
            }
        }
        model.store.latency.pings = pingSamples

        let session = LaunchOptions.diagnosticsSession ?? sessionId ?? model.diagnosticsSessionId
        measuredSession = session
        if let session {
            await measureSession(session, api: api, store: model.store)
        } else {
            problems.append("Home lists no session to open.")
        }

        report = makeReport(model)
        print("[realm-diagnostics] \(Self.text(report ?? .null))")
        if sendReport { await send(using: model) }
        if status?.hasPrefix("Could not send") != true {
            status = problems.isEmpty ? "Done." : "Done, with problems."
        }
    }

    private func measureSession(_ session: String, api: MobileAPI, store: RealmStore) async {
        let wasOpen = store.transcripts[session] != nil
        status = "Opening the session…"
        let anyRow = store.watchForRow(in: session) { _ in true }
        let start = ContinuousClock.now
        store.beginOpening(session)
        do {
            let opened = try await api.openSession(id: session)
            let answered = ContinuousClock.now
            store.finishOpening(opened)
            if opened.rows.isEmpty {
                firstRow = try await anyRow.arrival(timeout: .seconds(10)) - start
            } else {
                anyRow.cancel()
                firstRow = answered - start
            }
            store.latency.firstRow = firstRow
        } catch {
            anyRow.cancel()
            store.cancelOpening(session)
            problems.append("session.open: \(AppModel.describe(error))")
            return
        }

        for index in 1...max(echoes, 1) {
            status = "Timing echo \(index) of \(echoes)…"
            // Let the agent's last turn end first, so the message is not held in the Mac's queue.
            await waitUntilIdle(session, store: store, timeout: .seconds(30))
            let text = "Diagnostics echo \(index) of \(echoes) · \(UUID().uuidString.prefix(8))"
            let echo = store.watchForRow(in: session) { row in
                if case .user(let sent) = row.content { return sent == text }
                return false
            }
            let sent = ContinuousClock.now
            var delivered = false
            do {
                try await api.send(id: session, text: text)
                delivered = true
                eventSamples.append(try await echo.arrival(timeout: .seconds(15)) - sent)
            } catch {
                echo.cancel()
                problems.append(delivered
                    ? "echo \(index): the Mac took the message, but its row did not come back within 15 s"
                    : "echo \(index): \(AppModel.describe(error))")
            }
        }
        store.latency.events = eventSamples

        if !wasOpen {
            store.closeSession(session)
            try? await api.closeSession(id: session)
        }
    }

    private func waitUntilIdle(_ session: String, store: RealmStore, timeout: Duration) async {
        let deadline = ContinuousClock.now + timeout
        while store.transcript(session).status == .running, ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(50))
        }
    }

    func send(using model: AppModel) async {
        guard let api = model.api, let report else { return }
        do {
            try await api.debugReport(name: Self.reportName, data: report)
            reportSent = true
            status = "Sent to your Mac."
            print("[realm-diagnostics] sent to the Mac")
        } catch {
            status = "Could not send: \(AppModel.describe(error))"
            print("[realm-diagnostics] could not send: \(error)")
        }
    }

    private func makeReport(_ model: AppModel) -> JSONValue {
        func ms(_ duration: Duration?) -> JSONValue {
            guard let duration else { return .null }
            return .number((duration.milliseconds * 1000).rounded() / 1000)
        }
        func summary(_ samples: [Duration]) -> JSONValue {
            [
                "n": .number(Double(samples.count)),
                "p50Ms": ms(LatencySamples.percentile(samples, 0.5)),
                "p95Ms": ms(LatencySamples.percentile(samples, 0.95)),
                "samplesMs": .array(samples.map { ms($0) }),
            ]
        }
        return [
            "kind": "realm-ios-diagnostics",
            "at": .number((Date().timeIntervalSince1970 * 1000).rounded()),
            "app": .string(DeviceInfo.appVersion),
            "os": .string(DeviceInfo.osVersion),
            "model": .string(DeviceInfo.model),
            "relay": .string(model.store.pairedMac?.relay.absoluteString ?? ""),
            "mac": .string(model.store.pairedMac?.macName ?? ""),
            "handshakeMs": ms(model.store.latency.handshake),
            "connectMs": ms(model.store.latency.connect),
            "ping": summary(pingSamples),
            "session": measuredSession.map(JSONValue.string) ?? .null,
            "firstRowMs": ms(firstRow),
            "events": summary(eventSamples),
            "problems": .array(problems.map(JSONValue.string)),
        ]
    }

    static func text(_ value: JSONValue) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(value)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
    }

    static func format(_ duration: Duration?) -> String {
        guard let duration else { return "—" }
        let ms = duration.milliseconds
        return ms < 10 ? String(format: "%.1f ms", ms) : String(format: "%.0f ms", ms)
    }
}
