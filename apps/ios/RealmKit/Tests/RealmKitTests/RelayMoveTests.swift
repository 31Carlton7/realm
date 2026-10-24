import Foundation
@testable import RealmKit
import Testing

@Suite("Following the Mac to another relay (§3.3)")
struct RelayMoveTests {
    let relay = FakeRelay()
    let phone = DeviceIdentity.generate()
    static let elsewhere = URL(string: "wss://relay.realm.example")!

    func connection(to mac: PairedMac) -> MobileConnection {
        relay.register(phone)
        return MobileConnection(mac: mac, identity: phone, client: ChannelTests.client, factory: relay,
                                backoff: ChannelTests.fastBackoff, handshakeTimeout: .seconds(2))
    }

    @Test func theRelayTheMacNamesComesWithTheConnection() async throws {
        relay.announce(relay: Self.elsewhere.absoluteString)
        let connection = connection(to: relay.pairedMac(for: phone))
        await connection.start()
        let mac = try await connection.connected(timeout: .seconds(5))
        #expect(mac.relay == Self.elsewhere)
        await connection.stop()
    }

    @Test(arguments: [nil, "https://relay.realm.example", "wss://relay.realm.example/", "relay.realm.example", ""] as [String?])
    func aMacThatNamesNoRelayBaseNamesNone(_ named: String?) async throws {
        relay.announce(relay: named)
        let connection = connection(to: relay.pairedMac(for: phone))
        await connection.start()
        let mac = try await connection.connected(timeout: .seconds(5))
        #expect(mac.relay == nil)
        await connection.stop()
    }

    @Test func aPairingMovesOnlyToAnotherRelay() throws {
        let paired = relay.pairedMac(for: phone)
        let moved = try #require(paired.moved(to: Self.elsewhere))
        #expect(moved.relay == Self.elsewhere)
        // Everything that proves who the Mac is stays as it was paired.
        #expect(moved.macId == paired.macId && moved.macKey == paired.macKey && moved.phoneId == paired.phoneId)
        #expect(moved.windowId == paired.windowId && moved.pairedAt == paired.pairedAt)
        #expect(paired.moved(to: paired.relay) == nil)
        #expect(paired.moved(to: nil) == nil)
    }

    @Test func aMovedPairingIsKeptAndDialledFromThenOn() async throws {
        let vault = Vault(store: InMemorySecureStore())
        let paired = relay.pairedMac(for: phone)
        try vault.save(paired)
        try vault.save(try #require(paired.moved(to: Self.elsewhere)))
        let kept = try #require(try vault.pairedMac(id: paired.macId))
        #expect(try vault.pairedMacs().count == 1)
        #expect(kept.relay == Self.elsewhere)

        let connection = connection(to: kept)
        await connection.start()
        _ = try await connection.connected(timeout: .seconds(5))
        #expect(relay.openSockets.map(\.url.host) == ["relay.realm.example"])
        await connection.stop()
    }

    @Test func aPairingKeptByAnEarlierBuildStillReads() throws {
        // What builds before §3.3 wrote to the keychain: the same fields, encoded the same way.
        let kept = #"[{"macId":"m","macName":"MacBook Pro","relay":"wss:\/\/realm-relay-staging.realm-relay.workers.dev","#
            + #""macKey":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","phoneId":"p","windowId":"w","pairedAt":782000000}]"#
        let macs = try JSONDecoder().decode([PairedMac].self, from: Data(kept.utf8))
        #expect(macs.first?.relay == URL(string: "wss://realm-relay-staging.realm-relay.workers.dev"))
        #expect(macs.first?.macKey == Data(count: 32))
    }
}
