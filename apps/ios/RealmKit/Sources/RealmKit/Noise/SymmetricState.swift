import CryptoKit
import Foundation

/// Noise rev 34 §5.2, with SHA256 (HASHLEN 32).
public struct SymmetricState: Sendable {
    public private(set) var chainingKey: Data
    public private(set) var handshakeHash: Data
    public private(set) var cipher = CipherState()

    public init(protocolName: String) {
        let name = Data(protocolName.utf8)
        let hash = name.count <= 32 ? name + Data(count: 32 - name.count) : Data(SHA256.hash(data: name))
        handshakeHash = hash
        chainingKey = hash
    }

    public var hasKey: Bool { cipher.hasKey }

    public mutating func mixKey(_ inputKeyMaterial: Data) {
        let (chainingKey, key) = Self.hkdf2(chainingKey: chainingKey, inputKeyMaterial: inputKeyMaterial)
        self.chainingKey = chainingKey
        cipher = CipherState(key: key)
    }

    public mutating func mixHash(_ data: Data) {
        var hasher = SHA256()
        hasher.update(data: handshakeHash)
        hasher.update(data: data)
        handshakeHash = Data(hasher.finalize())
    }

    public mutating func mixKeyAndHash(_ inputKeyMaterial: Data) {
        let (chainingKey, tempHash, key) = Self.hkdf3(chainingKey: chainingKey, inputKeyMaterial: inputKeyMaterial)
        self.chainingKey = chainingKey
        mixHash(tempHash)
        cipher = CipherState(key: key)
    }

    public mutating func encryptAndHash(_ plaintext: Data) throws -> Data {
        let ciphertext = try cipher.encrypt(plaintext, ad: handshakeHash)
        mixHash(ciphertext)
        return ciphertext
    }

    public mutating func decryptAndHash(_ ciphertext: Data) throws -> Data {
        let plaintext = try cipher.decrypt(ciphertext, ad: handshakeHash)
        mixHash(ciphertext)
        return plaintext
    }

    public func split() -> (CipherState, CipherState) {
        let (first, second) = Self.hkdf2(chainingKey: chainingKey, inputKeyMaterial: Data())
        return (CipherState(key: first), CipherState(key: second))
    }

    // Noise's HKDF (§4.3): HMAC-SHA256 chained over the chaining key.

    static func hmac(key: Data, _ data: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key)))
    }

    static func hkdf2(chainingKey: Data, inputKeyMaterial: Data) -> (Data, Data) {
        let tempKey = hmac(key: chainingKey, inputKeyMaterial)
        let output1 = hmac(key: tempKey, Data([0x01]))
        let output2 = hmac(key: tempKey, output1 + Data([0x02]))
        return (output1, output2)
    }

    static func hkdf3(chainingKey: Data, inputKeyMaterial: Data) -> (Data, Data, Data) {
        let tempKey = hmac(key: chainingKey, inputKeyMaterial)
        let output1 = hmac(key: tempKey, Data([0x01]))
        let output2 = hmac(key: tempKey, output1 + Data([0x02]))
        let output3 = hmac(key: tempKey, output2 + Data([0x03]))
        return (output1, output2, output3)
    }
}
