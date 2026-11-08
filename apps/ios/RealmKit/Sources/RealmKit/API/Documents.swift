import Foundation

/// Where a file is read from: a session's own files, a space's folder, or the Library. Each has its own
/// pair of calls on the Mac, which decide what may be read.
public enum FileSource: Hashable, Sendable {
    case session(String)
    case space(String)
    case library
}

/// A file or folder in a space's folder, as the desktop's file picker lists it (`documents.list`).
public struct DocumentRow: Codable, Sendable, Hashable, Identifiable {
    /// Relative to the space's folder.
    public let path: String
    public let name: String
    public let isDir: Bool
    public let size: Double
    /// The desktop's `documentKindFor`: "doc", "code", "pdf", "preview", "video", ... or "folder".
    public let kind: String
    public let mime: String

    public var id: String { path }

    public init(path: String, name: String, isDir: Bool, size: Double, kind: String, mime: String) {
        self.path = path
        self.name = name
        self.isDir = isDir
        self.size = size
        self.kind = kind
        self.mime = mime
    }
}

/// One page of a level of a space's folder.
public struct DocumentListing: Codable, Sendable, Hashable {
    /// The folder's own name, on the Mac.
    public let folder: String
    public let entries: [DocumentRow]
    public let total: Int
    /// Where the next page starts, or nil at the end.
    public let next: Int?

    public init(folder: String, entries: [DocumentRow], total: Int, next: Int?) {
        self.folder = folder
        self.entries = entries
        self.total = total
        self.next = next
    }
}

/// What a search of a space's folder found.
public struct DocumentSearch: Codable, Sendable, Hashable {
    public let entries: [DocumentRow]
    /// The file the words name exactly, where it holds a secret: said, and never sent.
    public let withheld: DocumentRow?

    public init(entries: [DocumentRow], withheld: DocumentRow?) {
        self.entries = entries
        self.withheld = withheld
    }
}

/// A file of the Library, whichever session it came from (`library.files`).
public struct LibraryFile: Codable, Sendable, Hashable, Identifiable {
    public let id: String
    /// Its full path on the Mac.
    public let path: String
    public let name: String
    /// "output" made by an agent, "upload" attached by the person, "added" added by them.
    public let origin: String
    public let at: Millis
    public let sessionId: String?
    public let sessionTitle: String?
    public let spaceId: String?
    public let kind: String
    public let mime: String

    public init(id: String, path: String, name: String, origin: String, at: Millis, sessionId: String?, sessionTitle: String?,
                spaceId: String?, kind: String, mime: String) {
        self.id = id
        self.path = path
        self.name = name
        self.origin = origin
        self.at = at
        self.sessionId = sessionId
        self.sessionTitle = sessionTitle
        self.spaceId = spaceId
        self.kind = kind
        self.mime = mime
    }
}

/// Where the Library's next page starts.
public struct LibraryCursor: Codable, Sendable, Hashable {
    public let ts: Double
    public let id: String

    public init(ts: Double, id: String) {
        self.ts = ts
        self.id = id
    }
}

/// One page of the Library's files, the newest touched first.
public struct LibraryPage: Codable, Sendable, Hashable {
    public let entries: [LibraryFile]
    public let next: LibraryCursor?

    public init(entries: [LibraryFile], next: LibraryCursor?) {
        self.entries = entries
        self.next = next
    }
}
