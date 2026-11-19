@testable import RealmKit
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
}
