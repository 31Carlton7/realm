import Foundation
@testable import RealmKit
import Testing

/// Moving a session from the phone: the Mac's answers as it writes them (`ts-api.json`), what a moving
/// session's status and rows say, and what the Move sheet offers.
@Suite("Moving a session")
struct MoveTests {
    static let available = APIFixtureTests.available

    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func theOptionsNameTheMacTheCheckoutAndWhereItCanGo() throws {
        let options = try APIFixtureTests.decode(MoveOptions.self, "calls", "session.moveOptions")
        #expect(options.mac == "MacBook Pro")
        #expect(options.from == Checkout(environmentId: "01JCHECKOUT000000000000001", path: "~/realm", branch: "main", kind: .primary))
        #expect(options.busy)
        #expect(options.blocked == nil)
        #expect(options.conversation == .native)
        #expect(options.changedFiles == 3)
        #expect(options.leftBehind == ["the terminal", ".env"])
        #expect(options.stops == [])
        #expect(options.checkouts.map(\.name) == ["tidy-settings"])
        #expect(options.worktree == MoveOptions.Worktree(available: true, reason: nil))
        #expect(MoveWords.chip(options) == "On MacBook Pro")
    }

    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func aMoveAnswersWithTheRowAndACancelWithWhetherItStopped() throws {
        let moved = try APIFixtureTests.decode(MovedSession.self, "calls", "session.move")
        #expect(moved.session.id == "01JSESSION00000000000000000")
        #expect(moved.session.moving == nil)
        #expect(try APIFixtureTests.decode(CancelledMove.self, "calls", "session.cancelMove").cancelled)
    }

    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func howAMoveEndedIsANoticeMarkedSo() throws {
        let opened = try APIFixtureTests.decode(OpenedSession.self, "calls", "session.open:moved")
        let notices = opened.rows.filter { $0.move != nil }
        #expect(notices.map(\.move) == [.moved, .failed, .moved])
        let texts = notices.map { row -> String? in
            if case .notice(let text) = row.content { return text }
            return nil
        }
        // The desktop's sentence, which says how the conversation went from the moved event's own field.
        #expect(texts[0] == "Moved from realm (main) to tidy-settings. The conversation continued.")
        #expect(texts[2] == "Moved from tidy-settings to realm (main). The conversation continued from notes.")
        // A failed move is the desktop's one sentence from its step and where the session still is; the
        // Mac's reason, and what it left as it was, wait for a tap.
        #expect(texts[1] == "Couldn't move this session while setting up the checkout. It's still in tidy-settings.")
        #expect(notices.map(\.noticeDetail) == [
            "~/realm → ~/Realm/worktrees/realm/tidy-settings",
            "another session started working in that checkout\nThe changes it merged into ~/realm are still there, since another session is working there.",
            "~/Realm/worktrees/realm/tidy-settings → ~/realm",
        ])
        // Every other row says nothing of moves.
        let others = try APIFixtureTests.opened().rows
        #expect(others.allSatisfy { $0.move == nil })
        // A tool's detail stays the tool's; only a goal's own turn carries the prompt as its notice's.
        #expect(others.filter { $0.goalTurn == nil }.allSatisfy { $0.noticeDetail == nil })
    }

    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func aMoveWaitingForTheTurnComesWithTheQueue() throws {
        struct Queue: Decodable { let queued: [QueuedMessage]; let move: PendingMove? }
        let queue = try APIFixtureTests.decode(Queue.self, "calls", "session.queue:move")
        #expect(queue.move == PendingMove(moveId: "01JMOVE0000000000000000004", to: .checkout(environmentId: "01JWORKTREE000000000000001"), step: nil))
        #expect(queue.move?.isQueued == true)
        // A session with no move waiting says so as null.
        #expect(try APIFixtureTests.decode(Queue.self, "calls", "session.queue").move == nil)
        let events = try APIFixtureTests.decode([SessionQueueEvent].self, "events", "session.queue")
        #expect(events.map(\.move) == [nil, nil, queue.move])
    }

    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func aSessionOpenedMidMoveOpensOnItsProgressRow() throws {
        let opened = try APIFixtureTests.decode(OpenedSession.self, "calls", "session.open:moving")
        #expect(opened.move == PendingMove(moveId: "01JMOVE0000000000000000005", to: .worktree, step: "place"))
        #expect(opened.move?.isQueued == false)
        #expect(opened.rows.map(\.key) == ["mv:01JMOVE0000000000000000005"])
        #expect(opened.rows.first?.move == .moving)
        #expect(opened.rows.first?.content == .notice(text: "Moving · Setting up the checkout"))
    }

    @Test @MainActor func aMoveQueuedWhileTheSessionOpensIsTheOneItOpensWith() throws {
        let row = try JSONDecoder().decode(SessionRow.self, from: Data(#"{"id":"s1","title":"T","spaceId":"sp","spaceName":"S","agent":"claude","model":null,"status":"running","needsYou":false,"unread":false,"updatedAt":0}"#.utf8))
        let queued = PendingMove(moveId: "m", to: .worktree, step: nil)
        let store = RealmStore()
        store.beginOpening("s1")
        store.apply(.sessionQueue(SessionQueueEvent(id: "s1", queued: [], move: queued)))
        store.finishOpening(OpenedSession(session: row, rows: [], hasMore: false, queued: [], move: nil))
        #expect(store.transcript("s1").move == queued)
        store.apply(.sessionQueue(SessionQueueEvent(id: "s1", queued: [], move: nil)))
        #expect(store.transcript("s1").move == nil)
        let options = MoveOptions(mac: "MacBook Pro", from: Checkout(environmentId: "e", path: "~/realm", branch: "main", kind: .primary), busy: true, blocked: nil, pending: true,
                                  conversation: .native, changedFiles: 0, leftBehind: [],
                                  checkouts: [Checkout(environmentId: "w", path: "~/Realm/worktrees/realm/feat-theme", branch: "feat-theme", kind: .worktree)],
                                  worktree: .init(available: true, reason: nil))
        #expect(MoveWords.destination(.worktree, in: options) == "New worktree")
        #expect(MoveWords.destination(.checkout(environmentId: "w"), in: options) == "feat-theme")
    }

    @Test func aProgressRowIsReplacedByHowTheMoveEnded() throws {
        func row(_ json: String) throws -> TranscriptRow { try JSONDecoder().decode(TranscriptRow.self, from: Data(json.utf8)) }
        var transcript = Transcript(rows: [try row(#"{"key":"m:a","seq":4,"kind":"assistant","text":"Done.","streaming":false}"#)])
        transcript.upsert([try row(#"{"key":"mv:1","seq":4,"kind":"notice","text":"Moving · Setting up the checkout","move":"moving"}"#)])
        #expect(transcript.rows.last?.move == .moving)
        transcript.upsert([try row(#"{"key":"mv:1","seq":5,"kind":"notice","text":"Moved from realm (main) to w. The conversation continued.","move":"moved"}"#)])
        #expect(transcript.rows.map(\.key) == ["m:a", "mv:1"])
        #expect(transcript.rows.last?.move == .moved)
        // A mark this phone does not know yet leaves a plain notice.
        #expect(try row(#"{"key":"mv:2","seq":6,"kind":"notice","text":"x","move":"queued"}"#).move == nil)
    }

    @Test @MainActor func aSessionBeingMovedIsMovingWhereTheMacSaysSo() throws {
        guard case .event(.sessionStatus(let moving)) = Envelope.classify(Data(#"{"event":"session.status","payload":{"id":"s1","status":"running","moving":true}}"#.utf8)),
              case .event(.sessionStatus(let running)) = Envelope.classify(Data(#"{"event":"session.status","payload":{"id":"s1","status":"running"}}"#.utf8)) else {
            Issue.record("session.status did not decode")
            return
        }
        #expect(moving.status == .moving)
        #expect(running.status == .running)
        #expect(SessionStatus.moving.word == "Moving")
        let row = try JSONDecoder().decode(SessionRow.self, from: Data(#"{"id":"s1","title":"T","spaceId":"sp","spaceName":"S","agent":"claude","model":null,"status":"running","needsYou":false,"unread":false,"updatedAt":0,"moving":true}"#.utf8))
        #expect(row.shownStatus == .moving)
        #expect(row.status == .running)
        let store = RealmStore()
        store.beginOpening("s1")
        store.finishOpening(OpenedSession(session: row, rows: [], hasMore: false))
        #expect(store.transcript("s1").status == .moving)
    }

    @Test func betweenTurnsItMovesAtOnceAndDuringOneItWaitsOrStops() {
        #expect(MoveWords.whens(working: false) == [.now])
        #expect(MoveWords.whens(working: true) == [.afterTurn, .stop])
        // Work beyond the turn is stopped only by Stop and move, idle or not.
        #expect(MoveWords.whens(working: false, stopping: true) == [.stop])
        #expect(MoveWords.whens(working: true, stopping: true) == [.stop])
        #expect([MoveWhen.now, .afterTurn, .stop].map(\.title) == ["Move", "Move after this turn", "Stop and move"])
    }

    @Test func aRefusalIsASentenceInTheMacsWords() {
        #expect(MoveWords.blocked("a teammate's chat stays where its teammate works")
            == "This session cannot move: a teammate's chat stays where its teammate works.")
        #expect(MoveWords.blocked(#"its sub-agent "Write the migration" is still running"#)
            == #"This session cannot move: its sub-agent "Write the migration" is still running."#)
        #expect(MoveWords.sentence("another session is working in that checkout; move once it has finished its turn")
            == "Another session is working in that checkout; move once it has finished its turn.")
        #expect(MoveWords.sentence("Could not move this session: x. It is still in ~/realm, as it was.")
            == "Could not move this session: x. It is still in ~/realm, as it was.")
    }

    @Test func theChipNamesTheMacOrTheCheckoutItRunsIn() {
        let worktree = Checkout(environmentId: "w", path: "~/Realm/worktrees/realm/feat-theme", branch: "feat-theme", kind: .worktree)
        let options = MoveOptions(mac: "MacBook Pro", from: worktree, busy: false, blocked: nil, pending: false, conversation: .notes,
                                  changedFiles: 1, leftBehind: [], checkouts: [], worktree: .init(available: true, reason: nil))
        #expect(MoveWords.chip(options) == "On feat-theme")
        #expect(MoveWords.detail(worktree) == "feat-theme · ~/Realm/worktrees/realm/feat-theme")
        #expect(["the terminal", ".env", "a background task (stopped)"].map(MoveWords.leftBehind) == ["The terminal", ".env", "A background task (stopped)"])
        #expect(MoveWords.changes(0) == nil)
        #expect(MoveWords.changes(1) == "1 changed file, uncommitted")
    }

    /// From a worktree, the space's own folder is named by its folder, as the desktop's sheet names it,
    /// not "This checkout", which reads as where the session already is.
    @Test func everyCheckoutIsNamedByItsFolder() {
        let primary = Checkout(environmentId: "e", path: "~/realm", branch: "main", kind: .primary)
        let worktree = Checkout(environmentId: "w", path: "~/Realm/worktrees/realm/feat-theme", branch: "realm/feat-theme", kind: .worktree)
        let options = MoveOptions(mac: "MacBook Pro", from: worktree, busy: false, blocked: nil, pending: false, conversation: .native,
                                  changedFiles: 0, leftBehind: [], checkouts: [primary], worktree: .init(available: true, reason: nil))
        #expect(primary.name == "realm" && worktree.name == "feat-theme")
        #expect(MoveWords.detail(primary) == "main · ~/realm")
        #expect(MoveWords.destination(.checkout(environmentId: "e"), in: options) == "realm")
    }

    @Test func aMacBeforeStopsSaysNothingOfThem() throws {
        let json = #"{"mac":"M","from":{"environmentId":"e","path":"~/r","branch":null,"kind":"primary"},"busy":false,"blocked":null,"pending":false,"conversation":"native","changedFiles":0,"leftBehind":[],"checkouts":[],"worktree":{"available":true,"reason":null}}"#
        #expect(try JSONDecoder().decode(MoveOptions.self, from: Data(json.utf8)).stops == nil)
        let stopping = json.replacingOccurrences(of: #""leftBehind":[]"#, with: #""leftBehind":[],"stops":["a background task"]"#)
        #expect(try JSONDecoder().decode(MoveOptions.self, from: Data(stopping.utf8)).stops == ["a background task"])
    }

    @Test func aMoveSaysWhereItGoes() throws {
        let worktree = try JSONSerialization.jsonObject(with: JSONEncoder().encode(MoveTarget.worktree)) as? [String: String]
        let checkout = try JSONSerialization.jsonObject(with: JSONEncoder().encode(MoveTarget.checkout(environmentId: "e1"))) as? [String: String]
        #expect(worktree == ["kind": "worktree"])
        #expect(checkout == ["kind": "checkout", "environmentId": "e1"])
        #expect(String(data: try JSONEncoder().encode(MoveWhen.afterTurn), encoding: .utf8) == #""after-turn""#)
    }

    @Test func theSheetPromisesNoResumeTheAgentCanDecline() {
        #expect(MoveWords.conversation(.native, agent: "Claude") == "Claude picks up where it left off, or from notes if it can't.")
        #expect(MoveWords.conversation(.notes, agent: "Cursor") == "Cursor continues from notes.")
    }
}
