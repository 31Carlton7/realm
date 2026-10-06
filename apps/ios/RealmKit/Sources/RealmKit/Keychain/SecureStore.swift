import Foundation
import Security
import Synchronization

/// Small secrets by name. The keychain on the phone; memory in tests.
public protocol SecureStore: Sendable {
    func read(_ account: String) throws -> Data?
    func write(_ data: Data, for account: String) throws
    func delete(_ account: String) throws
}

public struct KeychainError: Error, Equatable, Sendable {
    public let status: OSStatus
}

/// Generic-password items, readable after the first unlock and never leaving this device (no backup,
/// no iCloud Keychain), in the access group the app shares with its notification extension.
public struct KeychainStore: SecureStore {
    public static let service = "co.charmtechnologies.realm.ios"
    /// The Info.plist key holding `$(AppIdentifierPrefix)co.charmtechnologies.realm.ios.shared`.
    public static let accessGroupInfoKey = "RealmKeychainAccessGroup"

    public let service: String
    public let accessGroup: String?

    public init(service: String = KeychainStore.service, accessGroup: String? = KeychainStore.sharedAccessGroup()) {
        self.service = service
        self.accessGroup = accessGroup
    }

    /// The shared group as the build resolved it, or nil when the build did not.
    public static func sharedAccessGroup(bundle: Bundle = .main) -> String? {
        guard let group = bundle.object(forInfoDictionaryKey: accessGroupInfoKey) as? String,
              !group.isEmpty, !group.contains("$(") else { return nil }
        return group
    }

    public func read(_ account: String) throws -> Data? {
        let (status, data) = inSharedGroup { group -> (OSStatus, Data?) in
            var query = query(account, group: group)
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            var result: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            return (status, result as? Data)
        }
        switch status {
        case errSecSuccess: return data
        case errSecItemNotFound: return nil
        default: throw KeychainError(status: status)
        }
    }

    public func write(_ data: Data, for account: String) throws {
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let (status, _) = inSharedGroup { group -> (OSStatus, Void) in
            let query = query(account, group: group)
            var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
            if status == errSecItemNotFound {
                status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
            }
            return (status, ())
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func delete(_ account: String) throws {
        let (status, _) = inSharedGroup { group -> (OSStatus, Void) in
            (SecItemDelete(query(account, group: group) as CFDictionary), ())
        }
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }

    private func query(_ account: String, group: String?) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true,
        ]
        if let group { query[kSecAttrAccessGroup as String] = group }
        return query
    }

    /// Runs a keychain call in the shared group. A simulator build signed without the keychain
    /// entitlement is refused the group, so there, and only there, it falls back to the default group.
    private func inSharedGroup<T>(_ call: (String?) -> (OSStatus, T)) -> (OSStatus, T) {
        let result = call(accessGroup)
        #if targetEnvironment(simulator)
        if result.0 == errSecMissingEntitlement, accessGroup != nil { return call(nil) }
        #endif
        return result
    }
}

public final class InMemorySecureStore: SecureStore {
    private let items = Mutex<[String: Data]>([:])

    public init() {}

    public func read(_ account: String) throws -> Data? {
        items.withLock { $0[account] }
    }

    public func write(_ data: Data, for account: String) throws {
        items.withLock { $0[account] = data }
    }

    public func delete(_ account: String) throws {
        _ = items.withLock { $0.removeValue(forKey: account) }
    }
}
