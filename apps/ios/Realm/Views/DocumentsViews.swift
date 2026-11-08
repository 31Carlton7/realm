import RealmKit
import SwiftUI

/// How a file opens on the phone: as words to read, as code, or in the gallery. Decided the way the
/// desktop's pane decides, by `documentKindFor`; a kind it has no editor for goes by its mime type.
enum FileOpening: Equatable {
    case markdown, code, gallery

    init(kind: String, mime: String) {
        switch kind {
        case "doc", "slides": self = .markdown
        case "code", "sheet", "latex", "html": self = .code
        case "pdf", "preview", "video": self = .gallery
        default: self = mime.hasPrefix("image/") || mime.hasPrefix("video/") || mime.hasPrefix("audio/") ? .gallery : .code
        }
    }
}

/// A file a list can open.
protocol OpenableFile {
    var path: String { get }
    var name: String { get }
    var kind: String { get }
    var mime: String { get }
}

extension DocumentRow: OpenableFile {}
extension LibraryFile: OpenableFile {}

extension OpenableFile {
    var opening: FileOpening { FileOpening(kind: kind, mime: mime) }

    /// The glyph of a row: the desktop's kinds, where a name alone would not say.
    var symbol: String {
        switch kind {
        case "folder": "folder"
        case "code", "html", "latex": "chevron.left.forwardslash.chevron.right"
        case "sheet": "tablecells"
        default: FileKind.symbol(name)
        }
    }
}

/// A file open to read, as a route names it.
struct DocumentRef: Hashable {
    let source: FileSource
    let path: String
    let name: String
    let opening: FileOpening
    let symbol: String

    init(source: FileSource, file: any OpenableFile) {
        self.source = source
        path = file.path
        name = file.name
        opening = file.opening
        symbol = file.symbol
    }
}

/// The gallery up over a list, on the file tapped: beside it, the list's other files the gallery shows,
/// as the desktop's viewer walks the list it was opened from.
struct GalleryShown: Identifiable {
    let source: FileSource
    let pages: GalleryPages
    let page: Int

    var id: Int { page }

    init(source: FileSource, file: any OpenableFile, among list: [any OpenableFile]) {
        let shown = list.filter { $0.opening == .gallery }.map { SentFile(path: $0.path, name: $0.name, mime: $0.mime) }
        self.source = source
        pages = GalleryPages(shown)
        page = pages.page(of: SentFile(path: file.path, name: file.name, mime: file.mime))
    }
}

/// A row's press: pushes a text to read, or raises the gallery.
@MainActor
func openFile(_ file: any OpenableFile, among list: [any OpenableFile], from source: FileSource, model: AppModel, gallery: inout GalleryShown?) {
    if file.opening == .gallery {
        gallery = GalleryShown(source: source, file: file, among: list)
    } else {
        model.path.append(.document(DocumentRef(source: source, file: file)))
    }
}

/// A level of a space's folder as its page holds it: pages of `documents.list` in the Mac's order,
/// folders first and then files, each by name.
struct FolderPages: Equatable {
    private(set) var rows: [DocumentRow] = []
    private(set) var folder: String?
    private(set) var next: Int?
    private(set) var loaded = false

    mutating func start(_ page: DocumentListing) {
        rows = page.entries
        folder = page.folder
        next = page.next
        loaded = true
    }

    /// A file that moved since the last page may come again, and is not listed twice.
    mutating func append(_ page: DocumentListing) {
        let paths = Set(rows.map(\.path))
        rows += page.entries.filter { !paths.contains($0.path) }
        next = page.next
    }
}

/// A row of a list of files: its kind's glyph, its name, what its list knows of it, and how big or how
/// old. A folder has a chevron, because a press goes further in; a file opens.
struct FileLine: View {
    let symbol: String
    let name: String
    var about: String?
    var detail: String?
    var goesIn = false
    /// The first under a section head: clear of the fade that hangs from a pinned head.
    var leadsSection = false

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.body)
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(Palette.ink2)
                .glyphColumn(26, relativeTo: .body)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(name)
                    .font(.body)
                    .foregroundStyle(Palette.ink)
                    .lineLimit(2)
                    .truncationMode(.middle)
                if let about {
                    Text(about)
                        .font(.footnote)
                        .foregroundStyle(Palette.ink2)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            Spacer(minLength: 8)
            if let detail {
                Text(detail)
                    .font(.footnote)
                    .monospacedDigit()
                    .foregroundStyle(Palette.ink3)
                    .fixedSize()
            }
            if goesIn {
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Palette.ink3)
                    .accessibilityHidden(true)
            }
        }
        .padding(.vertical, 3)
        .padding(.top, leadsSection ? SectionHead<EmptyView>.fadeRoom : 0)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

extension SectionHead {
    /// How far a section's first row sits down, where a line of its text would otherwise rest in the
    /// fade under the head.
    static var fadeRoom: CGFloat { 14 }
}

extension View {
    /// A row of a calm list: no ground of its own and no line under it.
    func fileRow() -> some View {
        buttonStyle(.plain)
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
    }
}

/// One level of a space's folder, as the desktop's picker lists it, a page at a time as the end comes
/// into view. The folder itself opens on the files the space's sessions touched most recently, as the
/// desktop's Documents home does; a search looks through the whole folder from any level.
struct FolderView: View {
    let spaceId: String
    let dir: String
    @Environment(AppModel.self) private var model
    @State private var pages = FolderPages()
    @State private var recent: [LibraryFile] = []
    @State private var query = ""
    @State private var found: DocumentSearch?
    @State private var problem: String?
    @State private var loading = false
    @State private var gallery: GalleryShown?

