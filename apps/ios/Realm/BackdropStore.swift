import CryptoKit
import Foundation
import RealmKit
import UIKit

/// The look behind each session the phone has open, and the stills it is drawn from. The look is asked
/// of the Mac each time a session opens, so a choice changed on the Mac shows on the next open. A
/// still is kept on disk by its look and face, so after the first time an open costs only the look. A
/// Mac from before backgrounds answers METHOD_NOT_FOUND, and every session then keeps its plain ground.
@MainActor
@Observable
final class BackdropStore {
    /// What the phone asks the Mac: the look for a session, and a still by its key.
    struct Source {
        let look: (String) async throws -> BackgroundLook?
        let still: (String) async throws -> Data
    }

    /// Each open session's look; nil when pictures are off.
    private var looks: [String: BackgroundLook?] = [:]
    /// The stills read so far, by their file's name.
    private var stills: [String: UIImage] = [:]
    /// The Mac has no backgrounds call.
    private(set) var macHasNone = false
    @ObservationIgnored private let folder: URL

    init(folder: URL = URL.cachesDirectory.appending(path: "Backdrops", directoryHint: .isDirectory)) {
        self.folder = folder
    }

    /// The look and still to draw behind a session on the `dark` face, once both are here.
    func shown(_ sessionId: String, dark: Bool) -> (look: BackgroundLook, still: UIImage)? {
        guard let look = looks[sessionId] ?? nil, let still = stills[Self.fileName(look: look.id, face: dark ? look.faces.dark : look.faces.light)] else { return nil }
        return (look, still)
    }

    /// The session's look, asked again when `refresh` (a new open) or not known yet, then the `dark`
    /// face's still: from memory, from disk, or, unless `lowData`, from the Mac.
    func load(_ sessionId: String, dark: Bool, refresh: Bool, lowData: Bool, from source: Source) async {
        guard !macHasNone else { return }
        if refresh || looks[sessionId] == nil {
            do {
                looks[sessionId] = .some(try await source.look(sessionId))
            } catch ChannelError.rpc(let refusal) where refusal.code == "METHOD_NOT_FOUND" {
                macHasNone = true
                looks = [:]
                return
            } catch {
                return
            }
        }
        guard let look = looks[sessionId] ?? nil else { return }
        let key = dark ? look.faces.dark : look.faces.light
        let name = Self.fileName(look: look.id, face: key)
        if stills[name] != nil { return }
        let file = folder.appending(path: name)
        if let kept = try? Data(contentsOf: file), let image = UIImage(data: kept) {
            stills[name] = image
            return
        }
        guard BackdropPolicy.mayFetch(lowData: lowData), let data = try? await source.still(key), let image = UIImage(data: data) else { return }
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try? data.write(to: file, options: .atomic)
        stills[name] = image
    }

    /// A still's file: its look and its face's key, hashed, so a picture's name is never a file name.
    static func fileName(look: String, face: String) -> String {
        SHA256.hash(data: Data("\(look)\u{0}\(face)".utf8)).map { String(format: "%02x", $0) }.joined() + ".jpg"
    }
}
