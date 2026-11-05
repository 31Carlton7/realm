import Foundation

/// How a piece of a terminal's output is drawn: its colours and weight, as its SGR escapes set them.
public struct TerminalStyle: Hashable, Sendable {
    /// A colour a program named: one of the 256 by number (0–15 are the palette's sixteen), or its own.
    public enum Color: Hashable, Sendable {
        case indexed(Int)
        case rgb(UInt8, UInt8, UInt8)
    }

    public var foreground: Color?
    public var background: Color?
    public var bold = false
    public var dim = false
    public var italic = false
    public var underline = false
    public var inverse = false

    public init(foreground: Color? = nil, background: Color? = nil, bold: Bool = false, dim: Bool = false,
                italic: Bool = false, underline: Bool = false, inverse: Bool = false) {
        self.foreground = foreground
        self.background = background
        self.bold = bold
        self.dim = dim
        self.italic = italic
        self.underline = underline
        self.inverse = inverse
    }

    public static let plain = TerminalStyle()
}

/// A stretch of one line in one style.
public struct TerminalRun: Hashable, Sendable {
    public var text: String
    public var style: TerminalStyle

    public init(_ text: String, _ style: TerminalStyle = .plain) {
        self.text = text
        self.style = style
    }
}

/// One line of a terminal's output. Its id stays with it as lines above it are let go.
public struct TerminalLine: Hashable, Sendable, Identifiable {
    public let id: Int
    public var runs: [TerminalRun]

    public var text: String { runs.map(\.text).joined() }
}

/**
 A terminal's output made into lines of styled text, fed as it arrives (`session.terminal`), for a phone
 to draw rather than emulate. It follows what a shell and the tools run in it print: text, colours and
 weights (SGR, the sixteen, the 256 and true colour), carriage returns that write a line over (a progress
 bar), backspaces, tabs, erasing a line, and clearing the screen. Everything else an escape asks — moving
 the cursor up, scrolling regions, titles, hyperlinks — is read past and dropped, so a full-screen program
 draws as its text without its layout. An escape cut in two between feeds is joined up again.
 */
public struct TerminalText: Sendable {
    /// The most lines kept: the oldest go first.
    public let maxLines: Int
    public private(set) var finished: [TerminalLine] = []
    private var cells: [(Character, TerminalStyle)] = []
    private var column = 0
    private var style = TerminalStyle.plain
    private var nextId = 0
    private var state = State.ground

    private enum State: Sendable {
        case ground
        case escape
        /// An escape's intermediate bytes before its final one (`ESC ( B`).
        case escapeIntermediate
        case csi(String)
        /// An operating-system command (`ESC ]`): a title, a link, a colour. Ends with BEL or `ESC \`.
        case osc
        case oscEscape
    }

    public init(maxLines: Int = 2_000) {
        self.maxLines = maxLines
    }

    /// Every line, the one being written last, while it has anything on it.
    public var lines: [TerminalLine] {
        cells.isEmpty ? finished : finished + [TerminalLine(id: nextId, runs: Self.runs(cells))]
    }

    /// Lets go of everything, as for output read again from the top.
    public mutating func reset() {
        self = TerminalText(maxLines: maxLines)
    }

    public mutating func feed(_ text: String) {
        for character in text { take(character) }
    }

    private mutating func take(_ c: Character) {
        switch state {
        case .ground:
            switch c {
            case "\u{1B}": state = .escape
            case "\r\n", "\n": newLine()
            case "\r": column = 0
            case "\u{08}": column = max(0, column - 1)
            case "\t": put(" ", count: 8 - column % 8)
            case "\u{07}": break
            default:
                // C0 controls draw nothing; DEL neither.
                if let scalar = c.unicodeScalars.first, c.unicodeScalars.count == 1, scalar.value < 0x20 || scalar.value == 0x7F { break }
                put(c)
            }
        case .escape:
            switch c {
            case "[": state = .csi("")
            case "]": state = .osc
            case "c": clear(); state = .ground
            default:
                if let v = c.asciiValue, (0x20...0x2F).contains(v) { state = .escapeIntermediate } else { state = .ground }
            }
        case .escapeIntermediate:
            if let v = c.asciiValue, (0x20...0x2F).contains(v) { break }
            state = .ground
        case .csi(let params):
            guard let v = c.asciiValue else { state = .ground; return }
            if (0x40...0x7E).contains(v) {
                state = .ground
                control(c, params)
            } else {
                state = .csi(params + String(c))
            }
        case .osc:
            if c == "\u{07}" { state = .ground } else if c == "\u{1B}" { state = .oscEscape }
        case .oscEscape:
            state = c == "\\" ? .ground : .osc
        }
    }

