import Foundation
@testable import RealmKit
import Testing

/// What a session's Live Activity says as its turn runs and ends, and when one starts and ends.
@Suite("The Live Activity's state")
struct WorkActivityTests {
    static let start = Date(timeIntervalSince1970: 1_000)
    static let plan = TodoProgress([
        TodoItem(content: "Read the notes", status: .completed, activeForm: "Reading the notes"),
        TodoItem(content: "Add the tokens", status: .completed, activeForm: "Adding the tokens"),
        TodoItem(content: "Wire the toggle", status: .inProgress, activeForm: "Wiring the toggle"),
        TodoItem(content: "Check both themes", status: .pending),
        TodoItem(content: "Write the changelog", status: .pending),
    ])

    static func content(_ status: SessionStatus?, needsYou: Bool = false, step: String? = "Running pnpm test",
                        request: String? = nil, plan: TodoProgress? = nil) -> WorkActivityContent? {
        WorkActivityContent.of(status: status, needsYou: needsYou, step: step, request: request, plan: plan,
                               startedAt: start, now: start.addingTimeInterval(133))
    }

    @Test func aRunningTurnSaysItsStepAndKeepsCounting() throws {
        let content = try #require(Self.content(.running))
        #expect(content.phase == .working && content.step == "Running pnpm test")
        #expect(content.count == nil && content.label == nil && !content.isAmber)
        #expect(content.endedAt == nil && content.elapsed == nil && !content.isFinal)
        #expect(Self.content(.running, step: nil)?.step == "Working")
    }

    @Test func aPlanPutsItsItemUnderWayFirstWithItsCount() throws {
        let content = try #require(Self.content(.running, plan: Self.plan))
        #expect(content.step == "Wiring the toggle")
        #expect(content.count == "2 of 5" && content.progress == 0.4)
        let empty = try #require(Self.content(.running, plan: TodoProgress([])))
        #expect(empty.count == nil && empty.progress == nil && empty.done == nil)
    }

    @Test func aRequestWaitingIsNeedsYouInAmberAndStaysLive() throws {
        let content = try #require(Self.content(.waiting, request: "Allow Bash?", plan: Self.plan))
        #expect(content.phase == .needsYou && content.label == "Needs you" && content.isAmber)
        #expect(content.step == "Allow Bash?" && content.count == "2 of 5")
        #expect(!content.isFinal)
        #expect(Self.content(.waiting)?.step == "Waiting for your answer")
    }

    @Test func aFinishedTurnIsDoneWithItsClockStopped() throws {
        let content = try #require(Self.content(.idle, plan: Self.plan))
        #expect(content.phase == .done && content.step == "Done" && !content.isAmber)
        #expect(content.isFinal && content.elapsed == "02:13" && content.count == "2 of 5")
        #expect(Self.content(.ended)?.phase == .done)
    }

    @Test func aTurnThatEndsOnSomethingToAnswerEndsOnNeedsYou() throws {
        let content = try #require(Self.content(.idle, needsYou: true))
        #expect(content.phase == .needsYou && content.isAmber && content.isFinal)
        #expect(content.step == "Turn ended")
    }

    @Test func aFailedTurnIsAmberToo() throws {
        let content = try #require(Self.content(.error))
        #expect(content.phase == .failed && content.isAmber && content.isFinal && content.step == "Failed")
    }

    @Test func aStatusThisPhoneDoesNotKnowSaysNothing() {
        #expect(Self.content(nil) == nil)
        #expect(Self.content(.other("paused")) == nil)
        #expect(Self.content(.moving)?.phase == .working)
    }

    @Test func itStartsOncePerSessionAndOnlyWhereItIsAllowed() {
        for trigger in [WorkActivityRules.Trigger.sent, .startedWhileViewing] {
            #expect(WorkActivityRules.shouldStart(trigger, enabled: true, allowed: true, live: false))
            #expect(!WorkActivityRules.shouldStart(trigger, enabled: false, allowed: true, live: false), "Show on Lock Screen is off")
            #expect(!WorkActivityRules.shouldStart(trigger, enabled: true, allowed: false, live: false), "iOS has them off")
            #expect(!WorkActivityRules.shouldStart(trigger, enabled: true, allowed: true, live: true), "one per session")
        }
    }

    @Test func itEndsOnlyOnceTheTurnItFollowedHasRun() throws {
        let idle = try #require(Self.content(.idle))
        #expect(!WorkActivityRules.ends(idle, turnSeen: false), "a message just sent: the Mac has not started the turn")
        #expect(WorkActivityRules.ends(idle, turnSeen: true))
        let running = try #require(Self.content(.running))
        #expect(!WorkActivityRules.ends(running, turnSeen: true))
        let waiting = try #require(Self.content(.waiting))
        #expect(!WorkActivityRules.ends(waiting, turnSeen: true), "a request mid-turn keeps it live")
    }

    @Test func theStateCrossesToTheExtensionWhole() throws {
        let content = try #require(Self.content(.waiting, request: "Allow Bash?", plan: Self.plan))
        let decoded = try JSONDecoder().decode(WorkActivityContent.self, from: JSONEncoder().encode(content))
        #expect(decoded == content)
    }

    @Test func aTapOpensItsSession() throws {
        let url = try #require(SessionLink.url("01JSESSION00000000000000000"))
        #expect(url.absoluteString == "realm-mobile://session/01JSESSION00000000000000000")
        #expect(SessionLink.sessionId(in: url) == "01JSESSION00000000000000000")
        #expect(SessionLink.sessionId(in: URL(string: "realm-mobile://share")!) == nil)
        #expect(SessionLink.sessionId(in: URL(string: "realm-mobile://session/")!) == nil)
        #expect(SessionLink.sessionId(in: URL(string: "https://realm.computer/session/x")!) == nil)
    }

    @Test func theClockReadsAsTheDocksDoes() {
        #expect(TurnClock.words(16) == "00:16")
        #expect(TurnClock.words(723) == "12:03")
        #expect(TurnClock.words(3723) == "1:02:03")
        #expect(TurnClock.words(-4) == "00:00")
    }
}
