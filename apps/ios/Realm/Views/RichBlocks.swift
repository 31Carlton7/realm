import Charts
import RealmMarkdown
import SwiftUI
import UIKit

// The blocks the desktop draws in a reply, drawn on the phone: TeX and Mermaid as pictures from
// BlockDrawer, charts in Swift Charts and comparisons in a grid, each a panel of the transcript like a
// fenced block, sized to what it holds and scrolled sideways when it is wider than the screen.

/// A drawn block's panel: its name in the head where a fenced block names its language, and a copy
/// control for the source it was drawn from.
struct BlockPanel<Content: View, Accessory: View>: View {
    let title: String
    var sub: String?
    let source: String
    @ViewBuilder var accessory: Accessory
    @ViewBuilder var content: Content
    @Environment(\.proseGround) private var ground
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(title)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Palette.ink)
                if let sub {
                    Text(sub)
                        .font(.footnote)
                        .foregroundStyle(Palette.ink3)
                }
            }
            .lineLimit(2)
            .padding(.leading, 14)
            .padding(.trailing, 92)
            .padding(.top, 12)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .topTrailing) {
            HStack(spacing: 0) {
                accessory
                Button {
                    UIPasteboard.general.string = source
                    copied = true
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Palette.ink2)
                        .contentTransition(.symbolEffect(.replace))
                        .touchTarget()
                }
                .buttonStyle(.plain)
                .accessibilityLabel(copied ? "Copied" : "Copy source")
                .sensoryFeedback(.impact(weight: .light), trigger: copied) { _, new in new }
                .task(id: copied) {
                    guard copied else { return }
                    try? await Task.sleep(for: .seconds(2))
                    copied = false
                }
            }
            .padding(.top, 1)
            .padding(.trailing, 2)
        }
        .surface(ground.panel)
        .accessibilityElement(children: .contain)
    }
}

extension BlockPanel where Accessory == EmptyView {
    init(title: String, sub: String? = nil, source: String, @ViewBuilder content: () -> Content) {
        self.init(title: title, sub: sub, source: source, accessory: { EmptyView() }, content: content)
    }
}

// MARK: TeX

/// Display TeX on a line of its own, centred as KaTeX sets it, scrolled sideways when it is wider.
struct MathBlockView: View {
    let tex: String
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 17
    @State private var drawing: BlockDrawing?

