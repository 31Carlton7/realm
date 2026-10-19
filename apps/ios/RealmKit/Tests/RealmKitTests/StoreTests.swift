import Foundation
@testable import RealmKit
import Testing

@Suite("App state")
struct StoreTests {
    static func row(_ key: String, _ text: String, seq: Int = 1) -> TranscriptRow {
        TranscriptRow(key: key, seq: seq, content: .assistant(text: text, streaming: false))
    }

    static func session(_ id: String) -> SessionRow {
        SessionRow(id: id, title: "T", spaceId: "sp", spaceName: "Space", agent: "claude", model: nil, status: .running,
                   needsYou: false, unread: false, updatedAt: 0)
    }

    @Test func aRowWithAKnownKeyIsReplacedWhereItStands() {
        var transcript = Transcript(rows: [Self.row("a", "1"), Self.row("b", "2"), Self.row("c", "3")])
        transcript.upsert([Self.row("b", "2, streamed further"), Self.row("d", "4")])
        #expect(transcript.rows.map(\.key) == ["a", "b", "c", "d"])
        #expect(transcript.row(forKey: "b")?.content == .assistant(text: "2, streamed further", streaming: false))
        transcript.replaceAll(with: [Self.row("z", "only")])
        #expect(transcript.rows.map(\.key) == ["z"])
        #expect(transcript.row(forKey: "a") == nil)
    }

    @MainActor
    @Test func rowsThatBeatTheOpenResponseAreAppliedAfterIt() throws {
        let store = RealmStore()
        store.beginOpening("s1")
        store.apply(.sessionRows(SessionRowsEvent(id: "s1", rows: [Self.row("m:new", "newer than the page", seq: 9)])))
        store.finishOpening(OpenedSession(session: Self.session("s1"), rows: [Self.row("u:1", "page"), Self.row("m:new", "older", seq: 8)], hasMore: false))
        #expect(store.transcript("s1").rows.map(\.key) == ["u:1", "m:new"])
        #expect(store.transcript("s1").row(forKey: "m:new")?.seq == 9)
        store.apply(.sessionRows(SessionRowsEvent(id: "s1", rows: [Self.row("u:2", "next", seq: 10)])))
        #expect(store.transcript("s1").rows.map(\.key) == ["u:1", "m:new", "u:2"])
        store.apply(.sessionStatus(SessionStatusEvent(id: "s1", status: .idle)))
        #expect(store.transcript("s1").status == .idle)
        // Rows for a session that is not open are not kept.
        store.apply(.sessionRows(SessionRowsEvent(id: "s2", rows: [Self.row("x", "y")])))
        #expect(store.transcripts["s2"] == nil)
    }

    @MainActor
    @Test func theSuggestedNextMessageComesWithTheSessionAndGoesWhenTheMacSaysSo() throws {
        let store = RealmStore()
        store.finishOpening(OpenedSession(session: Self.session("s1"), rows: [], hasMore: false, hint: "Run the tests"))
        #expect(store.transcript("s1").hint == "Run the tests")
        store.apply(.sessionHint(SessionHintEvent(id: "s1", text: "Ship it")))
        #expect(store.transcript("s1").hint == "Ship it")
        // Something was sent: the Mac takes the suggestion away, and so does the phone.
        store.apply(.sessionHint(SessionHintEvent(id: "s1", text: nil)))
        #expect(store.transcript("s1").hint == nil)
        // A hint that changes while the session is opening is newer than the one the open carries.
        store.beginOpening("s2")
        store.apply(.sessionHint(SessionHintEvent(id: "s2", text: nil)))
        store.finishOpening(OpenedSession(session: Self.session("s2"), rows: [], hasMore: false, hint: "An older suggestion"))
        #expect(store.transcript("s2").hint == nil)
        // The cache keeps it with the rows, and a snapshot from before hints reads as none.
        store.apply(.sessionHint(SessionHintEvent(id: "s1", text: "Open the PR")))
        let snapshot = TranscriptSnapshot(store.transcript("s1"))
        let restored = try JSONDecoder().decode(TranscriptSnapshot.self, from: JSONEncoder().encode(snapshot))
        #expect(Transcript(restored, savedAt: Date()).hint == "Open the PR")
        let older = try JSONDecoder().decode(TranscriptSnapshot.self, from: Data(#"{"rows":[],"hasMore":false}"#.utf8))
        #expect(older.hint == nil)
    }

    @MainActor
    @Test func aWatcherHearsTheMatchingRow() async throws {
        let store = RealmStore()
        store.finishOpening(OpenedSession(session: Self.session("s1"), rows: [], hasMore: false))
        async let arrival = store.waitForRow(in: "s1", timeout: .seconds(5)) { row in
            if case .user(let text) = row.content { return text == "echo me" }
            return false
        }
        await Task.yield()
        let sent = ContinuousClock.now
        store.apply(.sessionRows(SessionRowsEvent(id: "s1", rows: [TranscriptRow(key: "u:3", seq: 3, content: .user(text: "something else"))])))
        store.apply(.sessionRows(SessionRowsEvent(id: "s1", rows: [TranscriptRow(key: "u:4", seq: 4, content: .user(text: "echo me"))])))
        #expect(try await arrival >= sent)
    }

    @MainActor
    @Test func aWatchStartedBeforeTheRowKeepsItsArrival() async throws {
        let store = RealmStore()
        let watch = store.watchForRow(in: "s1") { $0.key == "u:9" }
        store.apply(.sessionRows(SessionRowsEvent(id: "s1", rows: [TranscriptRow(key: "u:9", seq: 9, content: .user(text: "x"))])))
        let afterwards = ContinuousClock.now
        // Awaited only after the row came: the arrival is still the moment it came.
        #expect(try await watch.arrival(timeout: .seconds(1)) <= afterwards)
    }

    @MainActor
    @Test func aWatcherTimesOut() async {
        let store = RealmStore()
        await #expect(throws: ChannelError.timedOut) {
            _ = try await store.waitForRow(in: "s1", timeout: .milliseconds(20)) { _ in true }
        }
    }

    @Test func percentilesAreNearestRank() {
        let samples = (1...100).map { Duration.milliseconds($0) }
        #expect(LatencySamples.percentile(samples, 0.5) == .milliseconds(50))
        #expect(LatencySamples.percentile(samples, 0.95) == .milliseconds(95))
        #expect(LatencySamples.percentile([.milliseconds(7)], 0.95) == .milliseconds(7))
        #expect(LatencySamples.percentile([], 0.5) == nil)
        #expect(Duration.milliseconds(1500).milliseconds == 1500)
    }

    @Test func backoffGrowsToItsCap() {
        let backoff = Backoff(base: .milliseconds(500), cap: .seconds(30), jitter: 0.3)
        func ms(_ attempt: Int, _ random: Double) -> Double { backoff.delay(attempt: attempt, random: random).milliseconds }
        #expect(abs(ms(0, 1) - 500) < 0.001)
        #expect(abs(ms(3, 1) - 4_000) < 0.001)
        #expect(abs(ms(30, 1) - 30_000) < 0.001)
        #expect(abs(ms(3, 0) - 2_800) < 0.001)
    }
}
