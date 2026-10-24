import Foundation
@testable import RealmKit
import Testing

/// A transport that answers each delivery from a script: success unless told otherwise.
final class ScriptedTransport: OutboxTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var outcomes: [Error?] = []
    private var sent: [OutgoingItem] = []
    private var sentFiles: [[AttachmentUpload]] = []
    /// Runs before a delivery returns, as the Mac's rows can arrive before its answer.
    var beforeAnswering: (@Sendable (OutgoingItem) async -> Void)?

    func fail(next errors: Error?...) {
        lock.withLock { outcomes.append(contentsOf: errors) }
    }

    var delivered: [OutgoingItem] { lock.withLock { sent } }
    /// The files each delivery carried, in order.
    var uploads: [[AttachmentUpload]] { lock.withLock { sentFiles } }

    func deliver(_ item: OutgoingItem, files: [AttachmentUpload]) async throws {
        let outcome: Error? = lock.withLock {
            sent.append(item)
            sentFiles.append(files)
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

@MainActor
@Suite("The files a message takes")
struct OutboxFilesTests {
    let directory = FileManager.default.temporaryDirectory.appending(path: "realm-outbox-\(UUID().uuidString)", directoryHint: .isDirectory)

    var files: OutboxFiles { OutboxFiles(directory: directory) }

    /// A store keeping its files in this test's folder, with session `s1` open and live at seq 4.
    func openStore() -> RealmStore {
        let store = RealmStore(files: files)
        store.finishOpening(OpenedSession(session: OutboxTests.session(), rows: [OutboxTests.user("hello", seq: 4)], hasMore: false))
        return store
    }

    static let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10])
    static let pdf = Data("%PDF-1.7".utf8)

    static func sent(_ text: String, files count: Int, seq: Int) -> TranscriptRow {
        let files = (0..<count).map { SentFile(path: "/Users/me/Realm/tmp/attachments/ab\($0)-Photo.jpg", name: "ab\($0)-Photo.jpg", mime: "image/jpeg") }
        return TranscriptRow(key: "u:\(seq)", seq: seq, content: .user(text: text), sentFiles: files)
    }

    /// A cache of its own, beside the files' folder rather than in it.
    static func cacheRoot() -> URL {
        FileManager.default.temporaryDirectory.appending(path: "realm-cache-\(UUID().uuidString)", directoryHint: .isDirectory)
    }

    func exists(_ attachment: OutgoingAttachment) -> Bool {
        FileManager.default.fileExists(atPath: files.url(of: attachment).path)
    }

    /// Kept under its id with its kind's extension, in a folder the backup leaves out, unreadable while
    /// the phone is locked.
    @Test func aFileIsKeptByItsIdOutOfTheBackup() throws {
        let photo = try files.keep(Self.jpeg, name: "Photo.jpg", mime: "image/jpeg")
        #expect(photo.file == "\(photo.id.uuidString).jpg")
        #expect(photo.size == Self.jpeg.count)
        #expect(photo.isImage)
        #expect(try files.bytes(of: photo) == Self.jpeg)
        let notes = try files.keep(Self.pdf, name: "notes", mime: "application/pdf")
        #expect(notes.file.hasSuffix(".pdf"), "a name without an extension takes its type's")
        #expect(!notes.isImage)
        #expect(try directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
        #expect(try files.url(of: photo).resourceValues(forKeys: [.fileProtectionKey]).fileProtection == .complete)
    }

    /// The Mac is sent the message's files from where they waited, and the delivery the person chose.
    @Test func aMessageTakesItsFilesAndItsDelivery() async throws {
        let store = openStore()
        let transport = ScriptedTransport()
        let photo = try files.keep(Self.jpeg, name: "Photo.jpg", mime: "image/jpeg")
        let notes = try files.keep(Self.pdf, name: "notes.pdf", mime: "application/pdf")
        let item = store.enqueueMessage("Look at these", attachments: [photo, notes], delivery: .steer, in: "s1")
        store.enqueueMessage("And then this", in: "s1")
        #expect(await Courier(store: store).deliver("s1", via: transport) == .done)
        #expect(transport.delivered.map(\.delivery) == [.steer, .auto])
        #expect(transport.delivered.first?.id == item.id)
        let uploads = try #require(transport.uploads.first)
        #expect(uploads.map(\.name) == ["Photo.jpg", "notes.pdf"])
        #expect(uploads.map(\.mime) == ["image/jpeg", "application/pdf"])
        #expect(uploads.map(\.data) == [Self.jpeg.base64EncodedString(), Self.pdf.base64EncodedString()])
        #expect(transport.uploads.last == [])
    }

    /// A message of photos alone has no words: it is settled only by a row with as many files, and a
    /// message with words and a photo never by the same words sent without one.
    @Test func aMessageSettlesOnlyAgainstARowWithAsManyFiles() throws {
        let store = openStore()
        let two = [try files.keep(Self.jpeg, name: "Photo.jpg", mime: "image/jpeg"), try files.keep(Self.jpeg, name: "Photo 2.jpg", mime: "image/jpeg")]
        let photos = store.enqueueMessage("", attachments: two, in: "s1")
        let captioned = store.enqueueMessage("Look", attachments: [try files.keep(Self.jpeg, name: "Photo 3.jpg", mime: "image/jpeg")], in: "s1")
        store.apply(.sessionRows(SessionRowsEvent(id: "s1", rows: [Self.sent("", files: 1, seq: 5), Self.sent("Look", files: 0, seq: 6)])))
        #expect(store.outbox.items.map(\.id) == [photos.id, captioned.id])
        store.apply(.sessionRows(SessionRowsEvent(id: "s1", rows: [Self.sent("", files: 2, seq: 7)])))
        #expect(store.outbox.items.map(\.id) == [captioned.id])
        store.apply(.sessionRows(SessionRowsEvent(id: "s1", rows: [Self.sent("Look", files: 1, seq: 8)])))
        #expect(store.outbox.items.isEmpty)
    }

    /// A file stays while its message waits, and goes once the message settles or is taken back.
    @Test func aFileGoesWithItsMessage() async throws {
        let store = openStore()
        let settles = try files.keep(Self.jpeg, name: "Photo.jpg", mime: "image/jpeg")
        let discarded = try files.keep(Self.pdf, name: "notes.pdf", mime: "application/pdf")
        store.enqueueMessage("", attachments: [settles], in: "s1")
        let kept = store.enqueueMessage("Read this", attachments: [discarded], in: "s1")
        let transport = ScriptedTransport()
        await Courier(store: store).deliver("s1", via: transport)
        // Delivered is not settled: a Mac that queues the message shows its row only when it goes.
        #expect(exists(settles) && exists(discarded))
        store.apply(.sessionRows(SessionRowsEvent(id: "s1", rows: [Self.sent("", files: 1, seq: 5)])))
        #expect(!exists(settles))
        #expect(exists(discarded))
        store.discardOutgoing(kept.id)
        #expect(!exists(discarded))
        // Forgetting the Mac forgets what was waiting for it, files and all.
        let waiting = try files.keep(Self.jpeg, name: "Photo.jpg", mime: "image/jpeg")
        store.enqueueMessage("", attachments: [waiting], in: "s1")
        store.forgetEverything()
        #expect(!exists(waiting))
    }

    /// A file that is no longer there fails its message in words, and the next one still goes.
    @Test func aMissingFileFailsItsMessageInWords() async throws {
        let store = openStore()
        let photo = try files.keep(Self.jpeg, name: "Photo.jpg", mime: "image/jpeg")
        let item = store.enqueueMessage("", attachments: [photo], in: "s1")
        store.enqueueMessage("Next", in: "s1")
        try FileManager.default.removeItem(at: files.url(of: photo))
        let transport = ScriptedTransport()
        #expect(await Courier(store: store).deliver("s1", via: transport) == .done)
        #expect(store.outbox.item(item.id)?.state == .failed("Photo.jpg is no longer on this iPhone."))
        #expect(transport.delivered.map(\.payload) == [.message(text: "Next")])
    }

    /// After a relaunch the files of what still waits are there to send; a message the Mac already had
    /// and a draft's file are not kept.
    @Test func aRestoredOutboxKeepsTheFilesOfWhatStillWaits() throws {
        let cache = RealmCache(root: Self.cacheRoot(), macId: "mac-1")
        let waiting = try files.keep(Self.jpeg, name: "Photo.jpg", mime: "image/jpeg")
        let had = try files.keep(Self.pdf, name: "notes.pdf", mime: "application/pdf")
        let draft = try files.keep(Self.jpeg, name: "Photo 2.jpg", mime: "image/jpeg")
        try cache.saveOutbox([
            OutgoingItem(sessionId: "s1", payload: .message(text: "Look"), state: .sending, afterSeq: 4, attachments: [waiting], delivery: .queue),
            OutgoingItem(sessionId: "s1", payload: .message(text: ""), state: .delivered, afterSeq: 4, attachments: [had]),
        ])
        let store = RealmStore(files: files)
        store.restoreOutbox(cache.loadOutbox())
        let restored = try #require(store.outbox.items.first)
        #expect(store.outbox.items.count == 1)
        #expect(restored.attachments == [waiting])
        #expect(restored.delivery == .queue)
        #expect(restored.state == .unconfirmed)
        #expect(exists(waiting))
        #expect(!exists(had))
        #expect(!exists(draft))
    }

    /// An outbox saved by the build before files and deliveries — these bytes are what it wrote —
    /// still reads, each message with no files, to go as the Mac decides.
    @Test func anOutboxSavedBeforeFilesStillReads() throws {
        let saved = #"""
        {"value":[{"createdAt":813692800,"afterSeq":4,"state":{"waiting":{}},"sessionId":"s1","payload":{"message":{"text":"Run the tests"}},"id":"6F2A9C1E-3B4D-4E5F-8A9B-0C1D2E3F4A5B"},{"sessionId":"s1","afterSeq":5,"answerValues":{"db":"sqlite"},"state":{"unconfirmed":{}},"createdAt":813692800,"id":"7A3B0D2F-4C5E-4F60-9BAC-1D2E3F4A5B6C","payload":{"answer":{"requestId":"q1","answers":{"Which database?":"SQLite"},"decision":"allow"}}},{"state":{"failed":{"_0":"This session has ended."}},"id":"8B4C1E30-5D6F-4071-ACBD-2E3F4A5B6C7D","payload":{"message":{"text":"Ship it"}},"createdAt":813692800,"afterSeq":9,"sessionId":"s2"}],"savedAt":814267236.337094}
        """#
        let cache = RealmCache(root: Self.cacheRoot(), macId: "mac-1")
        try FileManager.default.createDirectory(at: cache.directory, withIntermediateDirectories: true)
        try Data(saved.utf8).write(to: cache.directory.appending(path: "outbox.json"))
        let items = cache.loadOutbox()
        #expect(items.map(\.payload) == [.message(text: "Run the tests"),
                                         .answer(requestId: "q1", decision: .allow, answers: ["Which database?": "SQLite"]),
                                         .message(text: "Ship it")])
        #expect(items.map(\.state) == [.waiting, .unconfirmed, .failed("This session has ended.")])
        #expect(items.map(\.attachments) == [[], [], []])
        #expect(items.map(\.delivery) == [.auto, .auto, .auto])
        #expect(items[1].answerValues == ["db": .one("sqlite")])
        #expect(items[0].createdAt == Date(timeIntervalSince1970: 1_792_000_000))
    }

    /// A message's files get as long again as a slow uplink needs for them; a message of words, the
    /// radio's wait alone.
    @Test func filesGetLongerToArrive() {
        #expect(MobileAPI.deliveryTimeout(for: []) == .seconds(30))
        let tenMegabytes = AttachmentUpload(name: "Photo.jpg", mime: "image/jpeg", bytes: Data(count: 10 * 1024 * 1024))
        let timeout = MobileAPI.deliveryTimeout(for: [tenMegabytes])
        #expect(timeout > .seconds(130) && timeout < .seconds(150), "\(timeout)")
    }
}
