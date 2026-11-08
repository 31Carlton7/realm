import QuickLook
import RealmKit
import RealmMarkdown
import SwiftUI

/// What a reader does with a text the Mac sent only the head of.
enum TextHead {
    /// The whole of a small file comes without asking, which is a few pieces on cellular at most.
    static let comesAlone = 256 * 1024
    /// Past the size the desktop's own pane opens, the head is all a phone is sent.
    static let largestOpened = 2 * 1024 * 1024

    enum Next: Equatable {
        case done, fetch, offer, onTheMac
    }

    static func next(truncated: Bool, size: Double) -> Next {
        guard truncated else { return .done }
        if Int(size) <= comesAlone { return .fetch }
        return Int(size) <= largestOpened ? .offer : .onTheMac
    }
}

/// A file open to read, read-only: markdown drawn by RealmMarkdown, anything else in monospace. A file
/// the Mac refuses says why in the Mac's words.
struct DocumentReader: View {
    let document: DocumentRef
    @Environment(AppModel.self) private var model
    @State private var preview: FilePreview?
    @State private var text: String?
    @State private var blocks: [MarkdownBlock] = []
    @State private var lines: [String] = []
    @State private var whole: URL?
    @State private var problem: String?
    @State private var refused = false
    @State private var fetching = false
    @State private var previewing: URL?

    var body: some View {
        Group {
            if let problem {
                ContentUnavailableView(document.name, systemImage: refused ? "lock" : document.symbol, description: Text(problem))
            } else if case .none(let reason)? = preview?.preview {
                ContentUnavailableView {
                    Label(document.name, systemImage: document.symbol)
                } description: {
                    Text(reason)
                } actions: {
                    Button("Open in Quick Look") { Task { await getWhole(thenPreview: true) } }
                        .buttonStyle(.bordered)
                        .disabled(fetching)
                }
            } else if text != nil {
                reading
            } else {
                Unreached(what: "This file", working: model.isConnected)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Ground.transcript)
        .softEdges(ground: Ground.transcript)
        .navigationTitle(document.name)
        .navigationSubtitle(preview.map { Int64($0.size).formatted(.byteCount(style: .file)) } ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let whole {
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: whole) { Label("Share", systemImage: "square.and.arrow.up") }
                }
            }
        }
        .quickLookPreview($previewing)
        .task(id: model.channelGeneration) { await load() }
    }

    @ViewBuilder
    private var reading: some View {
        if document.opening == .markdown {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    MarkdownView(blocks: blocks, lazily: true)
                    cutNote
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
        } else {
            ScrollView([.horizontal, .vertical]) {
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(lines.indices, id: \.self) { index in
                        Text(lines[index].isEmpty ? " " : lines[index])
                            .mono(.caption)
                            .foregroundStyle(Palette.ink)
                            .lineLimit(1)
                            .fixedSize(horizontal: true, vertical: false)
                    }
                    cutNote
                        .padding(.top, 12)
                }
                .textSelection(.enabled)
                .padding(16)
            }
            .defaultScrollAnchor(.topLeading)
        }
    }

    /// Only the head came: how much that is, and the rest where a phone may ask for it.
    @ViewBuilder
    private var cutNote: some View {
        if let preview, case .text(_, true) = preview.preview, whole == nil {
            let size = Int64(preview.size).formatted(.byteCount(style: .file))
            VStack(alignment: .leading, spacing: 8) {
                Text("This is the start of a \(size) file.")
                    .font(.footnote)
                    .foregroundStyle(Palette.ink2)
                if TextHead.next(truncated: true, size: preview.size) == .offer {
                    Button("Get the rest") { Task { await getWhole(thenPreview: false) } }
                        .buttonStyle(.bordered)
                        .disabled(fetching)
                } else {
                    Text("The rest is on your Mac.")
                        .font(.footnote)
                        .foregroundStyle(Palette.ink2)
                }
            }
        }
    }

    private func load() async {
        do {
            let answer = try await model.preview(document.path, in: document.source)
            preview = answer
            problem = nil
            if case .text(let words, let truncated) = answer.preview {
                await show(words)
                if TextHead.next(truncated: truncated, size: answer.size) == .fetch { await getWhole(thenPreview: false) }
            }
        } catch is CancellationError {
        } catch ChannelError.rpc(let refusal) where refusal.code == "METHOD_NOT_FOUND" {
            problem = "Update Realm on your Mac to open this file here."
        } catch ChannelError.rpc(let refusal) {
            refused = refusal.code == "FORBIDDEN"
            problem = refusal.message
        } catch ChannelError.notConnected {
            // Asked again once the Mac is there.
        } catch {
            problem = AppModel.describe(error)
        }
    }

    /// Words made ready away from the main thread: a long document takes a moment to parse or split.
    private func show(_ words: String) async {
        if document.opening == .markdown {
            blocks = await Task.detached(priority: .userInitiated) { MarkdownBlocks.parse(words) }.value
        } else {
            lines = await Task.detached(priority: .userInitiated) { words.components(separatedBy: .newlines) }.value
        }
        text = words
    }

    private func getWhole(thenPreview: Bool) async {
        fetching = true
        defer { fetching = false }
        do {
            let url = try await model.wholeFile(document.path, name: document.name, in: document.source) { _ in }
            whole = url
            if thenPreview {
                previewing = url
            } else if let data = try? Data(contentsOf: url), let words = String(data: data, encoding: .utf8) {
                await show(words)
            }
        } catch is CancellationError {
        } catch {
            model.show(toast: AppModel.describe(error))
        }
    }
}
