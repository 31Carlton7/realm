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
        try await api.deliver(item)
        #expect(relay.methods.last == "session.answer")
        #expect(relay.params.last == ["id": "s1", "requestId": "r1", "decision": "allow", "answers": ["Which?": "SQLite"]])
        await connection.stop()
    }
}
