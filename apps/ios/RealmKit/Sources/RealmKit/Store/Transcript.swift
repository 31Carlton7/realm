import Foundation

/// One open session's rows, upserted by key: a later row with the same key replaces the earlier one
/// where it stands, and a new key goes at the end (PROTOCOL.md §8).
public struct Transcript: Sendable, Equatable {
    public private(set) var rows: [TranscriptRow] = []
    private var positions: [String: Int] = [:]
    public var session: SessionRow?
    public var status: SessionStatus?
    public var hasMore = false
    /// The suggested next message, which sits above the field until something is sent.
    public var hint: String?
    /// The messages waiting in the Mac's queue, as it last said; nil from a Mac that does not say. Not
    /// kept with the rows on disk: the queue lives in the Mac's memory, and comes again with the session.
    public var queued: [QueuedMessage]?
    /// When these rows were last fresh from the Mac; nil while they are live on this connection.
    public var savedAt: Date?

    public init(rows: [TranscriptRow] = []) {
        upsert(rows)
    }

    public init(_ snapshot: TranscriptSnapshot, savedAt: Date) {
        upsert(snapshot.rows)
        session = snapshot.session
        status = snapshot.status
        hasMore = snapshot.hasMore
        hint = snapshot.hint
        self.savedAt = savedAt
    }

    public var isLive: Bool { savedAt == nil }

    /// The newest event these rows come from: what `session.seen` marks read up to.
    public var lastSeq: Int { rows.map(\.seq).max() ?? 0 }

    public mutating func upsert(_ incoming: [TranscriptRow]) {
        for row in incoming {
            if let position = positions[row.key] {
                rows[position] = row
            } else {
                positions[row.key] = rows.count
                rows.append(row)
            }
        }
    }

    public mutating func replaceAll(with incoming: [TranscriptRow]) {
        rows = []
        positions = [:]
        upsert(incoming)
    }

    public func row(forKey key: String) -> TranscriptRow? {
        positions[key].map { rows[$0] }
    }
}

/// Latency samples and their percentiles, for the Phase 1 measurements.
public struct LatencySamples: Sendable, Equatable {
    public var pings: [Duration] = []
    public var handshake: Duration?
    public var connect: Duration?
    public var firstRow: Duration?
    public var events: [Duration] = []

    public init() {}

    /// Nearest-rank percentile: the smallest sample with at least `p` of the samples at or below it.
    public static func percentile(_ samples: [Duration], _ p: Double) -> Duration? {
        guard !samples.isEmpty else { return nil }
        let sorted = samples.sorted()
        let rank = Int((p * Double(sorted.count)).rounded(.up))
        return sorted[min(max(rank, 1), sorted.count) - 1]
    }
}

extension Duration {
    /// Milliseconds, as a Double, for display and reports.
    public var milliseconds: Double {
        let (seconds, attoseconds) = components
        return Double(seconds) * 1000 + Double(attoseconds) / 1e15
    }
}
