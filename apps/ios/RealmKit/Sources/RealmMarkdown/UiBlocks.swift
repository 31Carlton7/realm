import Foundation

/// The blocks an agent writes and Realm draws — ```mermaid, ```realm-chart and ```realm-compare — held
/// to the desktop's rules (`packages/contracts/src/ui-blocks.ts`): the same fences, limits and schema,
/// and the same one-line reason beside the code when a body is not a block.
public enum UiBlocks {
    public enum Kind: String, Hashable, Sendable {
        case diagram, chart, compare
    }

    /// The block a fence's info string asks for: its first word, in any case.
    public static func kind(info: String?) -> Kind? {
        let word = (info ?? "").split(whereSeparator: \.isWhitespace).first?.lowercased() ?? ""
        switch word {
        case "mermaid": return .diagram
        case "realm-chart": return .chart
        case "realm-compare": return .compare
        default: return nil
        }
    }

    public static let sourceMax = 20_000
    public static let diagramLinesMax = 300
    public static let chartSeriesMax = 8
    public static let chartPointsMax = 60
    public static let compareOptionsMax = 6
    public static let compareRowsMax = 30

    /// The two ways a diagram's text makes Mermaid load a picture: a shape's `img` and a sequence
    /// participant's icon. Nothing a block draws may fetch anything.
    static let diagramPictures = [#"@\{[^}]*\bimg\b["']?\s*:"#, #"(?m)^\s*properties\b[^\n]*\bicon\b"#]

    /// A fence's body as the block it asks for, or the reason it stays code.
    public static func parse(_ kind: Kind, _ source: String) -> Result<MarkdownBlock, Failure> {
        let body = source.trimmingCharacters(in: .whitespacesAndNewlines)
        if body.isEmpty { return .failure(Failure("the block is empty")) }
        if source.count > sourceMax { return .failure(Failure("longer than the 20,000 characters Realm draws")) }
        switch kind {
        case .diagram:
            let lines = body.split(separator: "\n", omittingEmptySubsequences: false).count
            if lines > diagramLinesMax { return .failure(Failure("\(lines) lines, past the \(diagramLinesMax) Realm draws")) }
            if diagramPictures.contains(where: { body.range(of: $0, options: [.regularExpression, .caseInsensitive]) != nil }) {
                return .failure(Failure("it draws a picture from a link, and a diagram here is drawn from its own text alone"))
            }
            return .success(.diagram(body))
        case .chart, .compare:
            let json: Any
            do {
                json = try JSONSerialization.jsonObject(with: Data(body.utf8), options: [.fragmentsAllowed])
            } catch {
                return .failure(Failure("not JSON: \(jsonError(error))"))
            }
            do {
                return .success(kind == .chart ? .chart(try ChartBlock(json: json), source: body) : .comparison(try CompareBlock(json: json), source: body))
            } catch let failure as Failure {
                return .failure(failure)
            } catch {
                return .failure(Failure("not a block Realm draws"))
            }
        }
    }

    public struct Failure: Error, Hashable, Sendable {
        public let reason: String
        init(_ reason: String) { self.reason = reason }
    }

    private static func jsonError(_ error: Error) -> String {
        let description = (error as NSError).userInfo[NSDebugDescriptionErrorKey] as? String ?? error.localizedDescription
        return description.split(separator: "\n").first.map(String.init) ?? "it does not parse"
    }
}

/// A ```realm-chart body. Series take the palette's slots in the order written.
public struct ChartBlock: Hashable, Sendable {
    public enum Kind: String, Hashable, Sendable { case columns, bars, lines, sparkline }

    public struct Series: Hashable, Sendable {
        public let label: String
        /// One per x label. Nil is a value nobody reported, drawn as a gap rather than as a zero.
        public let values: [Double?]
    }

    public let kind: Kind
    public let title: String
    /// Said after each value: "412 KB", "18%".
    public let unit: String?
    public let x: [String]?
    public let series: [Series]

