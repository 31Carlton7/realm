import Foundation
@testable import RealmKit
import Testing

/// A message the Mac queued is the queue's to show from then on: the outbox lets it go once the queue
/// holds it, so the phone never shows it twice, and never sends it again.
@MainActor
@Suite("What the Mac queued")
struct QueueTests {
    static func queued(_ id: String, _ text: String, files: Int = 0, held: Bool = false) -> QueuedMessage {
        QueuedMessage(id: id, text: text, attachments: (0..<files).map { SentFile(path: "/tmp/\(id)-\($0).jpg", name: "Photo.jpg", mime: "image/jpeg") },
                      at: 1_790_000_000_000, held: held)
    }

    static func queueEvent(_ queued: QueuedMessage...) -> MobileEvent {
        .sessionQueue(SessionQueueEvent(id: "s1", queued: queued))
    }

    /// A store with `s1` open and live, a turn under way, and the Mac's queue as given.
    static func openStore(queued: [QueuedMessage]? = []) -> RealmStore {
        let store = RealmStore()
        store.finishOpening(OpenedSession(session: StoreTests.session("s1"), rows: [OutboxTests.user("hello", seq: 4)], hasMore: false,
                                          queued: queued))
        return store
    }

    /// The queue's event beats the send's answer, as the Mac broadcasts before it answers: the message
    /// is the queue's, and nothing of it is left in the outbox once the answer comes.
    @Test func aMessageTheMacQueuedIsTheQueuesOnceItHasIt() async {
        let store = Self.openStore()
        let transport = ScriptedTransport()
        transport.beforeAnswering = { _ in
            await MainActor.run {
                store.apply(Self.queueEvent(Self.queued("q1", "Then check the toolbar")))
                // On its way still, it is not settled: the answer can yet refuse it.
                #expect(store.outbox.items.map(\.state) == [.sending])
                #expect(store.outbox.inQueue(store.transcript("s1").queued ?? [], for: "s1").values.sorted() == ["q1"])
            }
        }
        store.enqueueMessage("Then check the toolbar", delivery: .queue, in: "s1")
        #expect(await Courier(store: store).deliver("s1", via: transport) == .done)
        #expect(store.outbox.items.isEmpty)
        #expect(store.transcript("s1").queued?.map(\.text) == ["Then check the toolbar"])
        // Its row comes when the queue sends it, and finds nothing left to settle.
        store.apply(Self.queueEvent())
        store.apply(.sessionRows(SessionRowsEvent(id: "s1", rows: [OutboxTests.user("Then check the toolbar", seq: 9)])))
        #expect(store.outbox.items.isEmpty)
        #expect(store.transcript("s1").queued == [])
    }

    /// Delivered before the queue said so, the message is the queue's as soon as it does.
    @Test func aDeliveredMessageGoesToTheQueueWhenItSaysSo() async {
        let store = Self.openStore()
        store.enqueueMessage("Then check the toolbar", in: "s1")
        await Courier(store: store).deliver("s1", via: ScriptedTransport())
        #expect(store.outbox.items.map(\.state) == [.delivered])
        store.apply(Self.queueEvent(Self.queued("q1", "  Then check the toolbar\n")))
        #expect(store.outbox.items.isEmpty)
    }

    /// The channel dropped as the message went: the session opens again with it in the Mac's queue,
    /// so it is there, and is not sent a second time.
    @Test func anUnconfirmedMessageTheMacQueuedIsNotSentAgain() async {
        let store = Self.openStore()
        let transport = ScriptedTransport()
        transport.fail(next: ChannelError.connectionLost)
        store.enqueueMessage("Then check the toolbar", in: "s1")
        let courier = Courier(store: store)
        #expect(await courier.deliver("s1", via: transport) == .unconfirmed)
        store.finishOpening(OpenedSession(session: StoreTests.session("s1"), rows: [OutboxTests.user("hello", seq: 4)], hasMore: false,
                                          queued: [Self.queued("q1", "Then check the toolbar")]))
        #expect(await courier.deliver("s1", via: transport) == .done)
        #expect(transport.delivered.count == 1)
        #expect(store.outbox.items.isEmpty)
    }