    var body: some View {
        let key = BlockDrawer.mathKey(tex, display: true, size: size)
        Group {
            if let image = (BlockDrawer.shared.cached(key) ?? drawing)?.image {
                ViewThatFits(in: .horizontal) {
                    formula(image)
                        .frame(maxWidth: .infinity)
                    ScrollView(.horizontal) { formula(image) }
                        .scrollIndicators(.hidden)
                }
            } else {
                // Until it is drawn, or if it never parses, the TeX as written.
                Text("$$\(tex)$$")
                    .mono(.footnote)
                    .foregroundStyle(drawing == nil ? Palette.ink3 : Palette.orange)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement()
        .accessibilityLabel(tex)
        .task(id: key) {
            drawing = await BlockDrawer.shared.math(tex, display: true, size: size)
        }
    }

    private func formula(_ image: UIImage) -> some View {
        Image(uiImage: image)
            .foregroundStyle(Palette.ink)
            .fixedSize()
    }
}

/// Prose holding inline TeX: each expression a picture set on the sentence's baseline, in the
/// sentence's ink, once drawn — the TeX as written until then.
struct MathProseText: View {
    let text: AttributedString
    let style: Font.TextStyle
    @ScaledMetric(relativeTo: .body) private var bodySize: CGFloat = 17
    @State private var drawn = 0

    private var size: CGFloat { bodySize * RealmType.baseSize(style) / RealmType.baseSize(.body) }

    var body: some View {
        // Read so each expression that lands redraws the line; the pictures come from the cache.
        let _ = drawn
        composed
            .accessibilityLabel(String(text.characters))
            .task(id: text) {
                for run in text.runs {
                    guard let tex = run[InlineMathAttribute.self] else { continue }
                    if BlockDrawer.shared.cached(BlockDrawer.mathKey(tex, display: false, size: size)) != nil { continue }
                    _ = await BlockDrawer.shared.math(tex, display: false, size: size)
                    if Task.isCancelled { return }
                    drawn += 1
                }
            }
    }

    private var composed: Text {
        var line = Text(verbatim: "")
        for run in text.runs {
            let piece: Text
            if let tex = run[InlineMathAttribute.self] {
                if let drawing = BlockDrawer.shared.cached(BlockDrawer.mathKey(tex, display: false, size: size)), let image = drawing.image {
                    piece = Text(Image(uiImage: image)).baselineOffset(-drawing.depth)
                } else {
                    piece = Text(AttributedString(text[run.range])).foregroundStyle(Palette.ink2)
                }
            } else {
                piece = Text(AttributedString(text[run.range]))
            }
            line = Text("\(line)\(piece)")
        }
        return line
    }
}

extension AttributedString {
    var holdsInlineMath: Bool { runs.contains { $0[InlineMathAttribute.self] != nil } }
}

// MARK: Diagrams

/// A ```mermaid block. Until it is drawn it is its code; if Mermaid cannot draw it, it stays code,
/// with Mermaid's reason in the head.
struct DiagramBlockView: View {
    let source: String
    @Environment(\.proseGround) private var ground
    @Environment(\.colorScheme) private var colorScheme
    @State private var drawing: BlockDrawing?
    @State private var width: CGFloat = 0

    var body: some View {
        let colors = DiagramColors(dark: colorScheme == .dark, ground: ground.panel)
        let key = BlockDrawer.diagramKey(source, colors: colors)
        // The face changed under a drawing: it stays up until the new one lands.
        let shown = BlockDrawer.shared.cached(key) ?? drawing
        Group {
            if let shown, let image = shown.image {
                BlockPanel(title: shown.name ?? "Diagram", source: source) {
                    picture(image)
                }
            } else {
                CodeBlockView(language: "mermaid", text: source, reason: shown?.reason.map { "Not drawn — \($0)" })
            }
        }
        .task(id: key) {
            drawing = await BlockDrawer.shared.diagram(source, colors: colors)
        }
    }

    /// At its own size; shrunk to fit down to two thirds of it, and scrolled sideways past that rather
    /// than shrunk into illegibility.
    private func picture(_ image: UIImage) -> some View {
        let natural = image.size
        let room = max(width - 28, 1)
        let shown = natural.width <= room ? natural.width : max(room, natural.width * 2 / 3)
        return ScrollView(.horizontal) {
            Image(uiImage: image)
                .resizable()
                .interpolation(.high)
                .frame(width: shown, height: natural.height * shown / natural.width)
                .padding(.horizontal, 14)
                .padding(.bottom, 14)
        }
        .scrollIndicators(.hidden)
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .accessibilityElement()
        .accessibilityLabel("Diagram")
    }
}

// MARK: Charts

/// A value in a chart's unit, as the desktop writes it (ui-block-model.ts): `exact` beside a bar and
/// in the table, `short` on an axis, where a symbol that is part of the figure stays and a word of a
/// unit is left to the head.
struct ChartUnit {
    let unit: String

    init(_ unit: String?) { self.unit = unit?.trimmingCharacters(in: .whitespaces) ?? "" }

    func exact(_ value: Double) -> String {
        written(value.formatted(.number.precision(.fractionLength(0...2))), value, word: true)
    }

    func short(_ value: Double) -> String {
        written(value.formatted(.number.notation(.compactName).precision(.fractionLength(0...1))), value, word: false)
    }

    private func written(_ text: String, _ value: Double, word: Bool) -> String {
        if unit.isEmpty { return text }
        if ["$", "€", "£", "¥"].contains(unit) { return value < 0 ? "-\(unit)\(text.dropFirst())" : "\(unit)\(text)" }
        if unit == "%" { return "\(text)%" }
        return word ? "\(text) \(unit)" : text
    }
}

enum SeriesPalette {
    static let slots = [Palette.series1, Palette.series2, Palette.series3, Palette.series4,
                        Palette.series5, Palette.series6, Palette.series7, Palette.series8]

    static func color(_ index: Int) -> Color { slots[index % slots.count] }
}

/// A ```realm-chart block: the chart, or its values as a table one tap away — a picture is never the
/// only way to read a number.
struct ChartBlockView: View {
    let chart: ChartBlock
    let source: String
    @State private var asTable = false

    var body: some View {
        BlockPanel(title: chart.title, sub: chart.unit, source: source) {
            Button {
                asTable.toggle()
            } label: {
                Image(systemName: asTable ? "chart.bar.xaxis" : "tablecells")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Palette.ink2)
                    .contentTransition(.symbolEffect(.replace))
                    .touchTarget()
            }
            .buttonStyle(.plain)
            .accessibilityLabel(asTable ? "Show the chart" : "Show the values as a table")
        } content: {
            Group {
                if asTable {
                    ChartValuesTable(chart: chart)
                } else {
                    ChartPlot(chart: chart)
                        .padding(.horizontal, 14)
                }
            }
            .padding(.bottom, 14)
        }
    }
}

/// One drawn value: a point of a series, with the run of reported values it belongs to, so a line
/// breaks at a value nobody reported instead of drawing through it.
private struct ChartPoint: Identifiable {
    let id: String
    let series: String
    let slot: Int
    let label: String
    let value: Double
    let run: String
}

private struct ChartPlot: View {
    let chart: ChartBlock
    @ScaledMetric(relativeTo: .caption) private var plotHeight: CGFloat = 180
    @ScaledMetric(relativeTo: .subheadline) private var barRow: CGFloat = 30

