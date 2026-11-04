import Foundation

/// The `/` or `@` token governing the caret, in characters: `start` is its sigil, `end` is one past its
/// last character — which may lie beyond the caret, so a pick in the middle of `@ma|c` replaces the
/// whole token and leaves no stray `c` — and `query` is what has been typed between the sigil and the
/// caret.
public struct ComposerToken: Hashable, Sendable {
    public let start: Int
    public let end: Int
    public let query: String

    public init(start: Int, end: Int, query: String) {
        self.start = start
        self.end = end
        self.query = query
    }

    /// The `/`-token, as the desktop's prompter finds it (`slashQueryAt`). A command may only open the
    /// draft: a slash anywhere else is a path, a fraction or half a URL. Once the caret has moved past
    /// the token — `/plan look at this` — the person is writing, and there is no token.
    public static func slash(in text: String, caret: Int) -> ComposerToken? {
        let chars = Array(text)
        guard chars.first == "/" else { return nil }
        var end = 1
        while end < chars.count, chars[end].isASCII, chars[end].isLetter || chars[end].isNumber || chars[end] == "-" { end += 1 }
        guard caret >= 1, caret <= end else { return nil }
        return ComposerToken(start: 0, end: end, query: String(chars[1..<caret]))
    }

    /// The `@`-token, as the desktop's prompter finds it (`mentionQueryAt`): the `@` must open the text or
    /// follow whitespace, so a caret inside `me@mac.com` opens nothing. What follows it may hold a path's
    /// `/`, since a file is found by `src/au` as often as by `auth`.
    public static func mention(in text: String, caret: Int) -> ComposerToken? {
        let chars = Array(text)
        let caret = min(max(caret, 0), chars.count)
        var i = caret
        while i > 0, isQueryCharacter(chars[i - 1]) { i -= 1 }
        guard i > 0, chars[i - 1] == "@" else { return nil }
        let start = i - 1
        if start > 0, !chars[start - 1].isWhitespace { return nil }
        var end = caret
        while end < chars.count, isQueryCharacter(chars[end]) { end += 1 }
        return ComposerToken(start: start, end: end, query: String(chars[i..<caret]))
    }

    static func isQueryCharacter(_ c: Character) -> Bool {
        c.isASCII && (c.isLetter || c.isNumber || "._/-".contains(c))
    }
}

/// A `/` command: one of Realm's own — a mode, `/goal`, `/attach` — or one of the person's. Nothing here
/// is sent to the agent as a command; running one acts on the session or fills the composer.
public struct ComposerCommand: Hashable, Sendable, Identifiable {
    public enum Action: Hashable, Sendable {
        /// Puts the session in a mode, by `session.options`' id for it.
        case mode(String)
        /// Starts a goal on the words after it.
        case goal
        /// Opens the photo library, the camera or Files.
        case attach
        /// Fills the composer with the command's template, filled in with the words after it.
        case user(UserCommand)
    }

    /// The word after the slash.
    public let id: String
    public let label: String
    /// What running it does.
    public let hint: String
    /// It is nothing without words after it: picked, it waits for them, and Send runs it on them.
    public let takesArgument: Bool
    public let action: Action

    public init(id: String, label: String, hint: String, takesArgument: Bool = false, action: Action) {
        self.id = id
        self.label = label
        self.hint = hint
        self.takesArgument = takesArgument
        self.action = action
    }

    /// The desktop's words for each mode's command.
    static let modeHints = [
        "build": "Read, write and run — the usual way",
        "plan": "Work out an approach without changing anything",
        "ask": "Questions only — no edits, no commands",
    ]

    /// The commands a phone offers, in the desktop's order: the modes the agent has, `/goal`, `/attach`,
    /// then the person's own. `goal` is false for a Mac that cannot start one from a phone, and `attach`
    /// for one that takes no files.
    public static func list(modes: [Choice], goal: Bool, attach: Bool, user: [UserCommand]) -> [ComposerCommand] {
        var commands = modes.map { ComposerCommand(id: $0.id, label: $0.label, hint: modeHints[$0.id] ?? "Switch to \($0.label)", action: .mode($0.id)) }
        if goal {
            commands.append(ComposerCommand(id: "goal", label: "Set a goal", hint: "Work towards an objective across turns", takesArgument: true, action: .goal))
        }
        if attach {
            commands.append(ComposerCommand(id: "attach", label: "Add files", hint: "Attach photos or files to this message", action: .attach))
        }
        // The Mac refuses a command of a name a built-in owns, so the person's never shadow one.
        commands += user.map { ComposerCommand(id: $0.name, label: $0.name, hint: $0.description, takesArgument: $0.argumentHint != nil, action: .user($0)) }
        return commands
    }