    /// A control sequence's final byte, with its parameters.
    private mutating func control(_ final: Character, _ params: String) {
        // A private sequence (`ESC [ ? 25 l`, show or hide the cursor) changes nothing drawn.
        if params.first.map({ "<=>?".contains($0) }) == true { return }
        let numbers = params.split(separator: ";", omittingEmptySubsequences: false).map { Int($0) }
        let first = numbers.first.flatMap { $0 } ?? 0
        switch final {
        case "m": select(params.isEmpty ? [0] : numbers.map { $0 ?? 0 })
        case "K":
            switch first {
            case 1: for i in 0..<min(column + 1, cells.count) { cells[i] = (" ", style) }
            case 2: cells.removeAll()
            default: if column < cells.count { cells.removeSubrange(column...) }
            }
        case "J": if first == 2 || first == 3 { clear() }
        case "C": column += max(1, first)
        case "D": column = max(0, column - max(1, first))
        case "G": column = max(0, first - 1)
        default: break
        }
    }

    /// Select Graphic Rendition: each parameter in turn, 38 and 48 taking the colour after them.
    private mutating func select(_ codes: [Int]) {
        var i = 0
        while i < codes.count {
            let code = codes[i]
            switch code {
            case 0: style = .plain
            case 1: style.bold = true
            case 2: style.dim = true
            case 3: style.italic = true
            case 4: style.underline = true
            case 7: style.inverse = true
            case 22: style.bold = false; style.dim = false
            case 23: style.italic = false
            case 24: style.underline = false
            case 27: style.inverse = false
            case 30...37: style.foreground = .indexed(code - 30)
            case 39: style.foreground = nil
            case 40...47: style.background = .indexed(code - 40)
            case 49: style.background = nil
            case 90...97: style.foreground = .indexed(code - 90 + 8)
            case 100...107: style.background = .indexed(code - 100 + 8)
            case 38, 48:
                var color: TerminalStyle.Color?
                if i + 2 < codes.count, codes[i + 1] == 5 {
                    color = .indexed(min(255, max(0, codes[i + 2])))
                    i += 2
                } else if i + 4 < codes.count, codes[i + 1] == 2 {
                    let byte = { (n: Int) in UInt8(min(255, max(0, n))) }
                    color = .rgb(byte(codes[i + 2]), byte(codes[i + 3]), byte(codes[i + 4]))
                    i += 4
                }
                if code == 38 { style.foreground = color } else { style.background = color }
            default: break
            }
            i += 1
        }
    }

    private mutating func put(_ c: Character, count: Int = 1) {
        for _ in 0..<count {
            if column < cells.count {
                cells[column] = (c, style)
            } else {
                while cells.count < column { cells.append((" ", .plain)) }
                cells.append((c, style))
            }
            column += 1
        }
    }

    private mutating func newLine() {
        finished.append(TerminalLine(id: nextId, runs: Self.runs(cells)))
        nextId += 1
        cells.removeAll()
        column = 0
        if finished.count > maxLines { finished.removeFirst(finished.count - maxLines) }
    }

    private mutating func clear() {
        finished.removeAll()
        cells.removeAll()
        column = 0
        nextId += 1
    }

    private static func runs(_ cells: [(Character, TerminalStyle)]) -> [TerminalRun] {
        var runs: [TerminalRun] = []
        for (c, style) in cells {
            if let last = runs.last, last.style == style {
                runs[runs.count - 1].text.append(c)
            } else {
                runs.append(TerminalRun(String(c), style))
            }
        }
        return runs
    }
}