    /// The labels the chart is read against: its x labels, or the points counted for a sparkline.
    public var labels: [String] {
        x ?? (0..<(series.first?.values.count ?? 0)).map { String($0 + 1) }
    }
}

/// A ```realm-compare body: options side by side, row by row, with the recommended one named.
public struct CompareBlock: Hashable, Sendable {
    public struct Row: Hashable, Sendable {
        public let label: String
        /// One per option; nil is a cell with nothing to say.
        public let values: [String?]
    }

    public let title: String?
    public let options: [String]
    public let rows: [Row]
    public let pick: String?

    /// Its name when it was given none: the question it answers.
    public var heading: String {
        if let title { return title }
        if options.count == 2 { return "\(options[0]) or \(options[1])" }
        return "\(options.dropLast().joined(separator: ", ")) or \(options.last ?? "")"
    }

    public var pickIndex: Int? { pick.flatMap { options.firstIndex(of: $0) } }
}

// MARK: Reading the JSON

/// A JSON value at a place in the body, read the way the desktop's zod schema reads it, failing with
/// the desktop's words: where, then what ("series 2, label: empty").
private struct Field {
    let value: Any?
    let path: [String]

    var place: String { path.isEmpty ? "the block" : path.joined(separator: ", ") }
    func fail(_ what: String) -> UiBlocks.Failure { UiBlocks.Failure("\(place): \(what)") }

    subscript(key: String) -> Field { Field(value: (value as? [String: Any])?[key] ?? nil, path: path + [key]) }
    /// A list's member, named by its place in the list in place of the list's key: "series 2", not
    /// "series, series 2".
    func at(_ index: Int, _ member: String) -> Field { Field(value: (value as? [Any])?[index], path: path.dropLast() + ["\(member) \(index + 1)"]) }

    var isMissing: Bool { value == nil || value is NSNull }

    func object() throws -> Field {
        guard value is [String: Any] else { throw fail(isMissing ? "missing" : "expected object, received \(Self.typeName(value))") }
        return self
    }

    func text(max: Int) throws -> String {
        guard let string = value as? String else { throw fail(isMissing && !(value is NSNull) ? "missing" : "not text") }
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { throw fail("empty") }
        if trimmed.count > max { throw fail("longer than \(max) characters") }
        return trimmed
    }

    func optionalText(max: Int) throws -> String? { value == nil ? nil : try text(max: max) }

    func array(min: Int, max: Int, member: String, plural: String, tooFew: String) throws -> [Field] {
        guard let items = value as? [Any] else { throw fail(isMissing && !(value is NSNull) ? "missing" : "expected array, received \(Self.typeName(value))") }
        if items.count < min { throw fail(tooFew) }
        if items.count > max { throw fail("more than \(max) \(plural)") }
        return items.indices.map { at($0, member) }
    }

    /// A finite number or null.
    func optionalNumber() throws -> Double? {
        if value is NSNull { return nil }
        guard let number = value as? NSNumber, !Self.isBool(number) else { throw fail("expected number, received \(Self.typeName(value))") }
        guard number.doubleValue.isFinite else { throw fail("not finite") }
        return number.doubleValue
    }

    static func isBool(_ number: NSNumber) -> Bool { CFGetTypeID(number) == CFBooleanGetTypeID() }

    static func typeName(_ value: Any?) -> String {
        switch value {
        case nil: "undefined"
        case is NSNull: "null"
        case let number as NSNumber: isBool(number) ? "boolean" : "number"
        case is String: "string"
        case is [Any]: "array"
        default: "object"
        }
    }

