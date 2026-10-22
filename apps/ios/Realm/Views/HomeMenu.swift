import RealmKit
import SwiftUI

/// What Home's head says of the Mac's other pages, each a quiet line like the one for another profile:
/// the reviews that wait for the person, and the scheduled runs that finished and were not read.
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

    static func lines(reviews: [ReviewSummary]?, schedules: [ScheduledTask]?, searching: Bool = false) -> [Line] {
        guard !searching else { return [] }
        let review = toReview(reviews)
        let results = ScheduleWords.unreadResults(schedules ?? [])
        return (review > 0 ? [Line(page: .reviews, words: "\(review) to review")] : [])
            + (results > 0 ? [Line(page: .scheduled, words: ScheduleWords.results(results))] : [])
    }
}

/// The Mac's pages beyond Home that the phone shows, as the bar's menu offers them.
enum WorkPage: CaseIterable {
    case reviews, scheduled, usage

    var title: String {
        switch self {
        case .reviews: "Review"
        case .scheduled: "Scheduled"
        case .usage: "Usage"
        }
    }

    var symbol: String {
        switch self {
        case .reviews: "tray.full"
        case .scheduled: "calendar.badge.clock"
        case .usage: "gauge.with.needle"
        }
    }

    var route: Route {
        switch self {
        case .reviews: .reviews
        case .scheduled: .scheduled
        case .usage: .usage
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
        case .usage:
            return nil
        }
    }
}

/// Home's one button in the top bar: Review, with how many wait there, Scheduled, Usage, then
/// Settings. One menu rather than a button for each, since a third button in the bar makes iOS fold
/// them all into a More menu of its own. Its glyph is the ellipsis, not a person: the title already
/// switches profiles, and a person's outline beside it would read as a second way to. A Mac older than
/// these pages leaves Settings alone there, as the gear it was.
struct HomeMenu: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.work.unsupported {
            Button {
                model.settingsShown = true
            } label: {
                Label("Settings", systemImage: "gearshape")
            }
            .accessibilityIdentifier("settings")
        } else {
            Menu {
                Section {
                    ForEach(WorkPage.allCases, id: \.self) { page in
                        Button {
                            model.path.append(page.route)
                        } label: {
                            Label(page.title, systemImage: page.symbol)
                            if let note = page.note(reviews: model.work.reviews, schedules: model.work.schedules) { Text(note) }
                        }
                    }
                }
                Section {
                    Button {
                        model.settingsShown = true
                    } label: {
                        Label("Settings", systemImage: "gearshape")
                    }
                }
            } label: {
                Label("More", systemImage: "ellipsis.circle")
            }
            .accessibilityIdentifier("home-menu")
        }
    }
}

/// Home's head lines for Review and Scheduled, under the lines for other profiles.
struct WorkHeadLines: View {
    let searching: Bool
    @Environment(AppModel.self) private var model

    var body: some View {
        ForEach(WorkHead.lines(reviews: model.work.reviews, schedules: model.work.schedules, searching: searching)) { line in
            HeadLine(symbol: line.page.symbol, tone: Palette.ink2, words: line.words) {
                model.path.append(line.page.route)
            }
            .accessibilityHint("Opens \(line.page.title)")
            .accessibilityIdentifier("head-\(line.page)")
        }
    }
}

/// A quiet line at the head of Home: a glyph, what it is about in words, and a chevron, a press from
/// what it names.
struct HeadLine: View {
    let symbol: String
    let tone: Color
    let words: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: symbol)
                    .foregroundStyle(tone)
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
        .buttonStyle(.plain)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
    }
}
