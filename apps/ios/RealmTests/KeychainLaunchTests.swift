import Foundation
import RealmKit
import Security
import Testing
@testable import Realm

@MainActor
@Suite("Reading the paired Mac at launch")
struct KeychainLaunchTests {
    struct RefusingStore: SecureStore {
        func read(_ account: String) throws -> Data? { throw KeychainError(status: errSecMissingEntitlement) }
        func write(_ data: Data, for account: String) throws {}
        func delete(_ account: String) throws {}
    }

    @Test func aKeychainThatCannotBeReadSaysSo() {
        let model = AppModel(vault: Vault(store: RefusingStore()))
        #expect(!model.restorePairedMac())
        guard case .failed(let message) = model.pairing else {
            Issue.record("pairing is \(model.pairing), not failed")
            return
        }
        #expect(message.hasPrefix("The Mac this iPhone is paired with could not be read from the keychain."))
        #expect(model.store.pairedMac == nil)
    }

    @Test func aPhoneNeverPairedAsksToPair() {
        let model = AppModel(vault: Vault(store: InMemorySecureStore()))
        #expect(model.restorePairedMac())
        #expect(model.pairing == .idle)
        #expect(model.store.pairedMac == nil)
    }

    @Test func thePairedMacIsShown() throws {
        let vault = Vault(store: InMemorySecureStore())
        let mac = PairedMac(macId: "m", macName: "Carlton's MacBook", relay: URL(string: "wss://relay.example")!,
                            macKey: Data(count: 32), phoneId: "p", windowId: "w", pairedAt: Date())
        try vault.save(mac)
        let model = AppModel(vault: vault)
        #expect(model.restorePairedMac())
        #expect(model.store.pairedMac?.macId == "m")
    }
}
