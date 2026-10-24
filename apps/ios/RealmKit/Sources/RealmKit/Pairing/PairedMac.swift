import Foundation

/// A Mac this phone has paired with: everything needed to reach it and to know it is that Mac.
public struct PairedMac: Codable, Sendable, Equatable, Identifiable {
    public let macId: String
    public var macName: String
    /// The relay's base URL: the pairing link's, until the Mac names another (PROTOCOL.md §3.3).
    public var relay: URL
    /// The Mac's X25519 public key, pinned at pairing.
    public let macKey: Data
    /// This phone's id at that Mac: `id(signPub)`.
    public let phoneId: String
    /// The pairing window this came from, so a relaunch with the same link does not pair twice.
    public let windowId: String
    public let pairedAt: Date

    public var id: String { macId }

    /// This pairing once it follows its Mac to the relay the Mac named in its handshake (§3.3); nil when
    /// the Mac named none, or the relay this pairing already dials.
    public func moved(to relay: URL?) -> PairedMac? {
        guard let relay, relay != self.relay else { return nil }
        var moved = self
        moved.relay = relay
        return moved
    }

    public init(macId: String, macName: String, relay: URL, macKey: Data, phoneId: String, windowId: String, pairedAt: Date) {
        self.macId = macId
        self.macName = macName
        self.relay = relay
        self.macKey = macKey
        self.phoneId = phoneId
        self.windowId = windowId
        self.pairedAt = pairedAt
    }
}