    /// A queue kept from before the link went may hold words sent since: it settles nothing.
    @Test func aQueueFromBeforeTheLinkWentSettlesNothing() async {
        let store = Self.openStore(queued: [Self.queued("q1", "ok")])
        store.markStale()
        let item = OutgoingItem(sessionId: "s1", payload: .message(text: "ok"), state: .unconfirmed, afterSeq: 4)
        store.restoreOutbox([item])
        store.settleOutbox(in: "s1")
        #expect(store.outbox.items.map(\.id) == [item.id])
    }

    /// One queued message takes one message, oldest first, by its words and as many files; what waits
    /// on this phone, or was refused, is not on the Mac and takes none.
    @Test func oneQueuedMessageTakesOneMessageByItsWordsAndFiles() {
        var outbox = Outbox()
        let first = OutgoingItem(sessionId: "s1", payload: .message(text: "ok"), state: .delivered, afterSeq: 4)
        let second = OutgoingItem(sessionId: "s1", payload: .message(text: "ok"), state: .sending, afterSeq: 4)
        let waiting = OutgoingItem(sessionId: "s1", payload: .message(text: "go"), afterSeq: 4)
        let refused = OutgoingItem(sessionId: "s1", payload: .message(text: "go"), state: .failed("No."), afterSeq: 4)
        let photo = OutgoingItem(sessionId: "s1", payload: .message(text: "look"), state: .delivered, afterSeq: 4,
                                 attachments: [OutgoingAttachment(id: UUID(), name: "Photo.jpg", mime: "image/jpeg", size: 1, file: "a.jpg")])
        let elsewhere = OutgoingItem(sessionId: "s2", payload: .message(text: "ok"), state: .delivered, afterSeq: 4)
        for item in [first, second, waiting, refused, photo, elsewhere] { outbox.add(item) }
        let queue = [Self.queued("q1", "ok"), Self.queued("q2", "go"), Self.queued("q3", "go"), Self.queued("q4", "look")]
        #expect(outbox.inQueue(queue, for: "s1") == [first.id: "q1"])
        #expect(outbox.inQueue(queue + [Self.queued("q5", "ok"), Self.queued("q6", "look", files: 1)], for: "s1")
                == [first.id: "q1", second.id: "q5", photo.id: "q6"])
        #expect(outbox.inQueue([], for: "s1").isEmpty)
    }

    /// A queue that changed while its session was opening is newer than the one the open carries.
    @Test func aQueueThatChangedWhileOpeningIsNewerThanTheOpens() {
        let store = RealmStore()
        store.beginOpening("s1")
        store.apply(Self.queueEvent(Self.queued("q2", "newer")))
        store.finishOpening(OpenedSession(session: StoreTests.session("s1"), rows: [], hasMore: false, queued: [Self.queued("q1", "older")]))
        #expect(store.transcript("s1").queued?.map(\.id) == ["q2"])
        // A Mac that says nothing of its queue leaves it unknown; a closed session's is gone.
        store.finishOpening(OpenedSession(session: StoreTests.session("s3"), rows: [], hasMore: false))
        #expect(store.transcript("s3").queued == nil)
        store.closeSession("s1")
        store.apply(Self.queueEvent(Self.queued("q3", "after")))
        #expect(store.transcripts["s1"] == nil)
    }

    /// Renamed or pinned here, an open session takes the Mac's row for it.
    @Test func anOpenSessionTakesTheMacsWordOnItsRow() {
        let store = Self.openStore()
        let renamed = SessionRow(id: "s1", title: "Ship the queue", spaceId: "sp", spaceName: "Space", agent: "claude", model: nil,
                                 status: .running, needsYou: false, unread: false, updatedAt: 9, pinned: true)
        store.sessionChanged(renamed)
        #expect(store.transcript("s1").session == renamed)
        store.sessionChanged(SessionRow(id: "s9", title: "Not open", spaceId: "sp", spaceName: "Space", agent: "claude", model: nil,
                                        status: .idle, needsYou: false, unread: false, updatedAt: 9))
        #expect(store.transcripts["s9"] == nil)
    }
}
