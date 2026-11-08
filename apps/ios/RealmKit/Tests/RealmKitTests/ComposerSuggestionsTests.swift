import Foundation
@testable import RealmKit
import Testing

@Suite("The composer's / and @, as the desktop's prompter has them")
struct ComposerSuggestionsTests {
    static let designer = Teammate(id: "t2", spaceId: "sp1", name: "Designer", handle: "designer", brief: "## Owns the look\nand the type", lead: false, chatId: nil)
    static let cto = Teammate(id: "t1", spaceId: "sp1", name: "CTO", handle: "cto", brief: "", lead: true, chatId: nil)
    static let review = MentionSkill(id: "code-review", name: "Code review", description: "Review the diff")
    static let mac = MentionSkill(id: "mac", name: "mac", description: "The Mac's apps")
    static let auth = MentionFile(path: "/Users/me/realm/src/server/auth.ts", rel: "src/server/auth.ts")
    static let otherAuth = MentionFile(path: "/Users/me/realm/apps/web/auth.ts", rel: "apps/web/auth.ts")
    static let pricing = SpaceTab(itemId: "i-b1", kind: .browser, title: "Pricing", url: "https://example.com/pricing/")
    static let notes = SpaceTab(itemId: "i-d1", kind: .documents, title: "notes.md", path: "/Users/me/realm/notes.md")
    static let shell = SpaceTab(itemId: "i-t1", kind: .terminal, title: "")

    static let commands = ComposerCommand.list(
        modes: [Choice(id: "build", label: "Build"), Choice(id: "plan", label: "Plan"), Choice(id: "ask", label: "Ask")],
        goal: true, attach: true,
        user: [UserCommand(name: "changelog", description: "Write the changelog", argumentHint: "<version>"),
               UserCommand(name: "tidy", description: "Tidy the imports", argumentHint: nil)])

    // MARK: - Where a list opens

    @Test func aSlashOpensOnlyAtTheStartOfTheDraftAndWhileTheCaretIsInItsWord() {
        #expect(ComposerToken.slash(in: "/", caret: 1) == ComposerToken(start: 0, end: 1, query: ""))
        #expect(ComposerToken.slash(in: "/pl", caret: 3) == ComposerToken(start: 0, end: 3, query: "pl"))
        // Mid-word, the token runs to the word's end, so a pick leaves no stray letters.
        #expect(ComposerToken.slash(in: "/plan", caret: 2) == ComposerToken(start: 0, end: 5, query: "p"))
        #expect(ComposerToken.slash(in: "/plan look at it", caret: 16) == nil)
        #expect(ComposerToken.slash(in: "see src/app", caret: 11) == nil)
        #expect(ComposerToken.slash(in: " /plan", caret: 6) == nil)
        #expect(ComposerToken.slash(in: "/plan", caret: 0) == nil)
    }

    @Test func anAtOpensAtTheStartOfALineOrAfterASpaceButNotInsideAWordOrAnEmail() {
        #expect(ComposerToken.mention(in: "@", caret: 1) == ComposerToken(start: 0, end: 1, query: ""))
        #expect(ComposerToken.mention(in: "ask @des", caret: 8) == ComposerToken(start: 4, end: 8, query: "des"))
        #expect(ComposerToken.mention(in: "first line\n@cto", caret: 15) == ComposerToken(start: 11, end: 15, query: "cto"))
        #expect(ComposerToken.mention(in: "write to me@mac.com", caret: 19) == nil)
        #expect(ComposerToken.mention(in: "mail me@", caret: 8) == nil)
        // A path is part of what can be typed after it.
        #expect(ComposerToken.mention(in: "@src/au", caret: 7)?.query == "src/au")
        // A space ends the token, and with it the list, as on the desktop.
        #expect(ComposerToken.mention(in: "@designer ", caret: 10) == nil)
        #expect(ComposerToken.mention(in: "@ma and more", caret: 2) == ComposerToken(start: 0, end: 3, query: "m"))
    }

    // MARK: - The / list

    @Test func theListIsTheDesktopsInItsOrderAndFiltersByTheStartOfAName() {
        #expect(Self.commands.map(\.id) == ["build", "plan", "ask", "goal", "attach", "changelog", "tidy"])
        #expect(Self.commands.first?.hint == "Read, write and run — the usual way")
        #expect(ComposerCommand.filter(Self.commands, query: "p").map(\.id) == ["plan"])
        #expect(ComposerCommand.filter(Self.commands, query: "SET").map(\.id) == ["goal"])
        // A substring is not a match: `an` must not offer `/changelog` or `/plan`.
        #expect(ComposerCommand.filter(Self.commands, query: "an").isEmpty)
        #expect(ComposerCommand.filter(Self.commands, query: "").count == 7)
    }