    /// A number as JavaScript's `String(n)` writes it: no ".0" on a whole one.
    static func written(_ number: Double) -> String {
        if number == number.rounded(), abs(number) < 1e15 { return String(Int64(number)) }
        return String(number)
    }
}

extension ChartBlock {
    init(json: Any) throws {
        let root = try Field(value: json, path: []).object()
        let kindField = root["kind"]
        guard let raw = kindField.value as? String, let kind = Kind(rawValue: raw) else {
            throw kindField.fail(kindField.isMissing ? "missing" : "not columns, bars, lines or sparkline")
        }
        let title = try root["title"].text(max: 120)
        var unit: String?
        if let value = root["unit"].value, !(value is NSNull) {
            guard let string = value as? String else { throw root["unit"].fail("expected string, received \(Field.typeName(value))") }
            let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.count > 16 { throw root["unit"].fail("longer than 16 characters") }
            unit = trimmed.isEmpty ? nil : trimmed
        }
        var x: [String]?
        if root["x"].value != nil {
            x = try root["x"].array(min: 1, max: UiBlocks.chartPointsMax, member: "x label", plural: "labels", tooFew: "no labels").map { label in
                if let number = label.value as? NSNumber, !Field.isBool(number) { return Field.written(number.doubleValue) }
                return try label.text(max: 40)
            }
        }
        let series = try root["series"].array(min: 1, max: UiBlocks.chartSeriesMax, member: "series", plural: "series", tooFew: "no series").map { entry in
            let item = try entry.object()
            let label = try item["label"].text(max: 60)
            let values = try item["values"].array(min: 1, max: UiBlocks.chartPointsMax, member: "value", plural: "values", tooFew: "no values")
                .map { try $0.optionalNumber() }
            return Series(label: label, values: values)
        }

        if x == nil, kind != .sparkline { throw UiBlocks.Failure("\(kind.rawValue) need x labels") }
        let count = x?.count ?? series.first?.values.count ?? 0
        var seen = Set<String>()
        for entry in series {
            if entry.values.count != count {
                throw UiBlocks.Failure("\"\(entry.label)\" has \(entry.values.count) values for \(count) \(x == nil ? "points" : "x labels")")
            }
            if !seen.insert(entry.label).inserted { throw UiBlocks.Failure("two series are both called \"\(entry.label)\"") }
            if kind == .columns || kind == .bars, entry.values.contains(where: { ($0 ?? 0) < 0 }) {
                throw UiBlocks.Failure("\"\(entry.label)\" has a negative value, and \(kind.rawValue) start at zero — lines can go below it")
            }
        }
        if kind == .bars, series.count > 1 { throw UiBlocks.Failure("bars take one series — columns or lines take several") }
        if series.allSatisfy({ $0.values.allSatisfy { $0 == nil } }) { throw UiBlocks.Failure("every value is null, so there is nothing to draw") }

        self.init(kind: kind, title: title, unit: unit, x: x, series: series)
    }
}

extension CompareBlock {
    init(json: Any) throws {
        let root = try Field(value: json, path: []).object()
        let title = try root["title"].optionalText(max: 120)
        let options = try root["options"].array(min: 2, max: UiBlocks.compareOptionsMax, member: "option", plural: "options", tooFew: "fewer than two options")
            .map { try $0.text(max: 60) }
        let rows = try root["rows"].array(min: 1, max: UiBlocks.compareRowsMax, member: "row", plural: "rows", tooFew: "no rows").map { entry in
            let row = try entry.object()
            let label = try row["label"].text(max: 80)
            let values = try row["values"].array(min: 0, max: .max, member: "value", plural: "values", tooFew: "").map(Self.cell)
            return Row(label: label, values: values)
        }
        var pick: String?
        if let value = root["pick"].value, !(value is NSNull) {
            guard let string = value as? String else { throw root["pick"].fail("expected string, received \(Field.typeName(value))") }
            let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { throw root["pick"].fail("empty") }
            pick = trimmed
        }

        if Set(options).count != options.count { throw UiBlocks.Failure("two options have the same name") }
        for row in rows where row.values.count != options.count {
            throw UiBlocks.Failure("\"\(row.label)\" has \(row.values.count) values for \(options.count) options")
        }
        if let pick, !options.contains(pick) { throw UiBlocks.Failure("the pick, \"\(pick)\", is not one of the options") }

        self.init(title: title, options: options, rows: rows, pick: pick)
    }

    /// A cell is text; a number or a yes/no reads as one, and null or blank says nothing.
    private static func cell(_ field: Field) throws -> String? {
        switch field.value {
        case is NSNull:
            return nil
        case let number as NSNumber:
            if Field.isBool(number) { return number.boolValue ? "Yes" : "No" }
            guard number.doubleValue.isFinite else { throw field.fail("not text") }
            return Field.written(number.doubleValue)
        case let string as String:
            if string.count > 280 { throw field.fail("longer than 280 characters") }
            let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        default:
            throw field.fail("not text")
        }
    }
}