    private var unit: ChartUnit { ChartUnit(chart.unit) }

    private var points: [ChartPoint] {
        let labels = chart.labels
        var out: [ChartPoint] = []
        for (slot, series) in chart.series.enumerated() {
            var run = 0
            for (i, value) in series.values.enumerated() {
                guard let value else { run += 1; continue }
                out.append(ChartPoint(id: "\(slot)-\(i)", series: series.label, slot: slot, label: labels[i], value: value, run: "\(slot)-\(run)"))
            }
        }
        return out
    }

    var body: some View {
        switch chart.kind {
        case .columns: columns
        case .bars: bars
        case .lines: lines
        case .sparkline: sparklines
        }
    }

    private var columns: some View {
        Chart(points) { point in
            BarMark(x: .value("Label", point.label), y: .value("Value", point.value), width: .ratio(0.62))
                .foregroundStyle(by: .value("Series", point.series))
        }
        .chartForegroundStyleScale(domain: chart.series.map(\.label), range: chart.series.indices.map(SeriesPalette.color))
        .chartLegend(chart.series.count > 1 ? .visible : .hidden)
        .modifier(ChartChrome(unit: unit, labels: chart.labels))
        .frame(height: plotHeight)
    }

    private var lines: some View {
        Chart(points) { point in
            LineMark(x: .value("Label", point.label), y: .value("Value", point.value), series: .value("Run", point.run))
                .foregroundStyle(by: .value("Series", point.series))
                .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            if chart.labels.count <= 12 {
                PointMark(x: .value("Label", point.label), y: .value("Value", point.value))
                    .foregroundStyle(by: .value("Series", point.series))
                    .symbolSize(24)
            }
        }
        .chartForegroundStyleScale(domain: chart.series.map(\.label), range: chart.series.indices.map(SeriesPalette.color))
        .chartLegend(chart.series.count > 1 ? .visible : .hidden)
        // Lines are read for their change, not their length from zero.
        .chartYScale(domain: .automatic(includesZero: false))
        .modifier(ChartChrome(unit: unit, labels: chart.labels))
        .frame(height: plotHeight)
    }

    /// One series, so one hue: the label beside each bar already says which bar is which.
    private var bars: some View {
        Chart(points) { point in
            BarMark(x: .value("Value", point.value), y: .value("Label", point.label), height: .ratio(0.6))
                .foregroundStyle(SeriesPalette.color(0))
                .annotation(position: .trailing, spacing: 6) {
                    Text(unit.exact(point.value))
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(Palette.ink2)
                }
        }
        .chartXAxis(.hidden)
        .chartYAxis {
            AxisMarks(position: .leading) { _ in
                AxisValueLabel()
                    .font(.caption)
                    .foregroundStyle(Palette.ink2)
            }
        }
        .chartXScale(range: .plotDimension(endPadding: 56))
        .frame(height: barRow * CGFloat(chart.labels.count))
    }

