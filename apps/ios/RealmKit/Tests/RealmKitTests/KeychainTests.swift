@testable import RealmKit
import Security
import Testing

@Suite("The shared keychain group")
struct KeychainTests {
    @Test func aGroupWithTheTeamPrefixIsKept() {
        #expect(KeychainStore.sharedAccessGroup("FY9QB79VAP.co.charmtechnologies.realm.ios.shared")
            == "FY9QB79VAP.co.charmtechnologies.realm.ios.shared")
    }

    /// A build signed by hand from an unsigned one resolves `$(AppIdentifierPrefix)` to nothing.
    @Test func aGroupWithoutTheTeamPrefixIsRefused() {
        #expect(KeychainStore.sharedAccessGroup("co.charmtechnologies.realm.ios.shared") == nil)
    }

    @Test func anUnresolvedGroupIsRefused() {
        #expect(KeychainStore.sharedAccessGroup("$(AppIdentifierPrefix)co.charmtechnologies.realm.ios.shared") == nil)
        #expect(KeychainStore.sharedAccessGroup("") == nil)
        #expect(KeychainStore.sharedAccessGroup(nil) == nil)
    }

    @Test func aMissingEntitlementSaysToInstallFromTestFlight() {
        let error = KeychainError(status: errSecMissingEntitlement)
        #expect(error.localizedDescription
            == "This copy of Realm wasn't signed to open its keychain. Install Realm from TestFlight.")
        expectPlainWords(error.localizedDescription)
    }

    @Test func anyOtherStatusSaysTheKeychainCouldNotBeRead() {
        for status in [errSecInteractionNotAllowed, errSecDecode, errSecNotAvailable] {
            let error = KeychainError(status: status)
            #expect(error.localizedDescription == "Realm couldn't read this iPhone's keychain. Close Realm and open it again.")
            expectPlainWords(error.localizedDescription)
        }
    }

    private func expectPlainWords(_ text: String) {
        let hasNumber = text.contains { $0.isNumber }
        #expect(!hasNumber, "a status number is on the card: \(text)")
        #expect(!text.contains("KeychainError"))
        #expect(!text.contains("be completed"))
        #expect(!text.contains("\u{2014}"))
    }
}
