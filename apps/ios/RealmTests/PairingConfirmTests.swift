import Foundation
import RealmKit
import Testing
@testable import Realm

@MainActor
@Suite("What a pairing link asks before it pairs")
struct PairingConfirmTests {
    static let macId = Base64URL.encode(Data(repeating: 1, count: 16))

    /// A link that has already expired: once it reaches `pair(with:)`, parsing fails before
    /// `Pairing.run`, so a test sees pairing begin without any network.
    static func link(macId: String = macId, name: String = "Stranger's Mac") -> String {
        PairingLink.url(relay: "wss://relay.stranger.example", macId: macId, macKey: Data(repeating: 2, count: 32),
                        secret: Data(repeating: 3, count: 32), windowId: Base64URL.encode(Data(repeating: 4, count: 16)),
                        macName: name, expiresAt: 1)
    }

    static func model() -> AppModel {
        let model = AppModel()
        model.identity = .generate()
        return model
    }

    /// Lets the pairing task `open` started run up to its first answer.
    static func settle(_ model: AppModel) async {
        for _ in 0..<50 where model.pairing == .idle { await Task.yield() }
    }

    @Test func aLinkWithNoPairingAsksFirst() async throws {
        let model = Self.model()
        model.open(url: try #require(URL(string: Self.link())))
        #expect(model.confirmingPairLink == Self.link())
        await Self.settle(model)
        #expect(model.pairing == .idle)

        model.confirmPairing()
        await Self.settle(model)
        #expect(model.confirmingPairLink == nil)
        #expect(model.pairing != .idle)
    }

    @Test func theScannerPairsWithoutAsking() async {
        let model = Self.model()
        model.open(pairingText: Self.link(), fromScanner: true)
        #expect(model.confirmingPairLink == nil)
        await Self.settle(model)
        #expect(model.pairing != .idle)
    }

    @Test func theScannerStillAsksBeforeReplacingAMac() async {
        let model = Self.model()
        model.store.pairedMac = PairedMac(macId: "other", macName: "Carlton's MacBook", relay: URL(string: "wss://relay.example")!,
                                          macKey: Data(count: 32), phoneId: "p", windowId: "w", pairedAt: Date())
        model.open(pairingText: Self.link(), fromScanner: true)
        #expect(model.confirmingPairLink == Self.link())
        await Self.settle(model)
        #expect(model.pairing == .idle)
    }

    @Test func theConfirmNamesTheMacAndItsRelay() throws {
        let link = try PairingLink.decode(Self.link())
        let first = PairConfirmation(link, replacing: nil)
        #expect(first.title == "Pair with “Stranger's Mac”?")
        #expect(first.message.contains("relay.stranger.example"))
        #expect(!first.message.contains("stop showing"))
        let replacing = PairConfirmation(link, replacing: "Carlton's MacBook")
        #expect(replacing.message.contains("stop showing Carlton's MacBook's sessions"))
        #expect(replacing.message.contains("relay.stranger.example"))
    }
}