    /// The commands whose name or label starts with `query`. A prefix rather than a substring, because
    /// a command is typed from its start: three letters into `/exp` should not still offer `/connections`.
    public static func filter(_ commands: [ComposerCommand], query: String) -> [ComposerCommand] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return commands }
        return commands.filter { $0.id.lowercased().hasPrefix(q) || $0.label.lowercased().hasPrefix(q) }
    }

    /// What picking `command` over `token` does to the draft. One that needs words and has none yet is
    /// armed — `/goal ` with the caret after it — and `run` is nil. Otherwise the token is taken out,
    /// what followed it stays, and `run` is those words: `/plan look at the auth code` sets the mode and
    /// leaves the sentence to send.
    public static func pick(_ command: ComposerCommand, in text: String, token: ComposerToken) -> (draft: String, caret: Int, run: String?) {
        let rest = String(Array(text)[token.end...]).trimmingLeadingWhitespace()
        if command.takesArgument && rest.isEmpty {
            let armed = "/\(command.id) "
            return (armed, armed.count, nil)
        }
        return (rest, 0, rest)
    }

    /// The command a draft calls, and its words, for Send: only one that takes words, and only when
    /// the draft opens with its name. By then the list has stepped aside, so Send is what runs it.
    public static func call(in text: String, commands: [ComposerCommand]) -> (command: ComposerCommand, rest: String)? {
        guard let token = ComposerToken.slash(in: text, caret: 1) else { return nil }
        let id = String(Array(text)[1..<token.end])
        guard let command = commands.first(where: { $0.takesArgument && $0.id == id }) else { return nil }
        return (command, String(Array(text)[token.end...]).trimmingLeadingWhitespace())
    }
}

/// One row of the `@` list, as the desktop's draws it: what it names, the quiet line after its name,
/// and, in the list a bare `@` opens, the head of the group it starts.
public struct MentionRow: Hashable, Sendable, Identifiable {
    public enum Kind: Hashable, Sendable {
        /// The `mac` skill, which drives the Mac's own apps: first, on its own.
        case mac(MentionSkill)
        /// A teammate in the space: naming it hands it the message.
        case teammate(Teammate)
        case file(MentionFile)
        case skill(MentionSkill)
    }

    public let kind: Kind
    public let name: String
    public let detail: String
    public let head: String?

    public var id: String {
        switch kind {
        case .mac: "mac"
        case .teammate(let t): "role:\(t.id)"
        case .file(let f): "file:\(f.path)"
        case .skill(let s): "skill:\(s.id)"
        }
    }
}

/// The `@` list and what a pick from it puts in the draft, as the desktop's prompter does
/// (`mention-sources.ts`): teammates, the session's folder's files, and skills, with the `mac` skill as
/// @Mac. A bare `@` is a short tour, each kind under its head; a word after it is one list ranked across
/// every kind, so the best match is first whatever it is.
public enum Mentions {
    public static let macId = "mac"
    public static let macDetail = "Calendar, Reminders, Contacts and more on this Mac"
    /// The longest label a named thing wears, as the desktop's chip.
    static let labelMax = 56

    private enum Group: Int { case mac, teammate, skill, file }

    private static let tourCaps: [Group: Int] = [.teammate: 4, .file: 4, .skill: 5]
    private static let rankedCaps: [Group: Int] = [.mac: 1, .teammate: 4, .skill: 4, .file: 6]

