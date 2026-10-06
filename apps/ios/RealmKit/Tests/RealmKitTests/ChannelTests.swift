import CryptoKit
import Foundation
@testable import RealmKit
import Testing

@Suite("The channel against a fake relay and Mac (§3, §4.2, §6)")
struct ChannelTests {
    let relay = FakeRelay()
    let phone = DeviceIdentity.generate()
    static let client = ClientInfo(app: "0.1 (1)", os: "iOS 26.0")
    static let fastBackoff = Backoff(base: .milliseconds(10), cap: .milliseconds(50), jitter: 0)

    func makeConnection(macKey: Data? = nil, heartbeat: Duration = .seconds(20), requestTimeout: Duration = .seconds(5)) -> MobileConnection {
        relay.register(phone)
        return MobileConnection(mac: relay.pairedMac(for: phone, macKey: macKey), identity: phone, client: Self.client,
                                factory: relay, backoff: Self.fastBackoff, handshakeTimeout: .seconds(2),
                                requestTimeout: requestTimeout, heartbeat: heartbeat)
    }

    @Test func connectsAuthenticatesAndCalls() async throws {
        let connection = makeConnection()
        await connection.start()
        let mac = try await connection.connected(timeout: .seconds(5))
        #expect(mac.name == "Fake Mac")
        #expect(mac.server == "test")
        let api = MobileAPI(connection: connection)
        #expect(try await api.ping().at == 1_790_000_000_123)
        let home = try await api.home()
        #expect(home.spaces.first?.sessions.first?.id == "s1")
        #expect(relay.methods == ["ping", "home.get"])
        await connection.stop()
    }

    @Test func theHandshakeIsPipelinedBehindAuth() async throws {
        relay.holdReady(true)
        let connection = makeConnection()
        await connection.start()
        // `ready` has not been sent, yet the Mac's answer arrives: message 1 went right behind `auth`.
        _ = try await connection.connected(timeout: .seconds(5))
        relay.holdReady(false)
        #expect(try await MobileAPI(connection: connection).ping().at > 0)
        await connection.stop()
    }

    @Test func eventsArriveOnTheStream() async throws {
        let connection = makeConnection()
        await connection.start()
        _ = try await connection.connected(timeout: .seconds(5))
        let api = MobileAPI(connection: connection)
        let opened = try await api.openSession(id: "s1")
        #expect(opened.rows.map(\.key) == ["u:1"])
        let echoed = Task { () -> TranscriptRow? in
            for await event in connection.events {
                if case .sessionRows(let update) = event, let row = update.rows.first { return row }
            }
            return nil
        }
        try await api.send(id: "s1", text: "Run the tests / again")
        let row = await echoed.value
        #expect(row?.content == .user(text: "Run the tests / again"))
        #expect(row?.key == "u:101")
        await connection.stop()
    }

    @Test func aMethodTheMacDoesNotKnowIsAnRPCError() async throws {
        let connection = makeConnection()
        await connection.start()
        _ = try await connection.connected(timeout: .seconds(5))
        await #expect(throws: ChannelError.rpc(RPCError(code: "METHOD_NOT_FOUND", message: "nope"))) {
            _ = try await connection.call("nope", as: Acknowledged.self)
        }
        await connection.stop()
    }

    @Test func aCallWithNoAnswerTimesOut() async throws {
        let connection = makeConnection(requestTimeout: .milliseconds(100))
        await connection.start()
        _ = try await connection.connected(timeout: .seconds(5))
        await #expect(throws: ChannelError.timedOut) {
            _ = try await connection.call("slow", as: Acknowledged.self)
        }
        await connection.stop()
    }

    @Test func anOfflineMacIsWaitedForThenHandshakenWith() async throws {
        relay.setMacOnline(false)
        let connection = makeConnection()
        await connection.start()
        #expect(await eventually { if case .macOffline = await connection.state { return true } else { return false } })
        relay.setMacOnline(true)
        _ = try await connection.connected(timeout: .seconds(5))
        #expect(relay.socketCount == 1, "coming online re-handshakes on the same socket")
        await connection.stop()
    }

    @Test func theMacGoingAwayAndBackStartsANewHandshake() async throws {
        let connection = makeConnection()
        await connection.start()
        _ = try await connection.connected(timeout: .seconds(5))
        relay.setMacOnline(false)
        #expect(await eventually { if case .macOffline = await connection.state { return true } else { return false } })
        await #expect(throws: ChannelError.notConnected) { _ = try await MobileAPI(connection: connection).ping() }
        relay.setMacOnline(true)
        _ = try await connection.connected(timeout: .seconds(5))
        #expect(try await MobileAPI(connection: connection).ping().at > 0)
        await connection.stop()
    }

    @Test func aDroppedSocketReconnects() async throws {
        let connection = makeConnection()
        await connection.start()
        _ = try await connection.connected(timeout: .seconds(5))
        relay.dropAll(code: 1006)
        #expect(await eventually { relay.socketCount == 2 && relay.openSockets.count == 1 })
        _ = try await connection.connected(timeout: .seconds(5))
        #expect(try await MobileAPI(connection: connection).ping().at > 0)
        await connection.stop()
    }

    @Test func removedByTheMacStopsTrying() async throws {
        let connection = makeConnection()
        await connection.start()
        _ = try await connection.connected(timeout: .seconds(5))
        relay.remove(phone.id)
        #expect(await eventually { await connection.state == .refused(code: 4410, reason: MobileConnection.refusal(4410)!) })
        try await Task.sleep(for: .milliseconds(150))
        #expect(relay.socketCount == 1)
        await connection.stop()
    }

    @Test func anAnswerFromTheWrongMacNeverConnects() async throws {
        // The phone pinned a different key than the Mac holds: message 1 cannot be read there.
        let connection = makeConnection(macKey: Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation)
        await connection.start()
        await #expect(throws: ChannelError.timedOut) { _ = try await connection.connected(timeout: .milliseconds(300)) }
        #expect(relay.socketCount >= 2, "it should keep retrying with backoff")
        await connection.stop()
    }

    @Test func thePushTokenReachesTheRelayAfterEveryReady() async throws {
        let connection = makeConnection()
        await connection.setPushRegistration(PushRegistration(deviceToken: Data([0xAB, 0x01]), environment: "sandbox"))
        await connection.start()
        _ = try await connection.connected(timeout: .seconds(5))
        #expect(await eventually { relay.pushTokens == ["sandbox:ab01"] })
        relay.dropAll(code: 1006)
        #expect(await eventually { relay.pushTokens == ["sandbox:ab01", "sandbox:ab01"] })
        await connection.stop()
    }

    @Test func theHeartbeatPings() async throws {
        let connection = makeConnection(heartbeat: .milliseconds(20))
        await connection.start()
        _ = try await connection.connected(timeout: .seconds(5))
        #expect(await eventually { relay.pings >= 2 })
        await connection.stop()
    }
}

