import Foundation
import Observation

/// The app's state: the paired Mac, the connection, Home, the open sessions, what waits to be sent,
/// and the latency samples.
@MainActor
@Observable
public final class RealmStore {
    public var pairedMac: PairedMac?
    public var connection: ConnectionState = .idle {
        didSet { link.update(connection) }
    }
    /// The connection as the person is told it, remembering what the last attempt ran into.
    public private(set) var link = LinkTracker()
    public private(set) var home: Home?
    /// When Home was last fresh from the Mac; nil while it is live on this connection.
    public private(set) var homeSavedAt: Date?
    public private(set) var transcripts: [String: Transcript] = [:]
    public private(set) var outbox = Outbox() {
        // A message's files go with it: once it settles, or is taken back.
        didSet { files.remove(oldValue.attachments.subtracting(outbox.attachments)) }
    }
    /// Where the files of messages being written and waiting to go are kept.
    public let files: OutboxFiles
    /// Question cards answered part way, by request id: put away, not sent.
    public private(set) var drafts: [String: AnswerDraft] = [:]
    public var latency = LatencySamples()

    /// Rows that arrived for a session while its `session.open` was still on its way back.
    @ObservationIgnored private var opening: [String: [TranscriptRow]] = [:]
    /// A suggested next message that changed while its session was opening, newer than the open's.
    @ObservationIgnored private var openingHint: [String: String?] = [:]
    @ObservationIgnored private var watches: [RowWatch] = []
    /// The seq each session was last marked read up to, by this phone.
    @ObservationIgnored private var seenUpTo: [String: Int] = [:]

    public init(pairedMac: PairedMac? = nil, files: OutboxFiles = OutboxFiles()) {
        self.pairedMac = pairedMac
        self.files = files
    }

    public func linkStatus(now: Date = Date()) -> LinkStatus {
        link.status(now: now)
    }

    // MARK: - Home

    /// Home as the Mac just sent it.
    public func showHome(_ home: Home) {
        self.home = home
        homeSavedAt = nil
    }

    /// Home as it was last seen, until the Mac sends it again. A live Home is never replaced by it.
    public func restoreHome(_ cached: Cached<Home>) {
        guard home == nil || homeSavedAt != nil else { return }
        home = cached.value
        homeSavedAt = cached.savedAt
    }

    /// The connection went: what is on screen stops being live, as of now.
    public func markStale(at date: Date = Date()) {
        if home != nil, homeSavedAt == nil { homeSavedAt = date }
        for id in transcripts.keys where transcripts[id]?.savedAt == nil {
            transcripts[id]?.savedAt = date
        }
    }

    public func forgetEverything() {
        home = nil
        homeSavedAt = nil
        transcripts = [:]
        opening = [:]
        outbox = Outbox()
        drafts = [:]
        seenUpTo = [:]
    }

    // MARK: - Sessions

    public func transcript(_ sessionId: String) -> Transcript {
        transcripts[sessionId] ?? Transcript()
    }

    /// A session as it was last seen, drawn while `session.open` is on its way. A live one stays.
    public func restoreTranscript(_ sessionId: String, from cached: Cached<TranscriptSnapshot>) {
        guard transcripts[sessionId] == nil else { return }
        transcripts[sessionId] = Transcript(cached.value, savedAt: cached.savedAt)
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
        transcript.hint = opened.hint
        if let early = opening.removeValue(forKey: opened.session.id) { transcript.upsert(early) }
        if let hint = openingHint.removeValue(forKey: opened.session.id) { transcript.hint = hint }
        transcripts[opened.session.id] = transcript
        settleOutbox(in: opened.session.id)
    }

    public func cancelOpening(_ sessionId: String) {
        opening[sessionId] = nil
        openingHint[sessionId] = nil
    }

    public func closeSession(_ sessionId: String) {
        transcripts[sessionId] = nil
        opening[sessionId] = nil
        openingHint[sessionId] = nil
        outbox.forgetDelivered(in: sessionId)
    }

