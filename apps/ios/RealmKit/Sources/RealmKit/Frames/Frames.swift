import Foundation

public enum FrameError: Error, Equatable, Sendable {
    case frameTooLarge(Int)
    case emptyFrame
    case unknownFlag(UInt8)
    case messageTooLarge
}

/// PROTOCOL.md §5: one transport message per binary data message, each plaintext opening with a flag
/// byte (`0x00` ends the application message, `0x01` means more follow).
public enum Frames {
    public static let maxCiphertext = 65_535
    public static let maxFragment = maxCiphertext - CipherState.tagLength - 1  // 65,518
    /// The most this phone will join into one message before giving up on the channel (as the Mac's).
    public static let maxMessage = 16 * 1024 * 1024

    static let finalFlag: UInt8 = 0x00
    static let moreFlag: UInt8 = 0x01

    /// Splits `message` into fragments and encrypts each in order with `cipher`.
    public static func seal(_ message: Data, with cipher: inout CipherState) throws -> [Data] {
        var frames: [Data] = []
        var offset = message.startIndex
        repeat {
            let end = message.index(offset, offsetBy: maxFragment, limitedBy: message.endIndex) ?? message.endIndex
            let isLast = end == message.endIndex
            var plaintext = Data(capacity: end - offset + 1)
            plaintext.append(isLast ? finalFlag : moreFlag)
            plaintext.append(message[offset..<end])
            frames.append(try cipher.encrypt(plaintext))
            offset = end
        } while offset < message.endIndex
        return frames
    }

    /// Joins fragments back into application messages.
    public struct Assembler: Sendable {
        private var pending = Data()

        public init() {}

        /// Decrypts one frame. Returns the whole message when this frame ends one, else nil.
        public mutating func open(_ frame: Data, with cipher: inout CipherState) throws -> Data? {
            guard frame.count <= Frames.maxCiphertext else { throw FrameError.frameTooLarge(frame.count) }
            let plaintext = try cipher.decrypt(frame)
            guard let flag = plaintext.first else { throw FrameError.emptyFrame }
            let fragment = plaintext.dropFirst()
            guard pending.count + fragment.count <= Frames.maxMessage else { throw FrameError.messageTooLarge }
            switch flag {
            case Frames.finalFlag:
                let message = pending + fragment
                pending = Data()
                return message
            case Frames.moreFlag:
                pending.append(fragment)
                return nil
            default:
                throw FrameError.unknownFlag(flag)
            }
        }
    }
}
