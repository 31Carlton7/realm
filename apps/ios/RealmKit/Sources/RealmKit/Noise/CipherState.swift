import CryptoKit
import Foundation

public enum NoiseError: Error, Equatable, Sendable {
    /// The tag did not verify: wrong key, wrong nonce, wrong associated data, or altered bytes.
    case decryptFailed
    case nonceExhausted
    case messageTooShort
    case messageTooLong
    case missingKey(String)
    case invalidKey
    case unsupportedProtocol(String)
    case handshakeFinished
    case notThisSidesTurn
    case handshakeNotFinished
}

/// Noise rev 34 §5.1, with AESGCM: a 32-byte key and a 64-bit counter.
public struct CipherState: Sendable {
    public static let tagLength = 16

    private var key: SymmetricKey?
    public private(set) var nonce: UInt64 = 0

    public init() {}

    public init(key: Data) {
        self.key = SymmetricKey(data: key)
    }

    public var hasKey: Bool { key != nil }

    /// EncryptWithAd. Without a key the plaintext passes through, as Noise specifies.
    public mutating func encrypt(_ plaintext: Data, ad: Data = Data()) throws -> Data {
        guard let key else { return plaintext }
        guard nonce != .max else { throw NoiseError.nonceExhausted }
        let sealed = try AES.GCM.seal(plaintext, using: key, nonce: Self.gcmNonce(nonce), authenticating: ad)
        nonce += 1
        return sealed.ciphertext + sealed.tag
    }

    /// DecryptWithAd. A failed tag leaves the nonce where it was.
    public mutating func decrypt(_ ciphertext: Data, ad: Data = Data()) throws -> Data {
        guard let key else { return ciphertext }
        guard nonce != .max else { throw NoiseError.nonceExhausted }
        guard ciphertext.count >= Self.tagLength else { throw NoiseError.decryptFailed }
        let plaintext: Data
        do {
            let box = try AES.GCM.SealedBox(
                nonce: Self.gcmNonce(nonce),
                ciphertext: ciphertext.prefix(ciphertext.count - Self.tagLength),
                tag: ciphertext.suffix(Self.tagLength)
            )
            plaintext = try AES.GCM.open(box, using: key, authenticating: ad)
        } catch {
            throw NoiseError.decryptFailed
        }
        nonce += 1
        return plaintext
    }

    /// PROTOCOL.md §4: four zero bytes, then `n` as a big-endian 64-bit integer.
    static func gcmNonce(_ n: UInt64) -> AES.GCM.Nonce {
        var bytes = Data(count: 4)
        withUnsafeBytes(of: n.bigEndian) { bytes.append(contentsOf: $0) }
        // Twelve bytes is always a valid GCM nonce.
        return try! AES.GCM.Nonce(data: bytes)
    }
}
