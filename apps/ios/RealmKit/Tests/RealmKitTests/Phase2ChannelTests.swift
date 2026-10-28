import Foundation
@testable import RealmKit
import Testing

@Suite("Phase 2 calls over the channel (§8)")
struct Phase2ChannelTests {
    let relay = FakeRelay()
    let phone = DeviceIdentity.generate()

    func connected() async throws -> MobileConnection {
        relay.register(phone)
        let connection = MobileConnection(mac: relay.pairedMac(for: phone), identity: phone, client: ChannelTests.client, factory: relay,
                                          backoff: ChannelTests.fastBackoff, handshakeTimeout: .seconds(2))
        await connection.start()
        _ = try await connection.connected(timeout: .seconds(5))
        return connection
    }

    @Test func seenNamesTheSessionAndTheSeq() async throws {
        let connection = try await connected()
        try await MobileAPI(connection: connection).seen(id: "s1", seq: 42)
        #expect(relay.methods.last == "session.seen")
        #expect(relay.params.last == ["id": "s1", "seq": 42])
        await connection.stop()
    }

    @MainActor
    @Test func theCourierCarriesAMessageAndItsRowSettlesIt() async throws {
        let connection = try await connected()
        let api = MobileAPI(connection: connection)
        let store = RealmStore()
        store.beginOpening("s1")
        store.finishOpening(try await api.openSession(id: "s1"))
        let listener = Task { @MainActor in
            for await event in connection.events { store.apply(event) }
        }
        store.enqueueMessage("Run the tests", in: "s1")
        #expect(await Courier(store: store).deliver("s1", via: api) == .done)
        // The fake Mac echoes the message as its own user row, which settles the item.
        #expect(await eventually { await MainActor.run { store.outbox.items.isEmpty } })
        #expect(store.transcript("s1").rows.contains { $0.content == .user(text: "Run the tests") })
        listener.cancel()
        await connection.stop()
    }

    @MainActor
    @Test func anAnswerCarriesItsDecisionAndAnswers() async throws {
        let connection = try await connected()
        let api = MobileAPI(connection: connection)
        let item = OutgoingItem(sessionId: "s1", payload: .answer(requestId: "r1", decision: .allow, answers: ["Which?": "SQLite"]),
                                afterSeq: 0)
        try await api.deliver(item, files: [])
        #expect(relay.methods.last == "session.answer")
        #expect(relay.params.last == ["id": "s1", "requestId": "r1", "decision": "allow", "answers": ["Which?": "SQLite"]])
        // An answer with the Mac's keys goes by them: the options' values, a multi-select's as a list.
        let keyed = OutgoingItem(sessionId: "s1", payload: .answer(requestId: "r2", decision: .allow, answers: ["Which labels?": "Bug, Urgent"]),
                                 afterSeq: 0, answerValues: ["labels": .several(["bug", "p1"]), "team": .one("eng")])
        try await api.deliver(keyed, files: [])
        #expect(relay.params.last == ["id": "s1", "requestId": "r2", "decision": "allow", "answers": ["labels": ["bug", "p1"], "team": "eng"]])
        await connection.stop()
    }

    /// A message goes with its files and the delivery the person chose; one of words alone carries no
    /// files at all, so an older Mac reads it as it always did.
    @Test func aMessageCarriesItsFilesAndItsDelivery() async throws {
        let connection = try await connected()
        let api = MobileAPI(connection: connection)
        let photo = AttachmentUpload(name: "Photo.jpg", mime: "image/jpeg", bytes: Data([0xFF, 0xD8, 0xFF]))
        try await api.deliver(OutgoingItem(sessionId: "s1", payload: .message(text: ""), afterSeq: 0, delivery: .queue), files: [photo])
        #expect(relay.methods.last == "session.send")
        #expect(relay.params.last == ["id": "s1", "text": "", "delivery": "queue",
                                      "attachments": [["name": "Photo.jpg", "mime": "image/jpeg", "data": "/9j/"]]])
        try await api.deliver(OutgoingItem(sessionId: "s1", payload: .message(text: "Ship it"), afterSeq: 0), files: [])
        #expect(relay.params.last == ["id": "s1", "text": "Ship it", "delivery": "auto"])
        await connection.stop()
    }

    @Test func theNewCallsNameWhatTheyOpen() async throws {
        let connection = try await connected()
        let api = MobileAPI(connection: connection)
        _ = try? await api.changes(id: "s1", checkpointId: "cp1")
        #expect(relay.methods.last == "session.changes")
        #expect(relay.params.last == ["id": "s1", "checkpointId": "cp1"])
        _ = try? await api.diff(id: "s1", checkpointId: "cp1", path: "src/a.ts", from: 2000)
        #expect(relay.methods.last == "session.diff")
        #expect(relay.params.last == ["id": "s1", "checkpointId": "cp1", "path": "src/a.ts", "from": 2000])
        _ = try? await api.file(id: "s1", path: "/Users/me/shot.png")
        #expect(relay.methods.last == "session.file")
        #expect(relay.params.last == ["id": "s1", "path": "/Users/me/shot.png"])
        _ = try? await api.spaceIcon(id: "sp1")
        #expect(relay.methods.last == "space.icon")
        #expect(relay.params.last == ["id": "sp1"])
        _ = try? await api.screens(id: "s1")
        #expect(relay.methods.last == "session.screens")
        #expect(relay.params.last == ["id": "s1"])
        let simulator = SessionScreen(id: "sim1", kind: .simulator, name: "iPhone 17 Pro", detail: nil, live: true)
        _ = try? await api.screen(id: "s1", screen: simulator, maxSide: 1000)
        #expect(relay.methods.last == "session.screen")
        #expect(relay.params.last == ["id": "s1", "screenId": "sim1", "kind": "simulator", "maxSide": 1000])
        await connection.stop()
    }
}
