import Foundation

extension GoalStatus {
    /// The desktop goal strip's word for it.
    public var label: String {
        switch self {
        case .active: "Pursuing"
        case .paused: "Paused"
        case .blocked: "Blocked"
        case .budgetLimited: "Budget spent"
        case .complete: "Done"
        case .abandoned: "Dropped"
        case .other: "Goal"
        }
    }
}

extension Goal {
    /// The turn count and what it has cost, as the desktop's strip says them ("3 turns · 412k tokens",
    /// "6 turns · 75% of budget"); nil before it has taken a turn or spent anything.
    public var facts: String? {
        var parts: [String] = []
        if turns > 0 { parts.append("\(turns) turn\(turns == 1 ? "" : "s")") }
        if let tokenBudget, tokenBudget > 0 {
            parts.append("\(Int((Double(tokensUsed) / Double(tokenBudget) * 100).rounded()))% of budget")
        } else if tokensUsed > 0 {
            parts.append("\(Int((Double(tokensUsed) / 1000).rounded()))k tokens")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

/// The agent's to-do list as the desktop's strip above the prompter reads it.
public struct TodoProgress: Sendable, Equatable {
    public let items: [TodoItem]

    public init(_ items: [TodoItem]) {
        self.items = items
    }

    public var done: Int { items.filter { $0.status == .completed }.count }
    public var total: Int { items.count }
    public var allDone: Bool { total > 0 && done == total }

    /// The item being worked on: the first in progress, as the desktop's headline picks it.
    public var active: TodoItem? { items.first { $0.status == .inProgress } }

    /// "2 of 5": what the strip leads with.
    public var count: String { "\(done) of \(total)" }

    /// What the active item says it is doing, else its title; nil with none in progress.
    public var activeWords: String? { active.map { $0.activeForm ?? $0.content } }
}

extension SessionRow {
    /// The goal its row names: only one still running or waiting to be resumed; a finished one is history.
    public var shownGoal: GoalMark? { goal.flatMap { $0.status.isUnfinished ? $0 : nil } }
}