    private var sparklines: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(chart.series.enumerated()), id: \.offset) { slot, series in
                let seen = series.values.compactMap { $0 }
                HStack(spacing: 12) {
                    Text(series.label)
                        .font(.subheadline)
                        .foregroundStyle(Palette.ink2)
                        .lineLimit(1)
                        .frame(maxWidth: 110, alignment: .leading)
                    Chart(Array(seen.enumerated()), id: \.offset) { i, value in
                        LineMark(x: .value("Point", i), y: .value("Value", value))
                            .foregroundStyle(SeriesPalette.color(slot))
                            .lineStyle(StrokeStyle(lineWidth: 1.75, lineCap: .round, lineJoin: .round))
                    }
                    .chartXAxis(.hidden)
                    .chartYAxis(.hidden)
                    .chartYScale(domain: .automatic(includesZero: false))
                    .frame(height: 26)
                    Text(seen.last.map(unit.exact) ?? "—")
                        .font(.subheadline)
                        .monospacedDigit()
                        .foregroundStyle(Palette.ink)
                }
            }
        }
    }
}

/// The axes in Realm's quiet inks: gridlines and short values up the side, the labels along the
/// bottom, and the plot scrolling sideways when there are more labels than fit.
private struct ChartChrome: ViewModifier {
    let unit: ChartUnit
    let labels: [String]

    func body(content: Content) -> some View {
        content
            .chartYAxis {
                AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { value in
                    AxisGridLine(stroke: StrokeStyle(lineWidth: 1))
                        .foregroundStyle(Palette.chartGrid)
                    AxisValueLabel {
                        if let number = value.as(Double.self) {
                            Text(unit.short(number))
                                .font(.caption2)
                                .monospacedDigit()
                                .foregroundStyle(Palette.ink3)
                        }
                    }
                }
            }
            .chartXAxis {
                AxisMarks { _ in
                    AxisValueLabel()
                        .font(.caption2)
                        .foregroundStyle(Palette.ink2)
                }
            }
            // The labels in the order written: a series with a gap would otherwise move the label it
            // skips to the end, where the next series first reports it.
            .chartXScale(domain: labels)
            .chartScrollableAxes(labels.count > 8 ? .horizontal : [])
            .chartXVisibleDomain(length: min(labels.count, 8))
            // Opened at the present end: the recent part is what the reader came for.
            .chartScrollPosition(initialX: labels[max(0, labels.count - 8)])
            .chartLegend(position: .bottom, alignment: .leading, spacing: 10)
    }
}

/// Every value the chart draws, readable without touching anything.
private struct ChartValuesTable: View {
    let chart: ChartBlock

    var body: some View {
        let unit = ChartUnit(chart.unit)
        let stacked = chart.kind == .columns && chart.series.count > 1
        ScrollView(.horizontal) {
            Grid(alignment: .trailing, horizontalSpacing: 18, verticalSpacing: 8) {
                GridRow {
                    Color.clear.frame(width: 1, height: 1)
                    ForEach(Array(chart.series.enumerated()), id: \.offset) { slot, series in
                        HStack(spacing: 5) {
                            if chart.series.count > 1 {
                                Circle().fill(SeriesPalette.color(slot)).frame(width: 7, height: 7)
                            }
                            Text(series.label)
                        }
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Palette.ink)
                    }
                    if stacked {
                        Text("Total").font(.footnote.weight(.semibold)).foregroundStyle(Palette.ink)
                    }
                }
                ForEach(Array(chart.labels.enumerated()), id: \.offset) { i, label in
                    GridRow {
                        Text(label)
                            .foregroundStyle(Palette.ink2)
                            .gridColumnAlignment(.leading)
                        ForEach(Array(chart.series.enumerated()), id: \.offset) { _, series in
                            Text(series.values[i].map(unit.exact) ?? "—")
                                .foregroundStyle(series.values[i] == nil ? Palette.ink3 : Palette.ink)
                        }
                        if stacked {
                            Text(unit.exact(chart.series.reduce(0) { $0 + ($1.values[i] ?? 0) }))
                                .foregroundStyle(Palette.ink)
                        }
                    }
                    .font(.footnote)
                    .monospacedDigit()
                }
            }
            .padding(.horizontal, 14)
        }
        .scrollIndicators(.hidden)
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
    }
}

