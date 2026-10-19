import Foundation
@testable import RealmKit
import Testing

/// A transport that answers each delivery from a script: success unless told otherwise.
final class ScriptedTransport: OutboxTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var outcomes: [Error?] = []
    private var sent: [OutgoingItem] = []
    /// Runs before a delivery returns, as the Mac's rows can arrive before its answer.
    var beforeAnswering: (@Sendable (OutgoingItem) async -> Void)?

    func fail(next errors: Error?...) {
        lock.withLock { outcomes.append(contentsOf: errors) }
    }

    var delivered: [OutgoingItem] { lock.withLock { sent } }

    func deliver(_ item: OutgoingItem) async throws {
        let outcome: Error? = lock.withLock {
            sent.append(item)
            return outcomes.isEmpty ? nil : outcomes.removeFirst()
        }
        await beforeAnswering?(item)
        if let outcome { throw outcome }
    }
}

@MainActor
@Suite("What the person gave, on its way to the Mac")
struct OutboxTests {
    static func session(_ id: String = "s1") -> SessionRow { StoreTests.session(id) }

    static func user(_ text: String, seq: Int) -> TranscriptRow {
        TranscriptRow(key: "u:\(seq)", seq: seq, content: .user(text: text))
    }

    static func request(_ id: String, _ state: RequestState, seq: Int = 5) -> TranscriptRow {
        TranscriptRow(key: "r:\(id)", seq: seq, content: .request(.init(requestId: id, tool: "Bash", title: "Allow Bash?",
                                                                        summary: "pnpm test", state: state, questions: nil)))
    }

    /// A store with session `s1` open and live, its newest row at seq 4.
    static func openStore(rows: [TranscriptRow] = [user("hello", seq: 4)]) -> RealmStore {
        let store = RealmStore()
        store.finishOpening(OpenedSession(session: session(), rows: rows, hasMore: false))
        return store
    }

    @Test func aMessageIsDeliveredThenSettledByItsOwnRow() async {
        let store = Self.openStore()
        let transport = ScriptedTransport()
        let courier = Courier(store: store)
        let item = store.enqueueMessage("Run the tests", in: "s1")
        #expect(item.afterSeq == 4)
        #expect(store.outbox.items.map(\.state) == [.waiting])

        #expect(await courier.deliver("s1", via: transport) == .done)
        #expect(transport.delivered.map(\.id) == [item.id])
        // The Mac has it; it stays as Sent until its row arrives (a queued message's comes later).
        #expect(store.outbox.items.map(\.state) == [.delivered])

        store.apply(.sessionRows(SessionRowsEvent(id: "s1", rows: [Self.user("Run the tests", seq: 7)])))
        #expect(store.outbox.items.isEmpty)
    }

    @Test func aRowThatBeatsTheAnswerSettlesItAndTheAnswerChangesNothing() async {
        let store = Self.openStore()
        let transport = ScriptedTransport()
        transport.beforeAnswering = { _ in
            await MainActor.run {
                store.apply(.sessionRows(SessionRowsEvent(id: "s1", rows: [Self.user("Run the tests", seq: 5)])))
            }
        }
        store.enqueueMessage("Run the tests", in: "s1")
        await Courier(store: store).deliver("s1", via: transport)
        #expect(store.outbox.items.isEmpty)
    }

    @Test func oneRowSettlesOneMessageEvenWhenTheWordsRepeat() async {
        let store = Self.openStore(rows: [Self.user("ok", seq: 4)])
        let first = store.enqueueMessage("ok", in: "s1")
        let second = store.enqueueMessage("ok", in: "s1")
        // The older "ok" at seq 4 came before either was given, so it settles neither.
        #expect(store.outbox.items.map(\.id) == [first.id, second.id])
        store.apply(.sessionRows(SessionRowsEvent(id: "s1", rows: [Self.user("ok", seq: 6)])))
        #expect(store.outbox.items.map(\.id) == [second.id])
        // The same row again (a re-open) does not settle the second.
        store.finishOpening(OpenedSession(session: Self.session(), rows: [Self.user("ok", seq: 4), Self.user("ok", seq: 6)], hasMore: false))
        #expect(store.outbox.items.map(\.id) == [second.id])
        store.apply(.sessionRows(SessionRowsEvent(id: "s1", rows: [Self.user("ok", seq: 8)])))
        #expect(store.outbox.items.isEmpty)
    }

