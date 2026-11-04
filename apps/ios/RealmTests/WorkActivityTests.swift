import Foundation
import RealmKit
import Testing
@testable import Realm

/// The Live Activity's words come from the same places the work dock's do: the turn's step, the plan's
/// item under way, and the request that waits on the person.
@MainActor
@Suite("The Live Activity follows the work dock", .serialized)
struct WorkActivityContentTests {
    static let start = Date(timeIntervalSince1970: 1_000)
    static let running = TranscriptRow(key: "t:2", seq: 2, content: .tool(name: "Bash", summary: "pnpm test", state: .running, detail: nil))

    @Test func aRunningTurnSaysTheDocksStep() throws {
        let model = modelWithSession(status: .running, rows: [Self.running])
        let content = try #require(model.activityContent("s1", startedAt: Self.start))
        let dock = try #require(CurrentStep.of(model.store.transcript("s1")))
        #expect(content.phase == .working && content.step == dock.words)
        #expect(content.count == nil)
    }

    @Test func aPlanSaysItsItemUnderWayAndItsCount() throws {
        let model = GoalViewTests.model(todos: GoalViewTests.plan)
        let content = try #require(model.activityContent("s1", startedAt: Self.start))
        #expect(content.step == "Wiring the toggle" && content.count == "1 of 3")
    }

    @Test func aPermissionWaitingIsNeedsYouWithWhatItAsks() throws {
        let model = modelWithSession(status: .waiting, rows: [TranscriptRow(key: "r:3", seq: 3, content: .request(RowDrawingTests.permission))])
        let content = try #require(model.activityContent("s1", startedAt: Self.start))
        #expect(content.phase == .needsYou && content.isAmber && content.step == "Allow Bash?")
    }

    @Test func anIdleSessionIsDone() throws {
        let model = modelWithSession(status: .idle)
        let content = try #require(model.activityContent("s1", startedAt: Self.start))
        #expect(content.phase == .done && content.isFinal)
    }

    @Test func aSessionNobodyListsStartsNoActivity() {
        let model = AppModel()
        model.startActivity("nowhere", .sent)
        #expect(!model.activities.isLive)
    }
}