@Suite("Pairing over the relay (§4.1)")
struct PairingFlowTests {
    let relay = FakeRelay()
    let phone = DeviceIdentity.generate()
    let device = PairingDevice(name: "Test iPhone", model: "iPhone18,1")
    let secret = Data((0..<32).map { _ in UInt8.random(in: 0...255) })

    func link(windowId: String, secret: Data? = nil, expiresIn: TimeInterval = 300) throws -> PairingLink {
        let expiresAt = Int64((Date().timeIntervalSince1970 + expiresIn) * 1000)
        return try PairingLink.decode(PairingLink.url(
            relay: relay.relayURL.absoluteString, macId: relay.macId, macKey: relay.macDH.publicKey.rawRepresentation,
            secret: secret ?? self.secret, windowId: windowId, macName: "Link's name for the Mac", expiresAt: expiresAt))
    }

    final class Progress: @unchecked Sendable {
        private let lock = NSLock()
        private var seen: [PairingProgress] = []
        func add(_ progress: PairingProgress) { lock.withLock { seen.append(progress) } }
        var all: [PairingProgress] { lock.withLock { seen } }
    }

    @Test func pairsWhenTheOwnerSaysYes() async throws {
        let windowId = relay.openWindow(secret: secret, answer: .yes)
        let progress = Progress()
        let mac = try await Pairing.run(link: try link(windowId: windowId), identity: phone, device: device, factory: relay,
                                        progress: { progress.add($0) })
        #expect(mac.macId == relay.macId)
        #expect(mac.macName == "Fake Mac")
        #expect(mac.macKey == relay.macDH.publicKey.rawRepresentation)
        #expect(mac.phoneId == phone.id)
        #expect(mac.windowId == windowId)
        #expect(progress.all == [.connecting, .confirmOnMac(macName: "Fake Mac")])
        #expect(relay.paired == [FakeRelay.Paired(name: "Test iPhone", model: "iPhone18,1", phoneId: phone.id,
                                                  sign: phone.signPublicKey, dh: phone.dhPublicKey)])
        // And the phone can now connect as itself.
        let connection = MobileConnection(mac: mac, identity: phone, client: ChannelTests.client, factory: relay)
        await connection.start()
        _ = try await connection.connected(timeout: .seconds(5))
        await connection.stop()
    }

    @Test func aDeclineIsReported() async throws {
        let windowId = relay.openWindow(secret: secret, answer: .declined)
        await #expect(throws: PairingError.declined) {
            _ = try await Pairing.run(link: try link(windowId: windowId), identity: phone, device: device, factory: relay)
        }
    }

    @Test func theWrongSecretIsNeverAnswered() async throws {
        let windowId = relay.openWindow(secret: secret, answer: .yes)
        await #expect(throws: PairingError.notAnswered) {
            _ = try await Pairing.run(link: try link(windowId: windowId, secret: Data(repeating: 0, count: 32)), identity: phone,
                                      device: device, factory: relay)
        }
        #expect(relay.paired.isEmpty)
    }

    @Test func aClosedWindowIsRefusedByTheRelay() async throws {
        await #expect(throws: PairingError.windowClosed) {
            _ = try await Pairing.run(link: try link(windowId: Base64URL.encode(Data(count: 16))), identity: phone, device: device,
                                      factory: relay)
        }
    }

    @Test func anExpiredLinkNeverDials() async throws {
        let windowId = relay.openWindow(secret: secret, answer: .yes)
        await #expect(throws: PairingError.linkExpired) {
            _ = try await Pairing.run(link: try link(windowId: windowId, expiresIn: -1), identity: phone, device: device, factory: relay)
        }
        #expect(relay.socketCount == 0)
    }
}
