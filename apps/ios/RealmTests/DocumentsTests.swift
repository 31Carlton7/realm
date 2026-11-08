import Foundation
import RealmKit
import Testing
@testable import Realm

/// The phone's Documents and Library: rows keep the Mac's order across pages, each file opens where the
/// desktop's would, and the gallery walks the list it was opened from.
struct DocumentsTests {
    private static func row(_ path: String, kind: String = "doc", mime: String = "text/markdown", isDir: Bool = false) -> DocumentRow {
        DocumentRow(path: path, name: (path as NSString).lastPathComponent, isDir: isDir, size: 10, kind: isDir ? "folder" : kind, mime: isDir ? "" : mime)
    }

    private static func listing(_ rows: [DocumentRow], next: Int? = nil) -> DocumentListing {
        DocumentListing(folder: "Field notes", entries: rows, total: rows.count, next: next)
    }

    private static func file(_ name: String, at: Millis = 1, origin: String = "output", title: String? = "Title") -> LibraryFile {
        LibraryFile(id: name, path: "/Mac/\(name)", name: name, origin: origin, at: at, sessionId: "s", sessionTitle: title, spaceId: "sp", kind: "doc", mime: "text/markdown")
    }

    @Test func aFolderKeepsTheMacsOrderAcrossPages() {
        var pages = FolderPages()
        pages.start(Self.listing([Self.row("archive", isDir: true), Self.row("notes", isDir: true), Self.row("a.md")], next: 3))
        pages.append(Self.listing([Self.row("b.md"), Self.row("c.md")]))
        #expect(pages.rows.map(\.path) == ["archive", "notes", "a.md", "b.md", "c.md"])
        #expect(pages.next == nil)
        #expect(pages.folder == "Field notes")
    }

    @Test func aFileThatMovedBetweenPagesIsListedOnce() {
        var pages = FolderPages()
        pages.start(Self.listing([Self.row("a.md"), Self.row("b.md")], next: 2))
        pages.append(Self.listing([Self.row("b.md"), Self.row("c.md")]))
        #expect(pages.rows.map(\.path) == ["a.md", "b.md", "c.md"])
    }

    @Test func aFreshFirstPageReplacesWhatWasThere() {
        var pages = FolderPages()
        pages.start(Self.listing([Self.row("old.md")], next: 1))
        pages.start(Self.listing([Self.row("new.md")]))
        #expect(pages.rows.map(\.path) == ["new.md"])
        #expect(pages.next == nil)
    }

    @Test func theLibraryKeepsNewestFirstAndAFileOnce() {
        var pages = LibraryPages()
        pages.start(LibraryPage(entries: [Self.file("c.md", at: 3), Self.file("b.md", at: 2)], next: LibraryCursor(ts: 2, id: "b.md")))
        pages.append(LibraryPage(entries: [Self.file("b.md", at: 2), Self.file("a.md", at: 1)], next: nil))
        #expect(pages.files.map(\.name) == ["c.md", "b.md", "a.md"])
        #expect(pages.next == nil)
    }

    @Test func eachFileOpensWhereTheDesktopsWould() {
        #expect(FileOpening(kind: "doc", mime: "text/markdown") == .markdown)
        #expect(FileOpening(kind: "slides", mime: "text/markdown") == .markdown)
        #expect(FileOpening(kind: "code", mime: "text/plain") == .code)
        #expect(FileOpening(kind: "sheet", mime: "text/csv") == .code)
        #expect(FileOpening(kind: "pdf", mime: "application/pdf") == .gallery)
        #expect(FileOpening(kind: "preview", mime: "image/png") == .gallery)
        #expect(FileOpening(kind: "video", mime: "video/mp4") == .gallery)
        // A kind with no editor goes by its mime type.
        #expect(FileOpening(kind: "unsupported", mime: "audio/mpeg") == .gallery)
        #expect(FileOpening(kind: "unsupported", mime: "application/octet-stream") == .code)
    }

    @Test func theGalleryWalksTheListsOwnFilesFromTheOneTapped() {
        let list: [any OpenableFile] = [
            Self.row("notes", isDir: true), Self.row("a.md"), Self.row("deck.pdf", kind: "pdf", mime: "application/pdf"),
            Self.row("shot.png", kind: "preview", mime: "image/png"),
        ]
        let shown = GalleryShown(source: .space("sp"), file: list[2], among: list)
        #expect(shown.pages.files.map(\.path) == ["shot.png", "deck.pdf"])
        #expect(shown.page == 1)
        #expect(shown.source == .space("sp"))
    }

    @Test func aShelfSaysThereIsMoreOnlyPastWhatItShows() {
        let five = (1...5).map { Self.file("\($0).md") }
        let six = (1...6).map { Self.file("\($0).md") }
        #expect(ShelfHead(LibraryPage(entries: five, next: nil)).more == false)
        #expect(ShelfHead(LibraryPage(entries: six, next: LibraryCursor(ts: 1, id: "6.md"))).more == true)
        #expect(ShelfHead(LibraryPage(entries: six, next: nil)).files.count == 5)
    }

    @Test func aFileSaysWhereItCameFrom() {
        #expect(Self.file("a.md").cameFrom == "Made in Title")
        #expect(Self.file("a.md", origin: "upload").cameFrom == "Attached to Title")
        #expect(Self.file("a.md", origin: "added", title: nil).cameFrom == "Added by you")
    }

    @Test func onlyASmallFileComesWholeWithoutAsking() {
        #expect(TextHead.next(truncated: false, size: 10_000_000) == .done)
        #expect(TextHead.next(truncated: true, size: 200 * 1024) == .fetch)
        #expect(TextHead.next(truncated: true, size: 1024 * 1024) == .offer)
        #expect(TextHead.next(truncated: true, size: 3 * 1024 * 1024) == .onTheMac)
    }

    @Test func anAnswerStandsOnlyForTheWordsItAnswers() {
        let answered = SearchAnswer(words: ".en", answer: DocumentSearch(entries: [], withheld: nil))
        #expect(answered.answer(to: ".en") != nil)
        #expect(answered.answer(to: ".env") == nil)
    }

    @Test func theMenuOffersTheLibrary() {
        #expect(WorkPage.library.route == .library)
        #expect(WorkPage.library.note(reviews: nil, schedules: nil) == nil)
    }
}
