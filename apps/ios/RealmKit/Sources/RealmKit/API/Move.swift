import Foundation

/// A checkout of a session's space, as the Move sheet names it (`session.moveOptions`).
public struct Checkout: Codable, Sendable, Hashable, Identifiable {
    public enum Kind: String, Codable, Sendable, Hashable {
        /// The space's own folder.
        case primary
        case checkout, worktree
    }

    public let environmentId: String
    /// Shortened against the Mac's home: `~/realm`.
    public let path: String
    public let branch: String?
    public let kind: Kind

    public var id: String { environmentId }

    public init(environmentId: String, path: String, branch: String?, kind: Kind) {
        self.environmentId = environmentId
        self.path = path
        self.branch = branch
        self.kind = kind
    }

    /// What a person calls it, as the desktop's Move sheet does: its folder's name, the space's own
    /// folder too, with its branch said beside it (`MoveWords.detail`).
    public var name: String {
        path.split(separator: "/").last.map(String.init) ?? path
    }
}

/// Where a session can be moved to on its Mac, and what would go with it (`session.moveOptions`).
public struct MoveOptions: Codable, Sendable, Hashable {
    public enum Conversation: String, Codable, Sendable, Hashable {
        case native, notes
    }

    public struct Worktree: Codable, Sendable, Hashable {
        public let available: Bool
        public let reason: String?

        public init(available: Bool, reason: String?) {
            self.available = available
            self.reason = reason
        }
    }

    public let mac: String
    public let from: Checkout
    public let busy: Bool
    /// Why the session cannot move at all, in the Mac's words, or nil.
    public let blocked: String?
    public let pending: Bool
    public let conversation: Conversation
    public let changedFiles: Int
    public let leftBehind: [String]
    /// What the agent runs beyond its turn, which only Stop and move stops. Nil from a Mac before it said.
    public let stops: [String]?
    public let checkouts: [Checkout]
    public let worktree: Worktree

    public init(mac: String, from: Checkout, busy: Bool, blocked: String?, pending: Bool, conversation: Conversation,
                changedFiles: Int, leftBehind: [String], stops: [String]? = nil, checkouts: [Checkout], worktree: Worktree) {
        self.mac = mac
        self.from = from
        self.busy = busy
        self.blocked = blocked
        self.pending = pending
        self.conversation = conversation
        self.changedFiles = changedFiles
        self.leftBehind = leftBehind
        self.stops = stops
        self.checkouts = checkouts
        self.worktree = worktree
    }
}

/// Where a move sends the session.
public enum MoveTarget: Sendable, Hashable {
    case checkout(environmentId: String)
    case worktree
}

extension MoveTarget: Codable {
    private enum CodingKeys: String, CodingKey { case kind, environmentId }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "checkout": self = .checkout(environmentId: try c.decode(String.self, forKey: .environmentId))
        case "worktree": self = .worktree
        case let kind: throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "no move target \(kind)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .checkout(let environmentId):
            try c.encode("checkout", forKey: .kind)
            try c.encode(environmentId, forKey: .environmentId)
        case .worktree:
            try c.encode("worktree", forKey: .kind)
        }
    }
}

/// A move of the session that is not over: queued behind the turn while `step` is nil, otherwise under
/// way at `step`, which the transcript's progress row names.
public struct PendingMove: Codable, Sendable, Hashable {
    public let moveId: String
    public let to: MoveTarget
    public let step: String?

    public init(moveId: String, to: MoveTarget, step: String?) {
        self.moveId = moveId
        self.to = to
        self.step = step
    }

    /// Waiting for the turn to end.
    public var isQueued: Bool { step == nil }
}

/// When a move asked for during a turn happens.
public enum MoveWhen: String, Encodable, Sendable, Hashable {
    case now
    case afterTurn = "after-turn"
    case stop

    /// The button that asks for it.
    public var title: String {
        switch self {
        case .now: "Move"
        case .afterTurn: "Move after this turn"
        case .stop: "Stop and move"
        }
    }
}

public struct MovedSession: Decodable, Sendable {
    public let session: SessionRow
}

public struct CancelledMove: Decodable, Sendable {
    public let cancelled: Bool
}

/// What the Move sheet and the composer's chip say, from the Mac's options.
public enum MoveWords {
    /// The chip: the Mac while the session runs in the space's own folder, the checkout's name in any other.
    public static func chip(_ options: MoveOptions) -> String {
        options.from.kind == .primary ? "On \(options.mac)" : "On \(options.from.name)"
    }

    /// What a move waiting for the turn says, on the chip and in the sheet.
    public static let queued = "Moves after this turn"

    /// Where a move waiting for the turn goes, by the name its destination has in the sheet.
    public static func destination(_ target: MoveTarget, in options: MoveOptions) -> String {
        switch target {
        case .worktree: "New worktree"
        case .checkout(let environmentId): options.checkouts.first { $0.environmentId == environmentId }?.name ?? "Another checkout"
        }
    }

    /// The buttons a move is asked for with, the first the prominent one. Between turns a move happens
    /// at once; during one it waits for the turn, or stops it. While the agent runs work beyond its turn,
    /// only Stop and move stops that work, and the Mac refuses any other move.
    public static func whens(working: Bool, stopping: Bool = false) -> [MoveWhen] {
        if stopping { return [.stop] }
        return working ? [.afterTurn, .stop] : [.now]
    }

    /// Why the session cannot move, as a sentence.
    public static func blocked(_ reason: String) -> String {
        sentence("This session cannot move: \(reason)")
    }

    /// The Mac's words for a refusal, as a sentence: some come without a capital or a full stop.
    public static func sentence(_ words: String) -> String {
        let trimmed = words.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = trimmed.first else { return trimmed }
        let capitalised = first.uppercased() + trimmed.dropFirst()
        return capitalised.last.map { ".!?".contains($0) } == true ? capitalised : capitalised + "."
    }

    /// How the conversation goes with it.
    public static func conversation(_ conversation: MoveOptions.Conversation, agent: String) -> String {
        switch conversation {
        case .native: "\(agent) picks up where it left off, or from notes if it can't."
        case .notes: "\(agent) continues from notes."
        }
    }

    /// The uncommitted files that go with it, or nil when there are none.
    public static func changes(_ count: Int) -> String? {
        switch count {
        case 0: nil
        case 1: "1 changed file, uncommitted"
        default: "\(count) changed files, uncommitted"
        }
    }

    /// One thing that stays behind, as a line of its own: "The terminal", but a file by its own name.
    public static func leftBehind(_ thing: String) -> String {
        guard thing.contains(" "), let first = thing.first, first.isLowercase else { return thing }
        return first.uppercased() + thing.dropFirst()
    }

    /// A destination's second line: its branch, then where it is.
    public static func detail(_ checkout: Checkout) -> String {
        [checkout.branch, checkout.path].compactMap { $0 }.joined(separator: " · ")
    }
}