    /// As many recent files as leave the folder on the first screen.
    private static let recentShown = 5

    var body: some View {
        let words = query.trimmingCharacters(in: .whitespacesAndNewlines)
        List {
            if words.isEmpty {
                if !recent.isEmpty {
                    Section {
                        ForEach(recent) { file in
                            Button {
                                openFile(file, among: recent, from: .library, model: model, gallery: &gallery)
                            } label: {
                                FileLine(symbol: file.symbol, name: file.name, about: file.sessionTitle, detail: Ago.text(file.at, now: .now),
                                         leadsSection: file.id == recent.first?.id)
                            }
                            .fileRow()
                        }
                    } header: {
                        SectionHead(title: "Recent") {
                            Image(systemName: "clock").foregroundStyle(Palette.ink2)
                        }
                    }
                }
                Section {
                    ForEach(pages.rows) { row in
                        rowButton(row, among: pages.rows, leadsSection: !recent.isEmpty && row.id == pages.rows.first?.id)
                    }
                    if pages.next != nil {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                            .task(id: pages.rows.count) { await load(next: true) }
                    }
                } header: {
                    if !recent.isEmpty, let folder = pages.folder {
                        SectionHead(title: folder) {
                            Image(systemName: "folder").foregroundStyle(Palette.ink2)
                        }
                    }
                }
            } else if let found {
                if let withheld = found.withheld {
                    Button {
                        model.path.append(.document(DocumentRef(source: .space(spaceId), file: withheld)))
                    } label: {
                        FileLine(symbol: "lock", name: withheld.name, about: "Holds a secret, so it stays on your Mac")
                    }
                    .fileRow()
                    .accessibilityIdentifier("withheld-file")
                }
                ForEach(found.entries) { row in rowButton(row, among: found.entries, showsFolder: true) }
            }
        }
        .listStyle(.plain)
        .listSectionSpacing(HomeView.sectionSpacing)
        .scrollContentBackground(.hidden)
        .background(Ground.transcript)
        .softEdges(ground: Ground.transcript)
        .overlay {
            if let problem, !pages.loaded {
                ContentUnavailableView("Documents", systemImage: "folder", description: Text(problem))
            } else if !words.isEmpty {
                if let found, found.entries.isEmpty, found.withheld == nil {
                    NoResults(query: words, why: "This searches the files in \(pages.folder ?? "this folder").")
                }
            } else if !pages.loaded {
                Unreached(what: "This folder", working: model.isConnected)
            } else if pages.rows.isEmpty, recent.isEmpty {
                ContentUnavailableView("Nothing here", systemImage: "folder",
                                       description: Text("Files you and your agents make in this folder show here."))
            }
        }
        .navigationTitle(dir.isEmpty ? "Documents" : (dir as NSString).lastPathComponent)
        .navigationSubtitle(dir.isEmpty ? (pages.folder ?? "") : dir)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaBar(edge: .bottom) {
            SearchBar(prompt: "Search \(pages.folder ?? "this folder")", query: $query) { query = "" }
        }
        .fullScreenCover(item: $gallery) { shown in
            AttachmentGallery(pages: shown.pages, source: shown.source, page: shown.page)
        }
        .task(id: model.channelGeneration) { await load(next: false) }
        .task(id: words) { await search(words) }
        .refreshable { await load(next: false) }
    }

    private func rowButton(_ row: DocumentRow, among list: [DocumentRow], showsFolder: Bool = false, leadsSection: Bool = false) -> some View {
        let folder = (row.path as NSString).deletingLastPathComponent
        return Button {
            if row.isDir {
                model.path.append(.documents(spaceId: spaceId, dir: row.path))
            } else {
                openFile(row, among: list, from: .space(spaceId), model: model, gallery: &gallery)
            }
        } label: {
            FileLine(symbol: row.symbol, name: row.name, about: showsFolder && !folder.isEmpty ? folder : nil,
                     detail: row.isDir ? nil : Int64(row.size).formatted(.byteCount(style: .file)), goesIn: row.isDir, leadsSection: leadsSection)
        }
        .fileRow()
        .accessibilityIdentifier("document-\(row.path)")
    }

    /// The first page and the recent files again, or the next page after what is here.
    private func load(next: Bool) async {
        guard !loading, let api = model.api, model.isConnected else { return }
        loading = true
        defer { loading = false }
        do {
            let page = try await api.documents(spaceId: spaceId, dir: dir, offset: next ? pages.next ?? 0 : 0)
            if next { pages.append(page) } else { pages.start(page) }
            problem = nil
            if !next, dir.isEmpty {
                recent = (try? await api.libraryFiles(profileId: nil, spaceId: spaceId, limit: Self.recentShown))?.entries ?? recent
            }
        } catch is CancellationError {
            // The end scrolled away before its page came, and comes back for it.
        } catch ChannelError.rpc(let refusal) where refusal.code == "METHOD_NOT_FOUND" {
            problem = "Update Realm on your Mac to browse this folder here."
        } catch {
            problem = AppModel.describe(error)
        }
    }

    /// Rested a moment first, so a word typed is one question to the Mac.
    private func search(_ words: String) async {
        found = nil
        guard !words.isEmpty, let api = model.api, model.isConnected else { return }
        try? await Task.sleep(for: .milliseconds(250))
        guard !Task.isCancelled, let answer = try? await api.searchDocuments(spaceId: spaceId, query: words), !Task.isCancelled else { return }
        found = answer
    }
}
