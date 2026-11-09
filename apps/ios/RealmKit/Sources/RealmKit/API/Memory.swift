import Foundation

/// A memory as a list shows it (`memory.overview`, `memory.list`). Its path stays on the Mac.
public struct MemoryRow: Codable, Sendable, Hashable, Identifiable {
    public let id: String
    public let title: String
    public let description: String?
    public let type: String?
    /// Where it is kept, as the desktop's rows name it: "Memory repo", "Claude · User memory".
    public let source: String
    /// Where in that source it sits, when that says something.
    public let folder: String?
    /// A folder's index of memories, its `MEMORY.md`.
    public let index: Bool
    public let updatedAt: Millis
    /// A search's best line in the file.
    public let match: String?

    public init(id: String, title: String, description: String?, type: String?, source: String, folder: String?, index: Bool, updatedAt: Millis, match: String?) {
        self.id = id
        self.title = title
        self.description = description
        self.type = type
        self.source = source
        self.folder = folder
        self.index = index
        self.updatedAt = updatedAt
        self.match = match
    }
}

/// Who a group of memories is for: every space of a profile, one space, or an agent's own files for all
/// of them. `entries` is its newest few of `count`.
public struct MemoryPlace: Codable, Sendable, Hashable, Identifiable {
    public enum Kind: String, Codable, Sendable { case every, space, agent }

    public let id: String
    public let profileId: String
    public let kind: Kind
    public let spaceId: String?
    public let title: String
    public let count: Int
    public let entries: [MemoryRow]

    public init(id: String, profileId: String, kind: Kind, spaceId: String?, title: String, count: Int, entries: [MemoryRow]) {
        self.id = id
        self.profileId = profileId
        self.kind = kind
        self.spaceId = spaceId
        self.title = title
        self.count = count
        self.entries = entries
    }
}

/// Where a new memory can go: a Realm repo's root, or a space's folder of the profile's repo.
public struct MemoryHome: Codable, Sendable, Hashable {
    public let sourceId: String
    public let spaceId: String?
    public let label: String

    public init(sourceId: String, spaceId: String?, label: String) {
        self.sourceId = sourceId
        self.spaceId = spaceId
        self.label = label
    }
}

/// A profile's memory library as one page.
public struct MemoryOverview: Codable, Sendable, Hashable {
    public let places: [MemoryPlace]
    public let homes: [MemoryHome]
    /// The profile's "Learn from sessions" switch.
    public let learning: Bool

    public init(places: [MemoryPlace], homes: [MemoryHome], learning: Bool) {
        self.places = places
        self.homes = homes
        self.learning = learning
    }
}

/// One page of a profile's memories.
public struct MemoryPage: Codable, Sendable, Hashable {
    public let entries: [MemoryRow]
    public let total: Int
    /// Where the next page starts, or nil at the end.
    public let next: Int?

    public init(entries: [MemoryRow], total: Int, next: Int?) {
        self.entries = entries
        self.total = total
        self.next = next
    }
}

/// One memory whole (`memory.file`).
public struct MemoryFile: Codable, Sendable, Hashable, Identifiable {
    public struct Field: Codable, Sendable, Hashable {
        public let key: String
        public let value: String

        public init(key: String, value: String) {
            self.key = key
            self.value = value
        }
    }

    /// A `[[link]]` or relative `.md` link as written, and the memory it opens, if any.
    public struct Link: Codable, Sendable, Hashable {
        public let target: String
        public let id: String?

        public init(target: String, id: String?) {
            self.target = target
            self.id = id
        }
    }

    /// Who loads the file: "Every agent", "in Realm", "through Realm's memory tools".
    public struct Reader: Codable, Sendable, Hashable {
        public let who: String
        public let `where`: String
        public let how: String?

        public init(who: String, where place: String, how: String?) {
            self.who = who
            self.where = place
            self.how = how
        }
    }

    public let id: String
    public let title: String
    public let description: String?
    public let type: String?
    public let source: String
    public let folder: String?
    public let index: Bool
    public let updatedAt: Millis
    /// Its path from the home folder.
    public let displayPath: String
    /// The whole file, frontmatter included: what the editor edits.
    public let text: String
    /// The file after its frontmatter: what the reader renders.
    public let body: String
    public let frontmatter: [Field]
    public let links: [Link]
    public let readBy: [Reader]
    /// A file outside Realm: writing or deleting it asks first, and a deleted one goes to the Trash.
    public let external: Bool
    public let writable: Bool
    public let deletable: Bool
    /// Why it cannot be edited or deleted here, or anything else a reader should know first.
    public let note: String?

    public init(id: String, title: String, description: String?, type: String?, source: String, folder: String?, index: Bool, updatedAt: Millis,
                displayPath: String, text: String, body: String, frontmatter: [Field], links: [Link], readBy: [Reader],
                external: Bool, writable: Bool, deletable: Bool, note: String?) {
        self.id = id
        self.title = title
        self.description = description
        self.type = type
        self.source = source
        self.folder = folder
        self.index = index
        self.updatedAt = updatedAt
        self.displayPath = displayPath
        self.text = text
        self.body = body
        self.frontmatter = frontmatter
        self.links = links
        self.readBy = readBy
        self.external = external
        self.writable = writable
        self.deletable = deletable
        self.note = note
    }
}
