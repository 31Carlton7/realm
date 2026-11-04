import Foundation

/// TeX in an agent's prose, found before the Markdown parser sees it, with the desktop's four
/// delimiters and its guards (`apps/desktop/src/renderer/src/panes/session/rich/math.ts`): `$…$` and
/// `\(…\)` inline, `$$…$$` and `\[…\]` display.
///
/// It has to come first: cmark reads `a_1 + b_1` as emphasis and `\(` as an escaped parenthesis, so
/// each expression is swapped for a placeholder the parser passes through as text, and put back as
/// math where the placeholder lands. Fenced code and code spans are skipped, as the desktop's own
/// tokenizers consume them before its math extension runs.
struct MathSpans {
    struct Span {
        let tex: String
        let display: Bool
        /// The expression as written, delimiters and all, for anywhere a placeholder lands that is
        /// not prose: an indented code block, raw HTML, a link's address.
        let source: String
    }

    static let open: Character = "\u{E000}"
    static let close: Character = "\u{E001}"

    private(set) var spans: [Span] = []

    /// `source` with every expression swapped for its placeholder.
    mutating func mask(_ source: String) -> String {
        var masked = ""
        var prose: [Substring] = []
        var fence: (character: Character, length: Int)?
        func flushProse() {
            if prose.isEmpty { return }
            masked += maskProse(prose.joined(separator: "\n"))
            masked += "\n"
            prose.removeAll()
        }
        for line in source.split(separator: "\n", omittingEmptySubsequences: false) {
            if let open = fence {
                masked += line + "\n"
                if Self.closesFence(line, character: open.character, length: open.length) { fence = nil }
            } else if let opened = Self.opensFence(line) {
                flushProse()
                masked += line + "\n"
                fence = opened
            } else {
                prose.append(line)
            }
        }
        flushProse()
        return String(masked.dropLast())
    }

    /// Placeholders in `text` back to the expressions they stand for.
    func restore(_ text: String) -> String {
        guard text.contains(Self.open) else { return text }
        var out = ""
        for piece in pieces(text) {
            switch piece {
            case .text(let part): out += part
            case .math(let span): out += span.source
            }
        }
        return out
    }

    enum Piece {
        case text(String)
        case math(Span)
    }

    /// Text split at its placeholders.
    func pieces(_ text: String) -> [Piece] {
        guard text.contains(Self.open) else { return [.text(text)] }
        var out: [Piece] = []
        var plain = ""
        var rest = Substring(text)
        while let start = rest.firstIndex(of: Self.open) {
            plain += rest[..<start]
            let afterOpen = rest.index(after: start)
            guard let end = rest[afterOpen...].firstIndex(of: Self.close), let index = Int(rest[afterOpen..<end]), spans.indices.contains(index) else {
                plain.append(Self.open)
                rest = rest[afterOpen...]
                continue
            }
            if !plain.isEmpty { out.append(.text(plain)) }
            plain = ""
            out.append(.math(spans[index]))
            rest = rest[rest.index(after: end)...]
        }
        plain += rest
        if !plain.isEmpty { out.append(.text(plain)) }
        return out
    }

    // MARK: Finding expressions

    private mutating func maskProse(_ text: String) -> String {
        let chars = Array(text)
        var out = ""
        var i = 0
        while i < chars.count {
            let c = chars[i]
            if c == "\\", i + 1 < chars.count {
                let next = chars[i + 1]
                if next == "(" || next == "[", let end = Self.find(next == "(" ? "\\)" : "\\]", in: chars, from: i + 2) {
                    let tex = String(chars[(i + 2)..<end]).trimmingCharacters(in: .whitespacesAndNewlines)
                    if !tex.isEmpty {
                        out += placeholder(tex: tex, display: next == "[", source: String(chars[i..<(end + 2)]))
                        i = end + 2
                        continue
                    }
                }
                out.append(c)
                out.append(next)
                i += 2
            } else if c == "`" {
                // A code span: a run of backticks to the next run of the same length. A run with no
                // partner is literal backticks.
                let run = Self.run(of: "`", in: chars, at: i)
                if let end = Self.closingRun(length: run, in: chars, from: i + run) {
                    out += String(chars[i..<(end + run)])
                    i = end + run
                } else {
                    out += String(repeating: "`", count: run)
                    i += run
                }
            } else if c == "$", i + 1 < chars.count, chars[i + 1] == "$" {
                if let end = Self.find("$$", in: chars, from: i + 2) {
                    let tex = String(chars[(i + 2)..<end]).trimmingCharacters(in: .whitespacesAndNewlines)
                    if !tex.isEmpty {
                        out += placeholder(tex: tex, display: true, source: String(chars[i..<(end + 2)]))
                        i = end + 2
                        continue
                    }
                }
                out += "$$"
                i += 2
            } else if c == "$", let end = Self.inlineDollarEnd(chars, opener: i) {
                out += placeholder(tex: String(chars[(i + 1)..<end]).trimmingCharacters(in: .whitespacesAndNewlines),
                                   display: false, source: String(chars[i...end]))
                i = end + 1
            } else {
                out.append(c)
                i += 1
            }
        }
        return out
    }

