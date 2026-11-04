import Foundation

/// Where a session's goal stands, in the desktop's terms. `active` is the only status that starts its
/// own next turn; `paused`, `blocked` and `budgetLimited` are stops a resume lifts.
public enum GoalStatus: Sendable, Hashable, Codable {
    case active, paused, blocked, budgetLimited, complete, abandoned
    /// A status this phone does not know yet.
    case other(String)

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        switch raw {
        case "active": self = .active
        case "paused": self = .paused
        case "blocked": self = .blocked
        case "budget_limited": self = .budgetLimited
        case "complete": self = .complete
        case "abandoned": self = .abandoned
        default: self = .other(raw)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }

    public var rawValue: String {
        switch self {
        case .active: "active"
        case .paused: "paused"
        case .blocked: "blocked"
        case .budgetLimited: "budget_limited"
        case .complete: "complete"
        case .abandoned: "abandoned"
        case .other(let raw): raw
        }
    }

    /// A stop the person can lift with resume.
    public var isResumable: Bool { self == .paused || self == .blocked || self == .budgetLimited }

    /// Running, or stopped and resumable: what can still be paused, resumed or marked done.
    public var isUnfinished: Bool { self == .active || isResumable }
}

/// The objective a session works towards across turns (`session.open`'s `goal`, `session.goal`).
public struct Goal: Codable, Sendable, Hashable {
    public let objective: String
    public let status: GoalStatus
    /// Turns run under it, the first one included.
    public let turns: Int
    public let tokensUsed: Int
    /// Its ceiling in tokens, or nil for none.
    public let tokenBudget: Int?
    /// Why it stopped, in the agent's words or Realm's.
    public let note: String?
    public let startedAt: Millis
    public let updatedAt: Millis

    public init(objective: String, status: GoalStatus, turns: Int = 0, tokensUsed: Int = 0, tokenBudget: Int? = nil,
                note: String? = nil, startedAt: Millis = 0, updatedAt: Millis = 0) {
        self.objective = objective
        self.status = status
        self.turns = turns
        self.tokensUsed = tokensUsed
        self.tokenBudget = tokenBudget
        self.note = note
        self.startedAt = startedAt
        self.updatedAt = updatedAt
    }
}

/// A listed session's goal, as its row names it: where it stands, and what it is.
public struct GoalMark: Codable, Sendable, Hashable {
    public let status: GoalStatus
    public let objective: String

    public init(status: GoalStatus, objective: String) {
        self.status = status
        self.objective = objective
    }
}

/// What the goal strip's controls ask the Mac for (`session.goalControl`).
public enum GoalAction: String, Codable, Sendable {
    case pause, resume, done, drop
}

/// A turn the session's goal started itself rather than anyone typing it.
public enum GoalTurn: String, Codable, Sendable, Hashable {
    case continuation
    /// The handover a spent budget asks for.
    case budget
}

/// One item of the agent's to-do list (TodoWrite), in the order the agent wrote them.
public struct TodoItem: Codable, Sendable, Hashable {
    public enum State: String, Codable, Sendable, Hashable {
        case pending
        case inProgress = "in_progress"
        case completed
    }

    public let content: String
    public let status: State
    /// What an item in progress says it is doing ("Running the suite"), or nil where the agent gave none.
    public let activeForm: String?

    public init(content: String, status: State, activeForm: String? = nil) {
        self.content = content
        self.status = status
        self.activeForm = activeForm
    }
}

/// `session.goal`: an open session's goal changed, or was dropped (nil).
public struct SessionGoalEvent: Decodable, Sendable, Equatable {
    public let id: String
    public let goal: Goal?

    public init(id: String, goal: Goal?) {
        self.id = id
        self.goal = goal
    }
}

/// `session.todos`: an open session's to-do list, whole.
public struct SessionTodosEvent: Decodable, Sendable, Equatable {
    public let id: String
    public let todos: [TodoItem]

    public init(id: String, todos: [TodoItem]) {
        self.id = id
        self.todos = todos
    }
}
