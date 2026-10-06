import Foundation
import Observation

/// The app's state: the paired Mac, the connection, Home, the open sessions and the latency samples.
@MainActor
@Observable
public final class RealmStore {
    public var pairedMac: PairedMac?
    public var connection: ConnectionState = .idle
    public var home: Home?
    public private(set) var transcripts: [String: Transcript] = [:]
    public var latency = LatencySamples()

    /// Rows that arrived for a session while its `session.open` was still on its way back.
    @ObservationIgnored private var opening: [String: [TranscriptRow]] = [:]
    @ObservationIgnored private var watches: [RowWatch] = []

    public init(pairedMac: PairedMac? = nil) {
        self.pairedMac = pairedMac
    }

    public func transcript(_ sessionId: String) -> Transcript {
        transcripts[sessionId] ?? Transcript()
    }

    /// Call before `session.open`, so rows that beat its response are kept and applied after it.
    public func beginOpening(_ sessionId: String) {
        opening[sessionId] = []
    }

    public func finishOpening(_ opened: OpenedSession) {
        var transcript = Transcript(rows: opened.rows)
        transcript.session = opened.session
        transcript.status = opened.session.status
        transcript.hasMore = opened.hasMore
        if let early = opening.removeValue(forKey: opened.session.id) { transcript.upsert(early) }
        transcripts[opened.session.id] = transcript
    }

    public func cancelOpening(_ sessionId: String) {
        opening[sessionId] = nil
    }

    public func closeSession(_ sessionId: String) {
        transcripts[sessionId] = nil
        opening[sessionId] = nil
    }

    public func apply(_ event: MobileEvent, at arrival: ContinuousClock.Instant = .now) {
        switch event {
        case .sessionRows(let update):
            if opening[update.id] != nil {
                opening[update.id]?.append(contentsOf: update.rows)
            } else if transcripts[update.id] != nil {
                transcripts[update.id]?.upsert(update.rows)
            }
            for watch in watches where watch.sessionId == update.id && update.rows.contains(where: watch.matches) {
                watch.resolve(.success(arrival))
            }
            watches.removeAll { $0.isSettled }
        case .sessionStatus(let update):
            transcripts[update.id]?.status = update.status
            watches.removeAll { $0.isSettled }
        case .homeChanged, .pairResult, .unknown:
            break
        }
    }

    /// Starts watching for a matching row in a session now; await `arrival(timeout:)` later. Starting
    /// before the request that causes the row means the row cannot slip past unseen.
    public func watchForRow(in sessionId: String, matching matches: @escaping @MainActor (TranscriptRow) -> Bool) -> RowWatch {
        let watch = RowWatch(sessionId: sessionId, matches: matches)
        watches.append(watch)
        return watch
    }

    public func waitForRow(
        in sessionId: String,
        timeout: Duration,
        matching matches: @escaping @MainActor (TranscriptRow) -> Bool
    ) async throws -> ContinuousClock.Instant {
        try await watchForRow(in: sessionId, matching: matches).arrival(timeout: timeout)
    }
}

/// One pending wait for a row; see `RealmStore.watchForRow`.
@MainActor
public final class RowWatch {
    let sessionId: String
    let matches: @MainActor (TranscriptRow) -> Bool
    private var result: Result<ContinuousClock.Instant, Error>?
    private var continuation: CheckedContinuation<ContinuousClock.Instant, Error>?

    init(sessionId: String, matches: @escaping @MainActor (TranscriptRow) -> Bool) {
        self.sessionId = sessionId
        self.matches = matches
    }

    var isSettled: Bool { result != nil }

    func resolve(_ outcome: Result<ContinuousClock.Instant, Error>) {
        guard result == nil else { return }
        result = outcome
        continuation?.resume(with: outcome)
        continuation = nil
    }

    /// Stops waiting; an `arrival` still pending throws `CancellationError`.
    public func cancel() {
        resolve(.failure(CancellationError()))
    }

    /// When the row arrived, or `ChannelError.timedOut`.
    public func arrival(timeout: Duration) async throws -> ContinuousClock.Instant {
        if let result { return try result.get() }
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            Task { @MainActor in
                try? await Task.sleep(for: timeout)
                self.resolve(.failure(ChannelError.timedOut))
            }
        }
    }
}
