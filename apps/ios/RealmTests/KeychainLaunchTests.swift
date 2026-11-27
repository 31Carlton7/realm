import Foundation
import RealmKit
import Security
import Testing
@testable import Realm

@MainActor
@Suite("Reading the paired Mac at launch")
struct KeychainLaunchTests {
    struct RefusingStore: SecureStore {
        var status = errSecMissingEntitlement
        func read(_ account: String) throws -> Data? { throw KeychainError(status: status) }
        func write(_ data: Data, for account: String) throws {}
        func delete(_ account: String) throws {}
    }

    @Test func aKeychainThatCannotBeReadSaysSo() {
        let model = AppModel(vault: Vault(store: RefusingStore()))
        #expect(!model.restorePairedMac())
        #expect(model.pairing == .failed(
            "This copy of Realm wasn't signed to open its keychain. Install Realm from TestFlight."))
        #expect(model.store.pairedMac == nil)
    }

    @Test func keysThatCannotBeReadSaySo() {
        let model = AppModel(vault: Vault(store: RefusingStore()))
        #expect(!model.restoreIdentity())
        #expect(model.pairing == .failed(
            "This copy of Realm wasn't signed to open its keychain. Install Realm from TestFlight."))
    }

    @Test func anotherRefusalSaysTheKeychainCouldNotBeRead() {
        let model = AppModel(vault: Vault(store: RefusingStore(status: errSecInteractionNotAllowed)))
        #expect(!model.restorePairedMac())
        #expect(model.pairing == .failed("Realm couldn't read this iPhone's keychain. Close Realm and open it again."))
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
