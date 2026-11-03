import Foundation
import Observation
import RealmKit
import UniformTypeIdentifiers

/// One share as it is made: each file copied into the inbox the moment the other app hands it over, a
/// link or a passage of text kept as words, and what the person types under it.
@MainActor
@Observable
final class ShareDraft {
    let id = UUID()
    private(set) var files: [SharedFile] = []
    /// Links and text the other app shared, one to a line.
    private(set) var shared: [String] = []
    var note = ""
    private(set) var loading = 0
    var problem: String?
    @ObservationIgnored private let inbox: ShareInbox?

    init(inbox: ShareInbox?) {
        self.inbox = inbox
    }

    var isEmpty: Bool { files.isEmpty && shared.isEmpty && note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// The words the session is given: what the person typed, then what was shared.
    var text: String {
        ([note.trimmingCharacters(in: .whitespacesAndNewlines)] + shared).filter { !$0.isEmpty }.joined(separator: "\n")
    }

    func load(_ providers: [NSItemProvider]) {
        for provider in providers {
            let types = provider.registeredContentTypes
            if let type = types.first(where: Self.isFile) {
                loadFile(provider, type: type)
            } else if types.contains(where: { $0.conforms(to: .url) }) {
                loading += 1
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    Task { @MainActor in
                        if let url { self.shared.append(url.isFileURL ? url.lastPathComponent : url.absoluteString) }
                        self.loading -= 1
                    }
                }
            } else if types.contains(where: { $0.conforms(to: .plainText) }) {
                loading += 1
                _ = provider.loadObject(ofClass: String.self) { text, _ in
                    Task { @MainActor in
                        if let text { self.shared.append(text) }
                        self.loading -= 1
                    }
                }
            }
        }
    }

    /// A photo, a film, a document: anything with bytes of its own, but not text or a link, which go as
    /// words.
    private static func isFile(_ type: UTType) -> Bool {
        type.conforms(to: .data) && !type.conforms(to: .text) && !type.conforms(to: .url)
    }

    /// The file is only there while the handler runs, so it is copied into the inbox from inside it,
    /// file to file, before anything is said back to the main actor.
    private func loadFile(_ provider: NSItemProvider, type: UTType) {
        guard let inbox else { return }
        loading += 1
        let id = id
        let suggested = provider.suggestedName
        _ = provider.loadFileRepresentation(for: type, openInPlace: false) { url, _, error in
            let copied = url.flatMap { url in
                try? inbox.copy(url, named: SharedFile.name(suggested: suggested, file: url, typeExtension: type.preferredFilenameExtension), into: id)
            }
            Task { @MainActor in
                if let copied {
                    self.files.append(copied)
                } else {
                    self.problem = "Something you shared could not be read." + (error.map { " \($0.localizedDescription)" } ?? "")
                }
                self.loading -= 1
            }
        }
    }

    func commit(to target: ShareTarget) throws {
        guard let inbox else { throw CocoaError(.fileNoSuchFile) }
        try inbox.commit(SharedItem(id: id, target: target, text: text, files: files, sharedAt: Date()))
    }

    func discard() {
        inbox?.remove(id)
    }
}