    /// Where a `$…$` that opens at `opener` closes, under the desktop's guards: nothing blank just
    /// inside either dollar, so "costs $5, sells for $9" is not one expression across the comma; no
    /// digit straight after the closer, so "$5 and $10" is not one either; and no blank line inside.
    /// A `$` that fails them is the literal character it almost always is.
    static func inlineDollarEnd(_ chars: [Character], opener: Int) -> Int? {
        let first = opener + 1
        guard first < chars.count, !chars[first].isWhitespace, chars[first] != "$" else { return nil }
        var i = first
        while i < chars.count {
            let c = chars[i]
            if c == "\\" { i += 2; continue }
            if c == "\n", i + 1 < chars.count, chars[i + 1] == "\n" { return nil }
            if c == "$" {
                let before = chars[i - 1]
                if before.isWhitespace || before == "\\" { return nil }
                if i + 1 < chars.count, chars[i + 1].isNumber { return nil }
                return i
            }
            i += 1
        }
        return nil
    }

    private mutating func placeholder(tex: String, display: Bool, source: String) -> String {
        spans.append(Span(tex: tex, display: display, source: source))
        return "\(Self.open)\(spans.count - 1)\(Self.close)"
    }

    private static func find(_ needle: String, in chars: [Character], from start: Int) -> Int? {
        let target = Array(needle)
        guard start <= chars.count - target.count else { return nil }
        for i in start...(chars.count - target.count) where Array(chars[i..<(i + target.count)]) == target {
            return i
        }
        return nil
    }

    private static func run(of character: Character, in chars: [Character], at start: Int) -> Int {
        var end = start
        while end < chars.count, chars[end] == character { end += 1 }
        return end - start
    }

    private static func closingRun(length: Int, in chars: [Character], from start: Int) -> Int? {
        var i = start
        while i < chars.count {
            if chars[i] == "`" {
                let run = run(of: "`", in: chars, at: i)
                if run == length { return i }
                i += run
            } else {
                i += 1
            }
        }
        return nil
    }

    // MARK: Fences

    /// A fence's opening line — inside a list item too — and its character and length.
    static func opensFence(_ line: Substring) -> (character: Character, length: Int)? {
        var rest = line.drop { $0 == " " || $0 == "\t" }
        if let marker = rest.first, "-*+".contains(marker), rest.dropFirst().first == " " {
            rest = rest.dropFirst(2).drop { $0 == " " }
        } else {
            let digits = rest.prefix { $0.isASCII && $0.isNumber }
            let after = rest.dropFirst(digits.count)
            if !digits.isEmpty, let mark = after.first, mark == "." || mark == ")", after.dropFirst().first == " " {
                rest = after.dropFirst(2).drop { $0 == " " }
            }
        }
        guard let character = rest.first, character == "`" || character == "~" else { return nil }
        let length = rest.prefix { $0 == character }.count
        guard length >= 3 else { return nil }
        // A backtick fence's info string cannot hold a backtick; that line is a code span.
        if character == "`", rest.dropFirst(length).contains("`") { return nil }
        return (character, length)
    }

    static func closesFence(_ line: Substring, character: Character, length: Int) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return trimmed.count >= length && trimmed.allSatisfy { $0 == character }
    }
}
