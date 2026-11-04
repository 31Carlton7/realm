import Foundation
@testable import RealmKit
import Testing

/// A session's goal and its agent's to-do list, as the Mac writes them (`ts-api.json`) and as the
/// phone keeps them: decoded, followed by their events, and said in the desktop's words.
@Suite("Goals and the to-do list")
struct GoalTests {
    static let available = APIFixtureTests.available
    static let session = "01JSESSION00000000000000000"

    static func events(_ name: String) throws -> [MobileEvent] {
        let payloads = try JSONSerialization.jsonObject(with: APIFixtureTests.part(["events", name])) as? [Any] ?? []
        return try payloads.map { payload in
            guard case .event(let event) = Envelope.classify(try JSONSerialization.data(withJSONObject: ["event": name, "payload": payload])) else {
                throw CocoaError(.coderReadCorrupt)
            }
            return event
        }
    }

    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func aSessionOpensWithItsGoalAndItsToDoListInTheAgentsOrder() throws {
        let opened = try APIFixtureTests.opened()
        let goal = try #require(opened.goal)
        #expect(goal.status == .active)
        #expect(goal.objective.hasPrefix("Ship the theme column"))
        #expect(goal.turns == 3 && goal.tokensUsed == 412_000 && goal.tokenBudget == nil && goal.note == nil)
        #expect(opened.session.goal == GoalMark(status: .active, objective: goal.objective))
        #expect(opened.todos?.map(\.content) == ["Add the theme column", "Backfill existing rows", "Write the down step"])
        #expect(opened.todos?.map(\.status) == [.completed, .inProgress, .pending])
        #expect(opened.todos?[1].activeForm == "Backfilling existing rows")
    }

    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func aGoalsOwnTurnIsANoticeWithThePromptUnderItNeverTheirBubble() throws {
        let opened = try APIFixtureTests.opened()
        let turn = try #require(opened.rows.first { $0.goalTurn != nil })
        #expect(turn.goalTurn == .continuation)
        #expect(turn.content == .notice(text: "Realm continued this goal"))
        #expect(turn.noticeDetail?.contains("update_goal") == true)
        let bubbles = opened.rows.compactMap { row -> String? in if case .user(let text) = row.content { text } else { nil } }
        #expect(!bubbles.contains { $0.contains("update_goal") })
        // Kept on disk and read back, it is still the goal's line.
        let again = try JSONDecoder().decode(TranscriptRow.self, from: JSONEncoder().encode(turn))
        #expect(again == turn)
    }

    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func homeNamesAnUnfinishedGoalAndABlockedOneAndAControlAnswersWithTheGoal() throws {
        let home = try APIFixtureTests.decode(Home.self, "calls", "home.get")
        let rows = home.spaces.flatMap(\.sessions)
        let blocked = try #require(rows.first { $0.goal?.status == .blocked })
        #expect(blocked.shownGoal?.objective == "Audit the sign-in sheet against the design.")
        let paused = try APIFixtureTests.decode(GoalAnswer.self, "calls", "session.goalControl").goal
        #expect(paused?.status == .paused && paused?.note == "You paused it.")
        let opened = try APIFixtureTests.decode(OpenedSession.self, "calls", "session.open:blocked")
        #expect(opened.goal?.facts == "6 turns · 75% of budget")
        #expect(opened.goal?.note?.contains("three turns") == true)
    }

    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)")) @MainActor
    func theGoalAndToDoEventsFollowAnOpenSessionAndOnesThatComeWhileItOpens() throws {
        let goals = try Self.events("session.goal"), todos = try Self.events("session.todos")
        let store = RealmStore()
        store.finishOpening(try APIFixtureTests.opened())
        store.apply(goals[1])
        store.apply(todos[0])
        #expect(store.transcript(Self.session).goal == nil, "dropped")
        #expect(store.transcript(Self.session).todos == [TodoItem(content: "Add the theme column", status: .completed, activeForm: "Adding the theme column")])
        // While it opens again, the newer word waits for the open's answer, then wins over it.
        store.beginOpening(Self.session)
        store.apply(goals[1])
        store.apply(todos[1])
        store.finishOpening(try APIFixtureTests.opened())
        #expect(store.transcript(Self.session).goal == nil)
        #expect(store.transcript(Self.session).todos.isEmpty)
        store.apply(goals[0])
        #expect(store.transcript(Self.session).goal?.status == .active)
    }

    @Test func aStatusThisPhoneDoesNotKnowStillDecodes() throws {
        let goal = try JSONDecoder().decode(Goal.self, from: Data(#"{"objective":"x","status":"snoozed","turns":0,"tokensUsed":0,"tokenBudget":null,"note":null,"startedAt":0,"updatedAt":0}"#.utf8))
        #expect(goal.status == .other("snoozed"))
        #expect(!goal.status.isUnfinished)
        let row = try JSONDecoder().decode(SessionRow.self, from: Data(#"{"id":"a","goal":{"status":"budget_limited","objective":"x"}}"#.utf8))
        #expect(row.shownGoal?.status == .budgetLimited)
    }

    @Test func theStripAndPillSayWhatTheDesktopsDo() {
        #expect([GoalStatus.active, .paused, .blocked, .budgetLimited, .complete, .abandoned].map(\.label)
            == ["Pursuing", "Paused", "Blocked", "Budget spent", "Done", "Dropped"])
        #expect(Goal(objective: "x", status: .active).facts == nil)
        #expect(Goal(objective: "x", status: .active, turns: 1, tokensUsed: 12_400).facts == "1 turn · 12k tokens")
        let progress = TodoProgress([
            TodoItem(content: "Read", status: .completed),
            TodoItem(content: "Write the summary", status: .inProgress, activeForm: "Writing the summary"),
            TodoItem(content: "Test", status: .inProgress),
            TodoItem(content: "Send", status: .pending),
        ])
        #expect(progress.count == "1 of 4")
        #expect(progress.activeWords == "Writing the summary", "the first item under way, in its own words")
        #expect(TodoProgress([TodoItem(content: "Test", status: .inProgress)]).activeWords == "Test")
        #expect(TodoProgress([TodoItem(content: "Read", status: .completed)]).allDone)
        #expect(!TodoProgress([]).allDone)
    }

    @Test func aFinishedGoalIsNotNamedOnItsRow() {
        let row = { (status: GoalStatus) in
            SessionRow(id: "a", title: "A", spaceId: "s", spaceName: "S", agent: "claude", model: nil, status: .idle, needsYou: false, unread: false,
                       updatedAt: 0, goal: GoalMark(status: status, objective: "x"))
        }
        #expect(row(.complete).shownGoal == nil)
        #expect(row(.abandoned).shownGoal == nil)
        #expect(row(.blocked).shownGoal?.status == .blocked)
    }
}

private struct GoalAnswer: Decodable { let goal: Goal? }
