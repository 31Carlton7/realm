import Foundation
@testable import RealmKit
import Testing

/// A session's row renamed, pinned or archived, and the Mac's queue, as the Mac writes them
/// (`packages/remote/test/fixtures/ts-api.json`).
@Suite("A row's changes and the queue as the Mac writes them")
struct RowAndQueueFixtureTests {
    static let available = APIFixtureTests.available

    /// `session.update`'s answer, as `MobileAPI.updateSession` reads it.
    struct Updated: Decodable { let session: SessionRow? }

    /// The row comes back as it now is, pinned and renamed; an archived one comes back as none.
    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func aChangedRowComesBackAsItIsAndAnArchivedOneAsNone() throws {
        let row = try #require(try APIFixtureTests.decode(Updated.self, "calls", "session.update").session)
        #expect(row.title == "Write the 2.0.3 changelog" && row.pinned == true)
        #expect(try APIFixtureTests.decode(Updated.self, "calls", "session.update:archived").session == nil)
        // Every row says whether it is pinned, so Home's Pinned is the Mac's own.
        let home = try APIFixtureTests.decode(Home.self, "calls", "home.get")
        #expect(home.spaces.flatMap(\.sessions).allSatisfy { $0.pinned != nil })
        #expect(home.recent?.filter { $0.pinned == true }.map(\.title) == ["Ship 2.0.3"])
    }

    /// The queue comes with the session and from `session.queue`: each message with its files, by the
    /// names its row will have, and its hold.
    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func theQueueCarriesEachMessageWithItsFilesAndItsHold() throws {
        struct Queue: Decodable { let queued: [QueuedMessage] }
        let queued = try #require(try APIFixtureTests.opened().queued)
        #expect(queued.map(\.text) == ["Then rename the column to theme_mode", "Use this sketch for the toggle"])
        #expect(queued.map(\.held) == [true, false])
        #expect(queued[1].attachments.map(\.name) == ["sketch.png"] && queued[1].attachments[0].isImage)
        #expect(try APIFixtureTests.decode(Queue.self, "calls", "session.queue").queued == queued)
        // A queued picture is previewed as a sent one is, under its own name.
        let preview = try APIFixtureTests.decode(FilePreview.self, "calls", "session.file:queued")
        #expect(preview.path == queued[1].attachments[0].path && preview.name == "sketch.png")
    }

    /// The event carries the whole queue each time it changes, down to none.
    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func theQueueEventCarriesTheWholeQueue() throws {
        let payloads = try JSONSerialization.jsonObject(with: APIFixtureTests.part(["events", "session.queue"])) as? [Any] ?? []
        let events = try payloads.map { payload in
            Envelope.classify(try JSONSerialization.data(withJSONObject: ["event": "session.queue", "payload": payload]))
        }
        guard case .event(.sessionQueue(let first)) = events.first, case .event(.sessionQueue(let emptied)) = events.last else {
            Issue.record("session.queue did not decode")
            return
        }
        #expect(first.queued.count == 2 && first.queued[0].held)
        #expect(emptied.queued.isEmpty)
    }

    /// A photo this phone sent mid-turn, delivered, is the Mac's queue's once the queue holds it.
    @MainActor
    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func aDeliveredMessageTheFixturesQueueHoldsIsTheQueues() throws {
        let opened = try APIFixtureTests.opened()
        let store = RealmStore()
        let sketch = OutgoingAttachment(id: UUID(), name: "sketch.png", mime: "image/png", size: 3, file: "sketch.png")
        let item = store.enqueueMessage("Use this sketch for the toggle", attachments: [sketch], in: opened.session.id)
        store.setOutgoing(item.id, .delivered)
        store.finishOpening(opened)
        #expect(store.outbox.items.isEmpty)
    }
}