// MARK: Comparisons

/// A ```realm-compare block: an option to a column, the recommended one on a raised band with its
/// name said in words over it — never by colour alone, and a surface step rather than the accent,
/// which is for what can be tapped. A column per option stops being readable well before it stops
/// fitting, so a screen too narrow for every column recomposes it into a card per option, as the
/// desktop does in a narrow pane.
struct CompareBlockView: View {
    let compare: CompareBlock
    let source: String

    var body: some View {
        BlockPanel(title: compare.heading, source: source) {
            ViewThatFits(in: .horizontal) {
                table
                cards
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 14)
        }
        .accessibilityLabel(compare.pick.map { "\(compare.heading), recommended: \($0)" } ?? compare.heading)
    }

    private var table: some View {
        let pick = compare.pickIndex
        let last = compare.rows.count - 1
        return Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
                    GridRow(alignment: .bottom) {
                        Color.clear.frame(width: 1, height: 1)
                        ForEach(Array(compare.options.enumerated()), id: \.offset) { i, option in
                            VStack(alignment: .leading, spacing: 2) {
                                if i == pick {
                                    Text("Recommended")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(Palette.ink2)
                                }
                                Text(option)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(Palette.ink)
                            }
                            .cell(picked: i == pick, edge: .top)
                        }
                    }
                    ForEach(Array(compare.rows.enumerated()), id: \.offset) { r, row in
                        GridRow {
                            Text(row.label)
                                .font(.subheadline)
                                .foregroundStyle(Palette.ink2)
                                .frame(minWidth: 84, maxWidth: 140, alignment: .leading)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.vertical, 9)
                                .padding(.trailing, 6)
                            ForEach(Array(row.values.enumerated()), id: \.offset) { i, value in
                                Text(value ?? "—")
                                    .font(.subheadline)
                                    .foregroundStyle(value == nil ? Palette.ink3 : Palette.ink)
                                    .cell(picked: i == pick, edge: r == last ? .bottom : nil)
                            }
                        }
                        .overlay(alignment: .top) {
                            Rectangle().fill(Palette.divider).frame(height: 1).opacity(r == 0 ? 1 : 0.6)
                        }
                    }
                }
    }

    /// An option to a card, each row its label and that option's value, the pick on the band's surface.
    private var cards: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(compare.options.enumerated()), id: \.offset) { i, option in
                let picked = i == compare.pickIndex
                VStack(alignment: .leading, spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        if picked {
                            Text("Recommended")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(Palette.ink2)
                        }
                        Text(option)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Palette.ink)
                    }
                    ForEach(Array(compare.rows.enumerated()), id: \.offset) { _, row in
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            Text(row.label)
                                .foregroundStyle(Palette.ink2)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Text(row.values[i] ?? "—")
                                .foregroundStyle(row.values[i] == nil ? Palette.ink3 : Palette.ink)
                                .multilineTextAlignment(.trailing)
                                .monospacedDigit()
                        }
                        .font(.subheadline)
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(picked ? Palette.hover2 : Palette.hover, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .accessibilityElement(children: .combine)
            }
        }
    }
}

private struct CompareCell: ViewModifier {
    let picked: Bool
    let edge: VerticalEdge?

    func body(content: Content) -> some View {
        let radius: CGFloat = 10
        content
            .monospacedDigit()
            .frame(minWidth: 96, maxWidth: 180, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 10)
            .padding(.vertical, 9)
            .frame(maxHeight: .infinity, alignment: edge == .top ? .bottomLeading : .topLeading)
            .background {
                if picked {
                    UnevenRoundedRectangle(topLeadingRadius: edge == .top ? radius : 0, bottomLeadingRadius: edge == .bottom ? radius : 0,
                                           bottomTrailingRadius: edge == .bottom ? radius : 0, topTrailingRadius: edge == .top ? radius : 0,
                                           style: .continuous)
                        .fill(Palette.hover2)
                }
            }
    }
}

private extension View {
    func cell(picked: Bool, edge: VerticalEdge?) -> some View {
        modifier(CompareCell(picked: picked, edge: edge))
    }
}
