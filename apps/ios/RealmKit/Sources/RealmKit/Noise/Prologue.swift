import Foundation

/// The prologues of PROTOCOL.md §4. Each binds the protocol version and both ends' ids, so a
/// handshake or a push made for one pair cannot be replayed into another.
public enum Prologue {
    /// `utf8("realm-pair/1") || 0x00 || utf8(macId) || 0x00 || utf8(windowId)`
    public static func pair(macId: String, windowId: String) -> Data {
        joined("realm-pair/1", macId, windowId)
    }

    /// `utf8("realm-mobile/1") || 0x00 || utf8(macId) || 0x00 || utf8(phoneId)`
    public static func ik(macId: String, phoneId: String) -> Data {
        joined("realm-mobile/1", macId, phoneId)
    }

    /// `utf8("realm-push/1") || 0x00 || utf8(macId) || 0x00 || utf8(phoneId)`
    public static func push(macId: String, phoneId: String) -> Data {
        joined("realm-push/1", macId, phoneId)
    }

    private static func joined(_ label: String, _ first: String, _ second: String) -> Data {
        Data(label.utf8) + Data([0x00]) + Data(first.utf8) + Data([0x00]) + Data(second.utf8)
    }
}
