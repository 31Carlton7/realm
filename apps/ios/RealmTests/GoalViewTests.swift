import RealmKit
import SwiftUI
import Testing
@testable import Realm

/// The goal and the agent's plan as the phone draws them: the goal's own turns as Realm's line, never
/// the prompt in the person's bubble; the pill over the composer; the plan strip, folded and open.
@MainActor
@Suite("Goals and the plan strip draw", .serialized)
struct GoalViewTests {
    static let prompt = "Continue working towards this objective:\n\nShip it\n\nCall the `mcp__realm__realm-goal__update_goal` tool with `complete` only when every requirement is met."

    static func model(goal: Goal? = nil, todos: [TodoItem] = []) -> AppModel {
        let model = modelWithSession()
        model.store.apply(.sessionGoal(SessionGoalEvent(id: "s1", goal: goal)))
        model.store.apply(.sessionTodos(SessionTodosEvent(id: "s1", todos: todos)))
        return model
    }

    static let plan = [
        TodoItem(content: "Read the notes", status: .completed, activeForm: "Reading the notes"),
        TodoItem(content: "Wire the toggle", status: .inProgress, activeForm: "Wiring the toggle"),
        TodoItem(content: "Check both themes", status: .pending, activeForm: "Checking both themes"),
    ]

    @Test func aGoalsOwnTurnIsRealmsLineAndThePromptWaitsForATap() throws {
        let row = TranscriptRow(key: "u:5", seq: 5, content: .notice(text: "Realm continued this goal"), noticeDetail: Self.prompt, goalTurn: .continuation)
        for dark in [true, false] {
            let words = try Drawing.words(TranscriptRowView(row: row, sessionId: "s1").environment(AppModel()), dark: dark)
            #expect(words.contains("Realm continued this goal"), "\(words)")
            #expect(!words.contains("update_goal") && !words.contains("Continue working"), "\(words)")
        }
    }

    @Test func thePillSaysWhereTheGoalStandsWhatItIsAndItsTurns() throws {
        let active = try Drawing.words(GoalPill(sessionId: "s1").environment(Self.model(goal: Goal(objective: "Ship the theme switch", status: .active, turns: 3, tokensUsed: 41_000))))
        #expect(active.contains("Pursuing") && active.contains("Ship the theme switch") && active.contains("3 turns"), "\(active)")
        let blocked = try Drawing.words(GoalPill(sessionId: "s1").environment(Self.model(goal: Goal(objective: "Audit the sheet", status: .blocked, turns: 6))), dark: false)
        #expect(blocked.contains("Blocked") && blocked.contains("Audit the sheet"), "\(blocked)")
        #expect(GoalStatus.blocked.tone == .waiting && GoalStatus.active.tone == .quiet && GoalStatus.paused.tone == .quiet)
    }

    @Test func thePlanFoldsToItsCountAndTheItemUnderWayAndOpensToEveryItemInOrder() throws {
        let model = Self.model(todos: Self.plan)
        let folded = try Drawing.words(TodoStrip(sessionId: "s1").environment(model))
        #expect(folded.contains("1 of 3") && folded.contains("Wiring the toggle"), "\(folded)")
        #expect(!folded.contains("Check both themes"), "folded, only the item under way: \(folded)")
        let open = try Drawing.words(TodoStrip(sessionId: "s1", open: true).environment(model), dark: false)
        let at = ["Read the notes", "Wire the toggle", "Check both themes"].map { open.range(of: $0)?.lowerBound }
        #expect(at.allSatisfy { $0 != nil }, "\(open)")
        #expect(at.compactMap { $0 } == at.compactMap { $0 }.sorted(), "in the agent's order: \(open)")
    }

    @Test func noGoalAndNoPlanDrawNothing() throws {
        let model = Self.model()
        #expect(try Drawing.words(GoalPill(sessionId: "s1").environment(model)).isEmpty)
        #expect(try Drawing.words(TodoStrip(sessionId: "s1").environment(model)).isEmpty)
    }

    @Test func homeSaysAnUnfinishedGoalAndNotAFinishedOne() {
        func row(_ status: GoalStatus) -> SessionRow {
            SessionRow(id: "a", title: "Audit the sheet", spaceId: "s", spaceName: "Realm", agent: "claude", model: nil, status: .idle,
                       needsYou: false, unread: false, updatedAt: 0, goal: GoalMark(status: status, objective: "Audit it"))
        }
        #expect(SessionRowView.spoken(row(.blocked)).contains("Goal Blocked"))
        #expect(SessionRowView.spoken(row(.active)).contains("Goal Pursuing"))
        #expect(!SessionRowView.spoken(row(.complete)).contains("Goal"))
    }
}
