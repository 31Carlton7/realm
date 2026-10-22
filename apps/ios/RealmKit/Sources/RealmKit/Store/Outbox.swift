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
        /// The Mac has it. A message stays until its own row arrives, or until the Mac's queue shows it
        /// holding the message (a queued message's row comes only when it goes); an answer stays until
        /// its request reads answered.
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
    /// An answer as `session.answer` sends it, by question key, several picks as a list. The payload's
    /// `answers` are the same answers as words, by question, for the card to show while it travels.
    /// Nil on an item saved before answers had keys: its words are sent as they are.
    public let answerValues: [String: AnswerValue]?
    /// The files a message takes, each waiting in `OutboxFiles` until the Mac has it. None on an answer,
    /// or on an item saved before messages took files.
    public let attachments: [OutgoingAttachment]
    /// What a message does if it reaches a turn under way: whatever the Mac is set to (`auto`), or what
    /// the person chose. `auto` on an item saved before there was a choice.
    public let delivery: Delivery

    public init(id: UUID = UUID(), sessionId: String, payload: Payload, createdAt: Date = Date(), state: State = .waiting,
                afterSeq: Int, answerValues: [String: AnswerValue]? = nil, attachments: [OutgoingAttachment] = [],
                delivery: Delivery = .auto) {
        self.id = id
        self.sessionId = sessionId
        self.payload = payload
        self.createdAt = createdAt
        self.state = state
        self.afterSeq = afterSeq
        self.answerValues = answerValues
        self.attachments = attachments
        self.delivery = delivery
    }

    private enum CodingKeys: String, CodingKey {
        case id, sessionId, payload, createdAt, state, afterSeq, answerValues, attachments, delivery
    }

    /// An outbox saved by an earlier build still reads: what it did not know about is absent.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        payload = try c.decode(Payload.self, forKey: .payload)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        state = try c.decode(State.self, forKey: .state)
        afterSeq = try c.decode(Int.self, forKey: .afterSeq)
        answerValues = try c.decodeIfPresent([String: AnswerValue].self, forKey: .answerValues)
        attachments = try c.decodeIfPresent([OutgoingAttachment].self, forKey: .attachments) ?? []
        delivery = try c.decodeIfPresent(Delivery.self, forKey: .delivery) ?? .auto
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

    /// It may be on the Mac: written to the channel, unconfirmed, or taken.
    public var mayBeOnMac: Bool {
        switch state {
        case .sending, .unconfirmed, .delivered: true
        case .waiting, .failed: false
        }
    }

    /// After this long nothing is sent on its own; the person decides.
    public static let maxAge: TimeInterval = 24 * 60 * 60
}

/// A file going with a message: what the Mac is told it is, and the file on this phone that holds it.
public struct OutgoingAttachment: Codable, Sendable, Hashable, Identifiable {
    public let id: UUID
    /// What the Mac names it by: the file's own name, or "Photo.jpg" for a photo.
    public let name: String
    public let mime: String
    /// Its size in bytes, which the Mac's limits are counted in.
    public let size: Int
    /// The file holding its bytes, in `OutboxFiles`' folder.
    public let file: String

    public init(id: UUID, name: String, mime: String, size: Int, file: String) {
        self.id = id
        self.name = name
        self.mime = mime
        self.size = size
        self.file = file
    }

    public var isImage: Bool { mime.hasPrefix("image/") }
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

    /// Restores what was saved. The app may have gone mid-send, after the last save, so anything not
    /// refused is looked for before it goes again; anything delivered is the Mac's now.
    public static func restored(_ saved: [OutgoingItem]) -> Outbox {
        Outbox(items: saved.compactMap { item in
            var item = item
            switch item.state {
            case .waiting, .sending, .unconfirmed: item.state = .unconfirmed
            case .delivered: return nil
            case .failed: break
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

    /// Every file a message still waiting here takes.
    public var attachments: Set<OutgoingAttachment> {
        Set(items.flatMap(\.attachments))
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
        /// The Mac's queue holds the message, by this id: the queue shows it from here, and its row
        /// comes when its turn does.
        case queued(id: String)
    }

    /// Settles what the transcript shows has arrived: a message whose own row is there or that the
    /// Mac's queue holds, an answer whose request no longer waits. Returns the ids it settled.
    @discardableResult
    public mutating func settle(with transcript: Transcript, in sessionId: String) -> [UUID] {
        let found = arrivals(in: transcript, for: sessionId)
        for case .row(let key) in found.values { settledBy.insert(key) }
        items.removeAll { found[$0.id] != nil }
        return Array(found.keys)
    }

    /// Pairs a session's items with the transcript, oldest first: each message with the first row
    /// after it that holds its words and as many files, and no earlier item has taken; each answer
    /// with its request. A message the Mac has, or may have, with no row yet is paired with its queue.
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
                    // Photos sent alone have no words: their count tells them from another message.
                    return Self.normalized(sent) == wanted && (row.sentFiles?.count ?? 0) == item.attachments.count
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
        // Only a live queue says what the Mac holds: one from before the link went may hold words sent
        // since. A message still on its way is left to its answer, which can yet refuse it.
        if transcript.isLive, let queued = transcript.queued {
            let onMac = items.filter { $0.sessionId == sessionId && found[$0.id] == nil && ($0.state == .delivered || $0.state == .unconfirmed) }
            for (id, queuedId) in Self.pairs(onMac, with: queued) { found[id] = .queued(id: queuedId) }
        }
        return found
    }

    /// A session's messages that may be on the Mac, paired with what its queue holds, oldest first:
    /// each with the first queued message that holds its words and as many files, and no earlier one
    /// has taken. What waits on this phone, or was refused, pairs with nothing.
    public func inQueue(_ queued: [QueuedMessage], for sessionId: String) -> [UUID: String] {
        Self.pairs(items.filter { $0.sessionId == sessionId && $0.mayBeOnMac }, with: queued)
    }

    private static func pairs(_ items: [OutgoingItem], with queued: [QueuedMessage]) -> [UUID: String] {
        var free = queued
        var paired: [UUID: String] = [:]
        for item in items {
            guard case .message(let text) = item.payload else { continue }
            let wanted = normalized(text)
            guard let index = free.firstIndex(where: { normalized($0.text) == wanted && $0.attachments.count == item.attachments.count }) else {
                continue
            }
            paired[item.id] = free.remove(at: index).id
        }
        return paired
    }

    static func normalized(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