    public func apply(_ event: MobileEvent, at arrival: ContinuousClock.Instant = .now) {
        switch event {
        case .sessionRows(let update):
            if opening[update.id] != nil {
                opening[update.id]?.append(contentsOf: update.rows)
            } else if transcripts[update.id] != nil {
                transcripts[update.id]?.upsert(update.rows)
                settleOutbox(in: update.id)
            }
            for watch in watches where watch.sessionId == update.id && update.rows.contains(where: watch.matches) {
                watch.resolve(.success(arrival))
            }
            watches.removeAll { $0.isSettled }
        case .sessionStatus(let update):
            transcripts[update.id]?.status = update.status
            watches.removeAll { $0.isSettled }
        case .sessionHint(let update):
            if opening[update.id] != nil {
                openingHint[update.id] = .some(update.text)
            } else {
                transcripts[update.id]?.hint = update.text
            }
        case .homeChanged, .workChanged, .sessionQueue, .sessionSubagents, .pairResult, .unknown:
            break
        }
    }

    // MARK: - Read

    /// The seq to mark a session read up to, once its last row has been seen: only ever forward, and
    /// only once for each seq.
    public func seenToMark(_ sessionId: String) -> Int? {
        guard let transcript = transcripts[sessionId], transcript.isLive else { return nil }
        let seq = transcript.lastSeq
        guard seq > 0, seq > seenUpTo[sessionId] ?? 0 else { return nil }
        return seq
    }

    /// The Mac took `session.seen` up to `seq`.
    public func markedSeen(_ sessionId: String, upTo seq: Int) {
        seenUpTo[sessionId] = max(seenUpTo[sessionId] ?? 0, seq)
    }

    /// `session.seen` did not reach the Mac: the next time the bottom is on screen it goes again.
    public func forgetSeen(_ sessionId: String) {
        seenUpTo[sessionId] = nil
    }

    // MARK: - What waits to be sent

    /// A message, in line behind anything the session already has waiting, with the files it takes
    /// (kept in `files` already) and what it does if a turn is under way when it arrives.
    @discardableResult
    public func enqueueMessage(_ text: String, attachments: [OutgoingAttachment] = [], delivery: Delivery = .auto,
                               in sessionId: String, at date: Date = Date()) -> OutgoingItem {
        let item = OutgoingItem(sessionId: sessionId, payload: .message(text: text), createdAt: date,
                                afterSeq: transcript(sessionId).lastSeq, attachments: attachments, delivery: delivery)
        outbox.add(item)
        return item
    }

    /// An answer to a request. One per request: a second while the first is on its way is ignored.
    @discardableResult
    public func enqueueAnswer(_ decision: Decision, answers: [String: String]? = nil, values: [String: AnswerValue]? = nil, to requestId: String,
                              in sessionId: String, at date: Date = Date()) -> OutgoingItem? {
        if let existing = outbox.answer(for: requestId), !existing.isFailed { return nil }
        if let failed = outbox.answer(for: requestId) { outbox.remove(failed.id) }
        let item = OutgoingItem(sessionId: sessionId, payload: .answer(requestId: requestId, decision: decision, answers: answers),
                                createdAt: date, afterSeq: transcript(sessionId).lastSeq, answerValues: values)
        outbox.add(item)
        drafts[requestId] = nil
        return item
    }

    public func setOutgoing(_ id: UUID, _ state: OutgoingItem.State) {
        outbox.set(id, state)
    }

    /// The person took it back.
    public func discardOutgoing(_ id: UUID) {
        outbox.remove(id)
    }

    /// The person asked for a refused item to go again.
    public func retryOutgoing(_ id: UUID) {
        guard let item = outbox.item(id), item.isFailed else { return }
        outbox.set(id, .waiting)
    }

    public func restoreOutbox(_ saved: [OutgoingItem]) {
        outbox = Outbox.restored(saved)
        // Any other file was a draft's when the app last went, or a message's the Mac already had.
        files.removeAll(except: Set(outbox.attachments.map(\.file)))
    }

    public func settleOutbox(in sessionId: String) {
        guard let transcript = transcripts[sessionId] else { return }
        outbox.settle(with: transcript, in: sessionId)
    }

    // MARK: - Question cards

    public func draft(for request: TranscriptRow.Request, in sessionId: String) -> AnswerDraft {
        drafts[request.requestId] ?? AnswerDraft(sessionId: sessionId, requestId: request.requestId, questions: request.questions ?? [])
    }

    /// The sheet was put away: the picks are kept for next time, and nothing is answered.
    public func keepDraft(_ draft: AnswerDraft) {
        drafts[draft.requestId] = draft
    }

    /// The person sent their answers.
    @discardableResult
    public func submit(_ draft: AnswerDraft) -> OutgoingItem? {
        guard draft.isComplete else { return nil }
        return enqueueAnswer(.allow, answers: draft.answers, values: draft.values, to: draft.requestId, in: draft.sessionId)
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