    public static func rows(teammates: [Teammate], files: [MentionFile], skills: [MentionSkill], query: String) -> [MentionRow] {
        let mac = skills.first { $0.id == macId }
        let others = skills.filter { $0.id != macId }
        let q = query.trimmingCharacters(in: .whitespaces)
        if q.isEmpty {
            var rows: [MentionRow] = []
            if let mac { rows.append(MentionRow(kind: .mac(mac), name: macId, detail: macDetail, head: nil)) }
            for (i, t) in teammates.prefix(tourCaps[.teammate]!).enumerated() {
                rows.append(MentionRow(kind: .teammate(t), name: t.handle, detail: teammateDetail(t), head: i == 0 ? "Team" : nil))
            }
            for (i, f) in files.prefix(tourCaps[.file]!).enumerated() {
                rows.append(MentionRow(kind: .file(f), name: basename(f.rel), detail: directory(f.rel), head: i == 0 ? "Files" : nil))
            }
            for (i, s) in others.prefix(tourCaps[.skill]!).enumerated() {
                rows.append(MentionRow(kind: .skill(s), name: s.id, detail: skillDetail(s), head: i == 0 ? "Skills" : nil))
            }
            return rows
        }

        struct Scored { let row: MentionRow; let group: Group; let score: Int; let length: Int }
        func ordered(_ a: Scored, _ b: Scored) -> Bool {
            if a.score != b.score { return a.score > b.score }
            if a.length != b.length { return a.length < b.length }
            if a.group != b.group { return a.group.rawValue < b.group.rawValue }
            return a.row.name < b.row.name
        }
        var groups: [[Scored]] = []
        var macHits: [Scored] = []
        if let mac, let s = score(names: [macId, "macOS"], query: q) {
            macHits.append(Scored(row: MentionRow(kind: .mac(mac), name: macId, detail: "Skill · \(macDetail)", head: nil), group: .mac, score: s.score, length: s.length))
        }
        groups.append(macHits)
        groups.append(teammates.compactMap { t in
            score(names: [t.handle, t.name], query: q).map {
                Scored(row: MentionRow(kind: .teammate(t), name: t.handle, detail: "Teammate · \(teammateDetail(t))", head: nil), group: .teammate, score: $0.score, length: $0.length)
            }
        })
        groups.append(others.compactMap { k in
            score(names: [k.id, k.name], query: q).map {
                Scored(row: MentionRow(kind: .skill(k), name: k.id, detail: "Skill · \(skillDetail(k))", head: nil), group: .skill, score: $0.score, length: $0.length)
            }
        })
        groups.append(files.compactMap { f in
            // A file is read by its name, so a long path is not held against it.
            score(names: [f.rel], query: q).map {
                let dir = directory(f.rel)
                return Scored(row: MentionRow(kind: .file(f), name: basename(f.rel), detail: dir.isEmpty ? "File" : "File · \(dir)", head: nil),
                              group: .file, score: $0.score, length: basename(f.rel).count)
            }
        })
        var kept: [Scored] = []
        for group in groups {
            guard let first = group.first else { continue }
            kept += group.sorted(by: ordered).prefix(rankedCaps[first.group]!)
        }
        return kept.sorted(by: ordered).map(\.row)
    }

    /// The best a name earns against `query`, and the length of that name; nil when none matches. A
    /// whole name beats its start, a start beats a word's start inside it, which beats a run anywhere
    /// in it, which beats its letters in order.
    static func score(names: [String], query: String) -> (score: Int, length: Int)? {
        let q = query.lowercased()
        var best: (score: Int, length: Int)?
        for name in names {
            let n = name.lowercased()
            let score: Int
            if n == q { score = 400 }
            else if n.hasPrefix(q) { score = 300 }
            else if words(of: name).contains(where: { $0.hasPrefix(q) }) { score = 200 }
            else if n.contains(q) { score = 100 }
            else if inOrder(q, in: n) { score = 50 }
            else { continue }
            if best == nil || score > best!.score || (score == best!.score && name.count < best!.length) { best = (score, name.count) }
        }
        return best
    }

    /// A name's words, lowercased: split at what is not a letter or a digit, and at a camel hump.
    private static func words(of name: String) -> [String] {
        var words: [String] = []
        var word = ""
        var previous: Character?
        for c in name {
            if !(c.isLetter || c.isNumber) {
                if !word.isEmpty { words.append(word.lowercased()) }
                word = ""
            } else {
                if c.isUppercase, let p = previous, p.isLowercase, !word.isEmpty {
                    words.append(word.lowercased())
                    word = ""
                }
                word.append(c)
            }
            previous = c
        }
        if !word.isEmpty { words.append(word.lowercased()) }
        return words
    }

    private static func inOrder(_ query: String, in name: String) -> Bool {
        var rest = Substring(name)
        for c in query {
            guard let at = rest.firstIndex(of: c) else { return false }
            rest = rest[rest.index(after: at)...]
        }
        return true
    }

    /// A teammate's line in the list: that naming it hands it the message, and what it does.
    static func teammateDetail(_ t: Teammate) -> String {
        let role = TeammateWords.role(t.brief)
        return role.isEmpty ? "Gets the message in its own chat" : "Gets the message · \(role)"
    }

    static func skillDetail(_ s: MentionSkill) -> String {
        s.name != s.id ? "\(s.name) — \(s.description)" : s.description
    }

    static func basename(_ rel: String) -> String {
        rel.split(separator: "/").last.map(String.init) ?? rel
    }

    static func directory(_ rel: String) -> String {
        guard let cut = rel.lastIndex(of: "/") else { return "" }
        return String(rel[..<cut])
    }

