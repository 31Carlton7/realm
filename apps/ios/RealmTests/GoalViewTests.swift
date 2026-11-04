import RealmKit
import SwiftUI
import Testing
@testable import Realm

/// The goal and the agent's plan as the phone draws them: the goal's own turns as Realm's line, never
/// the prompt in the person's bubble; and the one dock over the composer, folded and open.
@MainActor
@Suite("Goals and the work dock draw", .serialized)
struct GoalViewTests {
    static let prompt = "Continue working towards this objective:\n\nShip it\n\nCall the `mcp__realm__realm-goal__update_goal` tool with `complete` only when every requirement is met."

    static func model(goal: Goal? = nil, todos: [TodoItem] = [], status: SessionStatus = .running) -> AppModel {
        let model = modelWithSession(status: status)
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

    static func dock(_ model: AppModel, open: Bool = false, dark: Bool = true) throws -> String {
        try Drawing.words(WorkDock(sessionId: "s1", planOpen: open).environment(model), dark: dark)
    }

    @Test func workingAloneIsTheOneWorkingLine() throws {
        let words = try Self.dock(Self.model())
        #expect(words.contains("Working"), "\(words)")
        #expect(!words.contains(" of ") && !words.contains("Pursuing"), "\(words)")
    }

    @Test func aPlanPutsTheItemUnderWayFirstAndItsCountUnderIt() throws {
        let words = try Self.dock(Self.model(todos: Self.plan))
        #expect(words.contains("Wiring the toggle") && words.contains("1 of 3"), "\(words)")
        #expect(!words.contains("Working") && !words.contains("Check both themes"), "folded, only the item under way: \(words)")
    }

    @Test func theOpenPlanListsEveryItemInTheAgentsOrder() throws {
        let words = try Self.dock(Self.model(todos: Self.plan), open: true, dark: false)
        let at = ["Read the notes", "Wire the toggle", "Check both themes"].map { words.range(of: $0)?.lowerBound }
        #expect(at.allSatisfy { $0 != nil }, "\(words)")
        #expect(at.compactMap { $0 } == at.compactMap { $0 }.sorted(), "in the agent's order: \(words)")
    }

    @Test func aGoalAloneSitsUnderTheWorkingLineWithItsTurns() throws {
        let words = try Self.dock(Self.model(goal: Goal(objective: "Ship the theme switch", status: .active, turns: 3, tokensUsed: 41_000)))
        #expect(words.contains("Working") && words.contains("Ship the theme switch") && words.contains("3 turns"), "\(words)")
        #expect(!words.contains("Pursuing"), "the spinner says it is pursuing: \(words)")
    }

    @Test func aGoalAndAPlanAreOneDockOfTwoLines() throws {
        let model = Self.model(goal: Goal(objective: "Ship the theme switch", status: .active, turns: 3), todos: Self.plan)
        for dark in [true, false] {
            let words = try Self.dock(model, dark: dark)
            #expect(words.contains("Wiring the toggle") && words.contains("Ship the theme switch") && words.contains("1 of 3"), "\(words)")
            #expect(words.range(of: "Wiring the toggle")!.lowerBound < words.range(of: "Ship the theme switch")!.lowerBound, "what is under way first: \(words)")
            #expect(!words.contains("Working") && !words.contains("Pursuing"), "\(words)")
        }
    }

    @Test func aBlockedGoalBetweenTurnsIsOnlyTheGoalLineInAmber() throws {
        let words = try Self.dock(Self.model(goal: Goal(objective: "Audit the sheet", status: .blocked, turns: 6), status: .idle), dark: false)
        #expect(words.contains("Blocked") && words.contains("Audit the sheet") && words.contains("6 turns"), "\(words)")
        #expect(!words.contains("Working"), "\(words)")
        #expect(GoalStatus.blocked.tone.agentColor == Palette.orange && GoalStatus.active.tone == .quiet && GoalStatus.paused.tone == .quiet)
    }

    @Test func nothingUnderWayAndNoGoalOrPlanDrawNothing() throws {
        #expect(try Self.dock(Self.model(status: .idle)).isEmpty)
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