    @Test func anOlderMacOrOneThatTakesNoFilesGetsNoGoalOrAttach() {
        let bare = ComposerCommand.list(modes: [Choice(id: "build", label: "Build")], goal: false, attach: false, user: [])
        #expect(bare.map(\.id) == ["build"])
    }

    @Test func pickingACommandTakesItsTokenOutAndRunsOnWhatFollowed() {
        let plan = Self.commands[1]
        let picked = ComposerCommand.pick(plan, in: "/pl look at the auth code", token: ComposerToken(start: 0, end: 3, query: "pl"))
        #expect(picked.draft == "look at the auth code")
        #expect(picked.caret == 0)
        #expect(picked.run == "look at the auth code")
    }

    @Test func aCommandThatNeedsWordsIsArmedThenRunBySend() {
        let goal = Self.commands[3]
        let armed = ComposerCommand.pick(goal, in: "/go", token: ComposerToken(start: 0, end: 3, query: "go"))
        #expect(armed.draft == "/goal ")
        #expect(armed.caret == 6)
        #expect(armed.run == nil)
        let call = ComposerCommand.call(in: "/goal ship the release notes", commands: Self.commands)
        #expect(call?.command.id == "goal")
        #expect(call?.rest == "ship the release notes")
        #expect(ComposerCommand.call(in: "/changelog 2.8.0", commands: Self.commands)?.rest == "2.8.0")
        // A command that takes no words, or words that merely start with a slash, are sent as they are.
        #expect(ComposerCommand.call(in: "/tidy now", commands: Self.commands) == nil)
        #expect(ComposerCommand.call(in: "/goals are good", commands: Self.commands) == nil)
    }

    // MARK: - The @ list

    @Test func aBareAtIsATourOfEachKindUnderItsHeadWithMacFirst() {
        let rows = Mentions.rows(teammates: [Self.cto, Self.designer], files: [Self.auth], skills: [Self.review, Self.mac], query: "")
        #expect(rows.map(\.id) == ["mac", "role:t1", "role:t2", "file:/Users/me/realm/src/server/auth.ts", "skill:code-review"])
        #expect(rows.map(\.head) == [nil, "Team", nil, "Files", "Skills"])
        #expect(rows[2].name == "designer")
        #expect(rows[2].detail == "Gets the message · Owns the look")
        #expect(rows[1].detail == "Gets the message in its own chat")
        #expect(rows[3].name == "auth.ts")
        #expect(rows[3].detail == "src/server")
        #expect(rows[4].detail == "Code review — Review the diff")
    }

    @Test func withoutTheMacSkillTeammatesLead() {
        let rows = Mentions.rows(teammates: [Self.designer], files: [Self.auth], skills: [Self.review], query: "")
        #expect(rows.first?.id == "role:t2")
    }

    @Test func aWordAfterTheAtIsOneListRankedAcrossKindsSayingWhatEachIs() {
        let rows = Mentions.rows(teammates: [Self.cto, Self.designer], files: [Self.auth], skills: [Self.review, Self.mac], query: "des")
        #expect(rows.map(\.id) == ["role:t2"])
        #expect(rows[0].detail == "Teammate · Gets the message · Owns the look")
        // A whole name beats the start of one, which beats a word inside one.
        let auth = Mentions.rows(teammates: [], files: [Self.auth], skills: [MentionSkill(id: "authoring", name: "authoring", description: "")], query: "auth")
        #expect(auth.map(\.name) == ["authoring", "auth.ts"])
        #expect(auth[1].detail == "File · src/server")
        // A teammate is found by its name as well as its handle; nothing that does not match is listed.
        #expect(Mentions.rows(teammates: [Self.cto], files: [], skills: [], query: "CTO").map(\.id) == ["role:t1"])
        #expect(Mentions.rows(teammates: [Self.cto], files: [], skills: [], query: "zz").isEmpty)
        #expect(Mentions.rows(teammates: [], files: [], skills: [Self.review], query: "cr").map(\.id) == ["skill:code-review"])
    }

    @Test func theTabsGroupFollowsTheTeamAsTheDesktopsDoesEachByItsTitleAndAddress() {
        let rows = Mentions.rows(teammates: [Self.cto], tabs: [Self.pricing, Self.notes, Self.shell], files: [Self.auth], skills: [Self.review, Self.mac], query: "")
        #expect(rows.map(\.id) == ["mac", "role:t1", "tab:i-b1", "tab:i-d1", "tab:i-t1", "file:/Users/me/realm/src/server/auth.ts", "skill:code-review"])
        #expect(rows.map(\.head) == [nil, "Team", "Tabs", nil, nil, "Files", "Skills"])
        // A page by its address without the scheme; a document and an untitled terminal by their kind.
        #expect(rows[2...4].map(\.name) == ["Pricing", "notes.md", "Terminal"])
        #expect(rows[2...4].map(\.detail) == ["example.com/pricing", "Documents", "Terminal"])
        // The tour shows five; typing is how the rest is reached.
        let many = (1...7).map { SpaceTab(itemId: "i-\($0)", kind: .browser, title: "Page \($0)") }
        #expect(Mentions.rows(teammates: [], tabs: many, files: [], skills: [], query: "").count == 5)
    }