    /// What picking `row` over `token` puts in the draft, and the caret after it: `@id ` for a skill and
    /// for @Mac; for a teammate or a file, its label and the ref that says what the label names. The
    /// draft shows the label as `@designer`, and Send writes it as the desktop's `@[designer]`
    /// (`wire`); a label with a space in it is written that way at once.
    public static func pick(_ row: MentionRow, in text: String, token: ComposerToken, refs: [MentionRef]) -> (draft: String, caret: Int, ref: MentionRef?) {
        let mention: String
        var ref: MentionRef?
        switch row.kind {
        case .mac(let s), .skill(let s):
            mention = "@\(s.id)"
        case .teammate(let t):
            let label = label(candidates: [t.handle], taken: Set(refs.map(\.label)))
            ref = .role(label: label, roleId: t.id)
            mention = written(label)
        case .file(let f):
            let label = label(candidates: fileLabelCandidates(f.rel), taken: Set(refs.map(\.label)))
            ref = .file(label: label, path: f.path)
            mention = written(label)
        }
        let chars = Array(text)
        let insert = mention + " "
        let draft = String(chars[..<token.start]) + insert + String(chars[min(token.end, chars.count)...])
        return (draft, token.start + insert.count, ref)
    }

    private static func written(_ label: String) -> String {
        label.contains(where: \.isWhitespace) ? "@[\(label)]" : "@\(label)"
    }

    /// A label no other ref in the draft wears, from the best name first, as the desktop's chips do
    /// (`mentionRefLabel`): a file's name, then with its folders, then a number.
    static func label(candidates: [String], taken: Set<String>) -> String {
        let names = candidates.map(chipLabel).filter { !$0.isEmpty }
        if let free = names.first(where: { !taken.contains($0) }) { return free }
        let base = names.first ?? "file"
        for n in 2..<100 {
            let suffix = " \(n)"
            let label = String(base.prefix(labelMax - suffix.count)) + suffix
            if !taken.contains(label) { return label }
        }
        return base
    }

    /// The desktop's `chipLabel`: no brackets, `@` or line breaks, one space at a time, and at most 56
    /// characters.
    static func chipLabel(_ raw: String) -> String {
        let flat = raw.map { "[]@\n\r".contains($0) ? " " : $0 }
        let collapsed = String(flat).split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return collapsed.count > labelMax ? String(collapsed.prefix(labelMax - 1)) + "…" : collapsed
    }

    /// A file's label candidates: its name, then each folder above it added on.
    static func fileLabelCandidates(_ rel: String) -> [String] {
        let parts = rel.split(separator: "/").map(String.init)
        guard !parts.isEmpty else { return [basename(rel)] }
        return (0..<parts.count).reversed().map { parts[$0...].joined(separator: "/") }
    }

    /// The words and refs as the desktop's prompter sends them: each `@label` a ref names becomes its
    /// `@[label]`, and a ref whose label is no longer in the words is dropped, so a teammate deleted
    /// from the draft is not handed the message. An `@label` run on into more of a name —
    /// `@designers` — is not that label.
    public static func wire(_ text: String, refs: [MentionRef]) -> (text: String, refs: [MentionRef]) {
        var out = text
        var live: [MentionRef] = []
        for ref in refs {
            out = bracket(ref.label, in: out)
            if out.contains("@[\(ref.label)]"), !live.contains(where: { $0.label == ref.label }) { live.append(ref) }
        }
        return (out, live)
    }

    private static func bracket(_ label: String, in text: String) -> String {
        let chars = Array(text)
        let mention = Array("@" + label)
        var out: [Character] = []
        var i = 0
        while i < chars.count {
            let opens = i == 0 || chars[i - 1].isWhitespace
            if opens, i + mention.count <= chars.count, Array(chars[i..<i + mention.count]) == mention, ends(chars, at: i + mention.count) {
                out += Array("@[\(label)]")
                i += mention.count
            } else {
                out.append(chars[i])
                i += 1
            }
        }
        return String(out)
    }

    /// Whether a name ends at `i`: the text ends, or what follows is not more of a name. A full stop
    /// ends one only when the sentence does.
    private static func ends(_ chars: [Character], at i: Int) -> Bool {
        guard i < chars.count else { return true }
        let next = chars[i]
        if next == "." { return i + 1 == chars.count || chars[i + 1].isWhitespace }
        return !ComposerToken.isQueryCharacter(next)
    }

    /// The `@[label]` tokens in sent words, by where each is and the label it shows.
    public static func chips(in text: String) -> [(range: Range<String.Index>, label: String)] {
        var found: [(Range<String.Index>, String)] = []
        var cursor = text.startIndex
        while let open = text.range(of: "@[", range: cursor..<text.endIndex) {
            guard let close = text[open.upperBound...].firstIndex(where: { $0 == "]" || $0 == "[" || $0 == "\n" }), text[close] == "]" else {
                cursor = open.upperBound
                continue
            }
            let label = String(text[open.upperBound..<close])
            if !label.isEmpty, label.count <= labelMax { found.append((open.lowerBound..<text.index(after: close), label)) }
            cursor = text.index(after: close)
        }
        return found
    }
}

extension String {
    fileprivate func trimmingLeadingWhitespace() -> String {
        String(drop(while: \.isWhitespace))
    }
}
