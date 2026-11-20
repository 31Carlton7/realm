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
        #expect(model.pairing == .failed(
            "Realm couldn't read this iPhone's pairing from the keychain. Install the latest Realm from TestFlight, then open it again.",
            detail: "Keychain status -34018"))
        expectPlainWords(model.pairing)
        #expect(model.store.pairedMac == nil)
    }

    @Test func keysThatCannotBeReadSaySo() {
        let model = AppModel(vault: Vault(store: RefusingStore()))
        #expect(!model.restoreIdentity())
        #expect(model.pairing == .failed(
            "Realm couldn't read this iPhone's keys from the keychain. Install the latest Realm from TestFlight, then open it again.",
            detail: "Keychain status -34018"))
        expectPlainWords(model.pairing)
    }

    private func expectPlainWords(_ pairing: PairingStatus) {
        guard case .failed(let message, let detail) = pairing else {
            Issue.record("pairing is \(pairing), not failed")
            return
        }
        for text in [message, detail ?? ""] {
            #expect(!text.contains("KeychainError error"))
            #expect(!text.contains("couldn't be completed"))
            #expect(!text.contains("\u{2014}"))
        }
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