    @Test func aTabIsFoundByItsTitleOrItsAddress() {
        let byTitle = Mentions.rows(teammates: [], tabs: [Self.pricing, Self.notes], files: [], skills: [], query: "pric")
        #expect(byTitle.map(\.id) == ["tab:i-b1"])
        #expect(byTitle[0].detail == "Tab · example.com/pricing")
        #expect(Mentions.rows(teammates: [], tabs: [Self.pricing], files: [], skills: [], query: "example").map(\.id) == ["tab:i-b1"])
        #expect(Mentions.rows(teammates: [], tabs: [Self.notes], files: [], skills: [], query: "notes").map(\.id) == ["tab:i-d1"])
        #expect(Mentions.rows(teammates: [], tabs: [Self.pricing], files: [], skills: [], query: "zz").isEmpty)
    }

    // MARK: - What a pick puts in the draft

    @Test func pickingATabTakesTheAtOutAndWritesNothingForIt() {
        let row = MentionRow(kind: .tab(Self.pricing), name: "Pricing", detail: "", head: nil)
        let picked = Mentions.pick(row, in: "compare @pri with ours", token: ComposerToken(start: 8, end: 12, query: "pri"), refs: [])
        #expect(picked.draft == "compare  with ours")
        #expect(picked.caret == 8)
        #expect(picked.ref == nil)
    }

    @Test func pickingATeammateWritesItsHandleAndKeepsWhatItNames() {
        let token = ComposerToken(start: 4, end: 8, query: "des")
        let row = MentionRow(kind: .teammate(Self.designer), name: "designer", detail: "", head: nil)
        let picked = Mentions.pick(row, in: "ask @des about this", token: token, refs: [])
        #expect(picked.draft == "ask @designer  about this")
        #expect(picked.caret == 14)
        #expect(picked.ref == .role(label: "designer", roleId: "t2"))
    }

    @Test func pickingASkillWritesItsIdAndNamesNothingBesideIt() {
        let row = MentionRow(kind: .skill(Self.review), name: "code-review", detail: "", head: nil)
        let picked = Mentions.pick(row, in: "@co", token: ComposerToken(start: 0, end: 3, query: "co"), refs: [])
        #expect(picked.draft == "@code-review ")
        #expect(picked.ref == nil)
    }

    @Test func twoFilesOfOneNameAreToldApartByTheirFolders() {
        let first = Mentions.pick(MentionRow(kind: .file(Self.auth), name: "auth.ts", detail: "", head: nil), in: "@au", token: ComposerToken(start: 0, end: 3, query: "au"), refs: [])
        #expect(first.ref == .file(label: "auth.ts", path: Self.auth.path))
        let second = Mentions.pick(MentionRow(kind: .file(Self.otherAuth), name: "auth.ts", detail: "", head: nil), in: first.draft + "@au",
                                   token: ComposerToken(start: first.draft.count, end: first.draft.count + 3, query: "au"), refs: [first.ref!])
        #expect(second.ref == .file(label: "web/auth.ts", path: Self.otherAuth.path))
        #expect(second.draft == "@auth.ts @web/auth.ts ")
    }

    @Test func aLabelWithASpaceIsWrittenAsTheDesktopsToken() {
        let file = MentionFile(path: "/Users/me/realm/My Notes.md", rel: "My Notes.md")
        let picked = Mentions.pick(MentionRow(kind: .file(file), name: "My Notes.md", detail: "", head: nil), in: "@my", token: ComposerToken(start: 0, end: 3, query: "my"), refs: [])
        #expect(picked.draft == "@[My Notes.md] ")
        #expect(Mentions.chipLabel("a [b]@c\n d") == "a b c d")
    }

    // MARK: - What goes to the Mac

    @Test func sendWritesEachNamedThingAsTheDesktopDoesAndDropsOnesDeleted() {
        let refs: [MentionRef] = [.role(label: "designer", roleId: "t2"), .file(label: "auth.ts", path: Self.auth.path), .role(label: "cto", roleId: "t1")]
        let sent = Mentions.wire("@designer, look at @auth.ts. Thanks @designers", refs: refs)
        #expect(sent.text == "@[designer], look at @[auth.ts]. Thanks @designers")
        #expect(sent.refs == [refs[0], refs[1]])
        // An email that happens to hold a label is not a mention.
        #expect(Mentions.wire("mail me@designer", refs: [refs[0]]).refs.isEmpty)
        #expect(Mentions.wire("@[My Notes.md] read", refs: [.file(label: "My Notes.md", path: "/x/My Notes.md")]).refs.count == 1)
    }

