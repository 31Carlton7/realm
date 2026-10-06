import Foundation

/// What the app and the notification extension keep in the shared keychain group: this phone's keys,
/// the Macs it is paired with, and the push ids it has already shown.
public struct Vault: Sendable {
    static let identityAccount = "device-identity"
    static let macsAccount = "paired-macs"
    static let seenPushesAccount = "seen-pushes"

    public let store: any SecureStore

    public init(store: any SecureStore) {
        self.store = store
    }

    public func identity() throws -> DeviceIdentity? {
        guard let data = try store.read(Self.identityAccount) else { return nil }
        return try JSONDecoder().decode(StoredIdentity.self, from: data).identity()
    }

    /// This phone's keys, made on first use.
    public func loadOrCreateIdentity() throws -> DeviceIdentity {
        if let identity = try identity() { return identity }
        let identity = DeviceIdentity.generate()
        try store.write(try JSONEncoder().encode(StoredIdentity(identity)), for: Self.identityAccount)
        return identity
    }

    public func pairedMacs() throws -> [PairedMac] {
        guard let data = try store.read(Self.macsAccount) else { return [] }
        return try JSONDecoder().decode([PairedMac].self, from: data)
    }

    public func pairedMac(id macId: String) throws -> PairedMac? {
        try pairedMacs().first { $0.macId == macId }
    }

    /// Records a pairing. Pairing with a Mac again replaces what was kept for it.
    public func save(_ mac: PairedMac) throws {
        var macs = try pairedMacs().filter { $0.macId != mac.macId }
        macs.append(mac)
        try store.write(try JSONEncoder().encode(macs), for: Self.macsAccount)
    }

    public func removeMac(id macId: String) throws {
        let macs = try pairedMacs().filter { $0.macId != macId }
        try store.write(try JSONEncoder().encode(macs), for: Self.macsAccount)
    }

    /// True the first time a push id is seen within a day, false for a repeat (§4.3).
    public func firstSighting(ofPush id: String, at now: Date = Date()) throws -> Bool {
        var seen: [String: Double] = [:]
        if let data = try store.read(Self.seenPushesAccount) {
            seen = (try? JSONDecoder().decode([String: Double].self, from: data)) ?? [:]
        }
        let cutoff = now.timeIntervalSince1970 - SealedPush.maxAge
        seen = seen.filter { $0.value >= cutoff }
        guard seen[id] == nil else { return false }
        seen[id] = now.timeIntervalSince1970
        try store.write(try JSONEncoder().encode(seen), for: Self.seenPushesAccount)
        return true
    }
}