    @Test func aLateAnswerLeavesItUnconfirmedNeverFailed() async {
        let store = Self.openStore()
        let transport = ScriptedTransport()
        transport.fail(next: ChannelError.timedOut)
        let item = store.enqueueMessage("Run the tests", in: "s1")
        #expect(await Courier(store: store).deliver("s1", via: transport) == .unconfirmed)
        #expect(store.outbox.item(item.id)?.state == .unconfirmed)
    }

    @Test func anUnconfirmedMessageThatArrivedIsNotSentTwice() async {
        let store = Self.openStore()
        let transport = ScriptedTransport()
        transport.fail(next: ChannelError.connectionLost)
        store.enqueueMessage("Run the tests", in: "s1")
        let courier = Courier(store: store)
        await courier.deliver("s1", via: transport)
        // The channel came back, and the session opened again with the message in it.
        store.finishOpening(OpenedSession(session: Self.session(), rows: [Self.user("hello", seq: 4), Self.user("Run the tests", seq: 6)],
                                          hasMore: false))
        #expect(await courier.deliver("s1", via: transport) == .done)
        #expect(transport.delivered.count == 1)
        #expect(store.outbox.items.isEmpty)
    }

    @Test func anUnconfirmedMessageThatDidNotArriveGoesAgain() async {
        let store = Self.openStore()
        let transport = ScriptedTransport()
        transport.fail(next: ChannelError.macOffline)
        store.enqueueMessage("Run the tests", in: "s1")
        let courier = Courier(store: store)
        await courier.deliver("s1", via: transport)
        store.finishOpening(OpenedSession(session: Self.session(), rows: [Self.user("hello", seq: 4)], hasMore: false))
        #expect(await courier.deliver("s1", via: transport) == .done)
        #expect(transport.delivered.count == 2)
        #expect(store.outbox.items.map(\.state) == [.delivered])
    }

    @Test func onlyALiveTranscriptCanSayItNeverArrived() async {
        let store = Self.openStore()
        let transport = ScriptedTransport()
        transport.fail(next: ChannelError.timedOut)
        store.enqueueMessage("Run the tests", in: "s1")
        let courier = Courier(store: store)
        await courier.deliver("s1", via: transport)
        store.markStale()
        #expect(await courier.deliver("s1", via: transport) == .unconfirmed)
        #expect(transport.delivered.count == 1)
    }

    @Test func withNoChannelItWaitsWhereItWas() async {
        let store = Self.openStore()
        let transport = ScriptedTransport()
        transport.fail(next: ChannelError.notConnected)
        let first = store.enqueueMessage("one", in: "s1")
        store.enqueueMessage("two", in: "s1")
        #expect(await Courier(store: store).deliver("s1", via: transport) == .waitingForMac)
        #expect(store.outbox.item(first.id)?.state == .waiting)
        // The second waits its turn rather than overtaking the first.
        #expect(transport.delivered.map(\.id) == [first.id])
    }

    @Test func aRefusalIsKeptInTheMacsWordsAndTheNextStillGoes() async {
        let store = Self.openStore()
        let transport = ScriptedTransport()
        transport.fail(next: ChannelError.rpc(RPCError(code: "SESSION_NOT_LIVE", message: "This session has ended.")))
        let refused = store.enqueueMessage("one", in: "s1")
        store.enqueueMessage("two", in: "s1")
        await Courier(store: store).deliver("s1", via: transport)
        #expect(store.outbox.item(refused.id)?.state == .failed("This session has ended."))
        #expect(transport.delivered.count == 2)
        store.retryOutgoing(refused.id)
        #expect(store.outbox.item(refused.id)?.state == .waiting)
        store.discardOutgoing(refused.id)
        #expect(store.outbox.item(refused.id) == nil)
    }