    @Test func sentWordsShowTheirChips() {
        let text = "@[designer] look at @[auth.ts], not @[ broken"
        #expect(Mentions.chips(in: text).map(\.label) == ["designer", "auth.ts"])
        #expect(text[Mentions.chips(in: text)[0].range] == "@[designer]")
    }

    @Test func refsTravelAsTheMacReadsThem() throws {
        let data = try JSONEncoder().encode([MentionRef.role(label: "designer", roleId: "t2"), .file(label: "auth.ts", path: "/a/auth.ts")])
        let json = try #require(try JSONSerialization.jsonObject(with: data) as? [[String: String]])
        #expect(json == [["kind": "role", "label": "designer", "roleId": "t2"], ["kind": "file", "label": "auth.ts", "path": "/a/auth.ts"]])
        #expect(try JSONDecoder().decode([MentionRef].self, from: data).map(\.label) == ["designer", "auth.ts"])
    }

    @Test func anOutboxSavedBeforeMentionsStillReads() throws {
        let item = OutgoingItem(sessionId: "s1", payload: .message(text: "@[cto] hi"), afterSeq: 1, mentionRefs: [.role(label: "cto", roleId: "t1")])
        var saved = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(item)) as? [String: Any])
        #expect(try JSONDecoder().decode(OutgoingItem.self, from: JSONSerialization.data(withJSONObject: saved)).mentionRefs == item.mentionRefs)
        saved["mentionRefs"] = nil
        #expect(try JSONDecoder().decode(OutgoingItem.self, from: JSONSerialization.data(withJSONObject: saved)).mentionRefs == [])
    }

    @Test func tabsTravelAsTheMacReadsThemAndAnOutboxFromBeforeThemStillReads() throws {
        let data = try JSONEncoder().encode(Self.pricing.ref)
        let json = try #require(try JSONSerialization.jsonObject(with: data) as? [String: String])
        #expect(json == ["itemId": "i-b1", "kind": "browser", "title": "Pricing"])
        let item = OutgoingItem(sessionId: "s1", payload: .message(text: "compare"), afterSeq: 1, tabs: [Self.pricing.ref])
        var saved = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(item)) as? [String: Any])
        #expect(try JSONDecoder().decode(OutgoingItem.self, from: JSONSerialization.data(withJSONObject: saved)).tabs == [Self.pricing.ref])
        saved["tabs"] = nil
        #expect(try JSONDecoder().decode(OutgoingItem.self, from: JSONSerialization.data(withJSONObject: saved)).tabs == [])
    }

    // MARK: - mobile.v1 as the Mac writes it

    @Test(.enabled(if: APIFixtureTests.available, "ts-api.json is not written yet (the server's suite writes it)"))
    func theTabsCallsAndASentMessagesCardsDecode() throws {
        struct Tabs: Decodable { let tabs: [SpaceTab] }
        let tabs = try APIFixtureTests.decode(Tabs.self, "calls", "session.tabs").tabs
        #expect(tabs.map(\.kind) == [.browser, .browser, .terminal])
        #expect(tabs.first?.detail == "localhost:4000/docs")
        let card = try APIFixtureTests.decode(TabCard.self, "calls", "session.tabPreview")
        #expect(card.title == "Realm docs" && card.bytes == 18_432 && card.truncated == false && card.closed == nil)
        let row = try #require(try APIFixtureTests.opened().rows.first { $0.sentTabs != nil })
        #expect(row.sentTabs?.map(\.title) == ["Realm docs"])
    }

    @Test(.enabled(if: APIFixtureTests.available, "ts-api.json is not written yet (the server's suite writes it)"))
    func theComposersCallsDecode() throws {
        let lists = try APIFixtureTests.decode(ComposerLists.self, "calls", "session.composer")
        #expect(lists.commands.map(\.name) == ["changelog", "tidy"])
        #expect(lists.commands.map(\.argumentHint) == ["<version>", nil])
        #expect(lists.skills.map(\.id) == ["code-review", "mac"])
        struct Files: Decodable { let files: [MentionFile] }
        let files = try APIFixtureTests.decode(Files.self, "calls", "session.mentionFiles").files
        #expect(files.first?.rel == "src/theme.ts")
        #expect(files.first?.path.hasSuffix("/src/theme.ts") == true)
        #expect(try APIFixtureTests.decode(ExpandedCommand.self, "calls", "session.expandCommand").text == "Write the changelog for 2.8.0.")
    }
}
