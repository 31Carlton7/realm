import Foundation

/// A message or an answer the person gave, on its way to the Mac. It is kept until the Mac has it —
/// through a cold radio, a sleeping Mac or a relaunch — and is never dropped for taking too long.
public struct OutgoingItem: Codable, Sendable, Identifiable, Equatable {
    public enum Payload: Codable, Sendable, Equatable {
        case message(text: String)
        case answer(requestId: String, decision: Decision, answers: [String: String]?)
    }

    public enum State: Codable, Sendable, Equatable {
        /// Not on its way: there is no channel to the Mac.
        case waiting
        /// Written to the channel; the Mac has not answered yet.
        case sending
        /// It may have reached the Mac: the channel dropped or the answer was late. Looked for in the
        /// transcript before it is sent again, so it never arrives twice.
        case unconfirmed
        /// The Mac has it. A message stays until its own row arrives (a Mac that queues it shows the
        /// row only when it goes); an answer stays until its request reads answered.
        case delivered
        /// The Mac refused it, in its own words. Kept, so nothing typed is lost.
        case failed(String)
    }

    public let id: UUID
    public let sessionId: String
    public let payload: Payload
    public let createdAt: Date
    public var state: State
    /// The newest row the transcript held when this was made: the message's own row comes after it.
    public let afterSeq: Int

    public init(id: UUID = UUID(), sessionId: String, payload: Payload, createdAt: Date = Date(), state: State = .waiting,
                afterSeq: Int) {
        self.id = id
        self.sessionId = sessionId
        self.payload = payload
        self.createdAt = createdAt
        self.state = state
        self.afterSeq = afterSeq
    }

    public var isMessage: Bool {
        if case .message = payload { return true }
        return false
    }

    public var requestId: String? {
        if case .answer(let requestId, _, _) = payload { return requestId }
        return nil
    }

    /// Waiting its turn to go, or to be looked for and then go.
    public var isPending: Bool {
        switch state {
        case .waiting, .unconfirmed: true
        case .sending, .delivered, .failed: false
        }
    }

    public var isFailed: Bool {
        if case .failed = state { return true }
        return false
    }

    /// After this long nothing is sent on its own; the person decides.
    public static let maxAge: TimeInterval = 24 * 60 * 60
}

/// The queue of what the person gave, in the order they gave it. It decides nothing about the
/// network; `Courier` sends, and the transcript's rows say when each one has arrived.
public struct Outbox: Sendable, Equatable {
    public private(set) var items: [OutgoingItem] = []
    /// Rows that have already settled an item, so one row can never settle two ("ok", then "ok").
    private var settledBy: Set<String> = []

    public init(items: [OutgoingItem] = []) {
        self.items = items
    }

    /// Restores what was saved: anything that was on its way may have arrived, so it is looked for
    /// before it goes again; anything delivered is the Mac's now.
    public static func restored(_ saved: [OutgoingItem]) -> Outbox {
        Outbox(items: saved.compactMap { item in
            var item = item
            switch item.state {
            case .sending: item.state = .unconfirmed
            case .delivered: return nil
            case .waiting, .unconfirmed, .failed: break
            }
            return item
        })
    }

    public func items(for sessionId: String) -> [OutgoingItem] {
        items.filter { $0.sessionId == sessionId }
    }

    public func item(_ id: UUID) -> OutgoingItem? {
        items.first { $0.id == id }
    }

    /// The answer on its way for a request, if one is.
    public func answer(for requestId: String) -> OutgoingItem? {
        items.first { $0.requestId == requestId }
    }

    public mutating func add(_ item: OutgoingItem) {
        items.append(item)
    }

    public mutating func set(_ id: UUID, _ state: OutgoingItem.State) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        items[index].state = state
    }

    public mutating func remove(_ id: UUID) {
        items.removeAll { $0.id == id }
    }

    /// Takes a session's items off once it is closed: what was delivered is the Mac's now.
    public mutating func forgetDelivered(in sessionId: String) {
        items.removeAll { $0.sessionId == sessionId && $0.state == .delivered }
    }

    /// The next item of a session to send, oldest first.
    public func next(in sessionId: String) -> OutgoingItem? {
        items.first { $0.sessionId == sessionId && $0.isPending }
    }

    /// How an item showed up in the transcript.
    public enum Arrival: Sendable, Equatable {
        /// The message's own row.
        case row(key: String)
        /// The request it answers no longer waits, whoever answered it.
        case answered
    }

    /// Settles what the transcript shows has arrived: a message whose own row is there, an answer
    /// whose request no longer waits. Returns the ids it settled.
    @discardableResult
    public mutating func settle(with transcript: Transcript, in sessionId: String) -> [UUID] {
        let found = arrivals(in: transcript, for: sessionId)
        for case .row(let key) in found.values { settledBy.insert(key) }
        items.removeAll { found[$0.id] != nil }
        return Array(found.keys)
    }

    /// Pairs a session's items with the transcript, oldest first: each message with the first row
    /// after it that holds its words and no earlier item has taken, each answer with its request.
    public func arrivals(in transcript: Transcript, for sessionId: String) -> [UUID: Arrival] {
        var found: [UUID: Arrival] = [:]
        var taken = settledBy
        for item in items where item.sessionId == sessionId {
            switch item.payload {
            case .message(let text):
                guard !item.isFailed else { continue }
                let wanted = Self.normalized(text)
                let row = transcript.rows.first { row in
                    guard row.seq > item.afterSeq, !taken.contains(row.key), case .user(let sent) = row.content else { return false }
                    return Self.normalized(sent) == wanted
                }
                if let row {
                    taken.insert(row.key)
                    found[item.id] = .row(key: row.key)
                }
            case .answer(let requestId, _, _):
                let answered = transcript.rows.contains { row in
                    if case .request(let request) = row.content { return request.requestId == requestId && request.state != .pending }
                    return false
                }
                if answered { found[item.id] = .answered }
            }
        }
        return found
    }

    static func normalized(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
