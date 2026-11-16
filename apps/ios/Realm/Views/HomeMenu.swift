import RealmKit
import SwiftUI

/// What Home's head says of the Mac's other pages, a quiet line like the one for another profile: the
/// reviews that wait for the person. The scheduled runs not read are counted on the Scheduled card.
/// Nothing where there is nothing, and nothing while a search narrows the list to what matched.
enum WorkHead {
    struct Line: Equatable, Identifiable {
        let page: WorkPage
        let words: String

        var id: WorkPage { page }
    }

    /// Reviews waiting for a decision: those a team has handed back and nobody has sent back yet.
    static func toReview(_ reviews: [ReviewSummary]?) -> Int {
        (reviews ?? []).filter { ReviewStage($0.state) == .waiting }.count
    }

    static func lines(reviews: [ReviewSummary]?, searching: Bool = false) -> [Line] {
        guard !searching else { return [] }
        let review = toReview(reviews)
        return review > 0 ? [Line(page: .reviews, words: "\(review) to review")] : []
    }
}

/// The Mac's pages beyond Home that the phone shows.
enum WorkPage {
    case reviews, scheduled, usage, library, memory

    /// On Home, where the desktop's rail keeps them beside Home: the Library (its Saved turns and its
    /// files), what agents have learned, and the scheduled tasks.
    static let onHome: [WorkPage] = [.library, .memory, .scheduled]
    /// In the Mac's sheet, the rest.
    static let inSettings: [WorkPage] = [.reviews, .usage]

    var title: String {
        switch self {
        case .reviews: "Review"
        case .scheduled: "Scheduled"
        case .usage: "Usage"
        case .library: "Library"
        case .memory: "Memory"
        }
    }

    var symbol: String {
        switch self {
        case .reviews: "tray.full"
        case .scheduled: "calendar.badge.clock"
        case .usage: "gauge.with.needle"
        case .library: "books.vertical"
        case .memory: "text.book.closed"
        }
    }

    var route: Route {
        switch self {
        case .reviews: .reviews
        case .scheduled: .scheduled
        case .usage: .usage
        case .library: .library
        case .memory: .memory
        }
    }

    /// The line a menu item has under its title: what waits on that page, where anything does.
    func note(reviews: [ReviewSummary]?, schedules: [ScheduledTask]?) -> String? {
        switch self {
        case .reviews:
            let count = WorkHead.toReview(reviews)
            return count > 0 ? "\(count) to review" : nil
        case .scheduled:
            let count = ScheduleWords.unreadResults(schedules ?? [])
            return count > 0 ? (count == 1 ? "1 unread result" : "\(count) unread results") : nil
        case .usage, .library, .memory:
            return nil
        }
    }
}

/// Library, Memory and Scheduled at Home's head, a card each with its glyph and its name, side by side
/// and one under another at the accessibility sizes. Scheduled counts its results not read beside its
/// name. The cards rest on the list, so they cast no shadow.
struct HomePlaces: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { places }
            VStack(spacing: 8) { places }
        }
        .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 8, trailing: 16))
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
    }

    private var places: some View {
        ForEach(WorkPage.onHome, id: \.self) { page in
            let unread = page == .scheduled ? ScheduleWords.unreadResults(model.work.schedules ?? []) : 0
            Button {
                model.path.append(page.route)
            } label: {
                PlaceLabel(page: page, unread: unread)
            }
            .buttonStyle(PlaceButtonStyle())
            .accessibilityLabel(PlaceLabel.spoken(page, unread: unread))
            .accessibilityIdentifier("place-\(page)")
        }
    }
}

/// A place's glyph over its name, and beside the name what is new there, in ink.
struct PlaceLabel: View {
    let page: WorkPage
    var unread = 0

    /// "Scheduled", or "Scheduled, 3 new".
    static func spoken(_ page: WorkPage, unread: Int) -> String {
        unread > 0 ? "\(page.title), \(unread) new" : page.title
    }

    var body: some View {
        VStack(spacing: 4) {
            Image(systemName: page.symbol)
                .font(.body)
                .foregroundStyle(Palette.ink2)
                .accessibilityHidden(true)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(page.title)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                if unread > 0 {
                    Text("\(unread)")
                        .font(.subheadline)
                        .monospacedDigit()
                        .lineLimit(1)
                }
            }
            .foregroundStyle(Palette.ink)
        }
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, minHeight: 64)
    }
}

/// A place's card: the card's fill, a step down while pressed, and nothing round it.
private struct PlaceButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Palette.hover : Fill.card,
                        in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
    }
}

/// Home's head lines for Review and Scheduled, under the lines for other profiles.
struct WorkHeadLines: View {
    let searching: Bool
    @Environment(AppModel.self) private var model

    var body: some View {
        ForEach(WorkHead.lines(reviews: model.work.reviews, searching: searching)) { line in
            HeadLine(symbol: line.page.symbol, tone: Palette.ink2, words: line.words) {
                model.path.append(line.page.route)
            }
            .accessibilityHint("Opens \(line.page.title)")
            .accessibilityIdentifier("head-\(line.page)")
        }
    }
}

/// A quiet line at the head of Home: a glyph, what it is about in words, and a chevron, a press from
/// what it names. The glyphs keep one column, so the words of the lines under each other start together.
struct HeadLine: View {
    let symbol: String
    let tone: Color
    let words: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HeadLabel(symbol: symbol, tone: tone, words: words)
        }
        .buttonStyle(.plain)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
    }
}

/// What a head line says: its glyph, its words and its chevron.
struct HeadLabel: View {
    let symbol: String
    var tone: Color = Palette.ink2
    let words: String
    @ScaledMetric(relativeTo: .subheadline) private var glyph: CGFloat = 22

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: symbol)
                .foregroundStyle(tone)
                // The glyph stops growing before the words do, so a line's words keep the width.
                .dynamicTypeSize(...DynamicTypeSize.accessibility1)
                .frame(width: min(glyph, 40))
                .accessibilityHidden(true)
            Text(words)
                .foregroundStyle(Palette.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Palette.ink3)
                .accessibilityHidden(true)
        }
        .font(.subheadline.weight(.medium))
        .contentShape(Rectangle())
    }
}