    @Test func anAnswerConfirmsWhenTheMacTakesItAndClearsWhenTheRequestReadsAnswered() async throws {
        let store = Self.openStore(rows: [Self.request("r1", .pending)])
        let transport = ScriptedTransport()
        let courier = Courier(store: store)
        var accepted: [UUID] = []
        courier.onAccepted = { accepted.append($0.id) }
        let item = try #require(store.enqueueAnswer(.allow, to: "r1", in: "s1"))
        #expect(accepted.isEmpty, "nothing confirms on the press")
        await courier.deliver("s1", via: transport)
        #expect(accepted == [item.id])
        #expect(store.outbox.answer(for: "r1")?.state == .delivered)
        store.apply(.sessionRows(SessionRowsEvent(id: "s1", rows: [Self.request("r1", .allowed, seq: 6)])))
        #expect(store.outbox.answer(for: "r1") == nil)
    }

    @Test func aRequestAnsweredOnTheMacFirstIsNeverAnsweredAgain() async {
        let store = Self.openStore(rows: [Self.request("r1", .pending)])
        let transport = ScriptedTransport()
        store.enqueueAnswer(.deny, to: "r1", in: "s1")
        store.apply(.sessionRows(SessionRowsEvent(id: "s1", rows: [Self.request("r1", .allowed, seq: 6)])))
        await Courier(store: store).deliver("s1", via: transport)
        #expect(transport.delivered.isEmpty)
        #expect(store.outbox.items.isEmpty)
    }

    @Test func anAnswerGoesInTheMacsShapeWhereItHasOneAndInWordsWhereItWasSavedWithout() async {
        let store = Self.openStore(rows: [Self.user("hello", seq: 4), Self.request("q1", .pending), Self.request("q2", .pending, seq: 6)])
        let transport = ScriptedTransport()
        store.enqueueAnswer(.allow, answers: ["Which labels?": "Bug"], values: ["labels": .several(["bug"])], to: "q1", in: "s1")
        store.enqueueAnswer(.allow, answers: ["Which database?": "SQLite"], to: "q2", in: "s1")
        #expect(await Courier(store: store).deliver("s1", via: transport) == .done)
        #expect(transport.delivered.map(\.answerValues) == [["labels": .several(["bug"])], nil])
    }

    @Test func oneAnswerPerRequest() {
        let store = Self.openStore(rows: [Self.request("r1", .pending)])
        #expect(store.enqueueAnswer(.allow, to: "r1", in: "s1") != nil)
        #expect(store.enqueueAnswer(.deny, to: "r1", in: "s1") == nil)
        #expect(store.outbox.items.count == 1)
    }

    @Test func nothingGoesOnItsOwnAfterADay() async {
        let store = Self.openStore()
        let transport = ScriptedTransport()
        let given = Date(timeIntervalSince1970: 1_790_000_000)
        let item = store.enqueueMessage("Run the tests", in: "s1", at: given)
        await Courier(store: store).deliver("s1", via: transport, now: { given.addingTimeInterval(OutgoingItem.maxAge + 1) })
        #expect(transport.delivered.isEmpty)
        #expect(store.outbox.item(item.id)?.isFailed == true)
    }

    @Test func leavingASessionLetsGoOfWhatTheMacAlreadyHas() async {
        let store = Self.openStore()
        let transport = ScriptedTransport()
        store.enqueueMessage("delivered", in: "s1")
        await Courier(store: store).deliver("s1", via: transport)
        transport.fail(next: ChannelError.notConnected)
        store.enqueueMessage("waiting", in: "s1")
        await Courier(store: store).deliver("s1", via: transport)
        store.closeSession("s1")
        #expect(store.outbox.items.map(\.state) == [.waiting])
    }
}
