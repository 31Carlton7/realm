import SwiftUI

/// Which of Home's sessions the list holds, as Manus's chips choose: all of them, only what waits on
/// the person, or only what they pinned.
enum HomeFilter: Hashable, CaseIterable {
    case all, needsYou, pinned

    var title: String {
        switch self {
        case .all: "All"
        case .needsYou: "Needs you"
        case .pinned: "Pinned"
        }
    }

    /// A chip's words with its count, where it has one: "Needs you 2".
    func words(count: Int?) -> String {
        guard let count, count > 0, self != .all else { return title }
        return "\(title) \(count)"
    }
}

/// The chips under Home's bar: All, then Needs you and Pinned while each holds anything, the chosen one
/// filled with ink as Manus fills it; and at the end, how the list is laid out. They grow with the text
/// at every size, and at the accessibility sizes they wrap onto rows instead of scrolling.
struct HomeChips: View {
    @Binding var filter: HomeFilter
    let needsYou: Int
    let pinned: Int
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .subheadline) private var lineHeight: CGFloat = 20

    var body: some View {
        let counts: [HomeFilter: Int] = [.needsYou: needsYou, .pinned: pinned]
        let shown = HomeFilter.allCases.filter { $0 == .all || $0 == filter || (counts[$0] ?? 0) > 0 }
        HStack(alignment: .top, spacing: 8) {
            if dynamicTypeSize.isAccessibilitySize {
                ChipRows(spacing: 8) { chips(shown, counts: counts) }
                    .padding(.leading, 16)
            } else {
                ScrollView(.horizontal) {
                    HStack(spacing: 8) { chips(shown, counts: counts) }
                        .padding(.leading, 16)
                }
                .scrollIndicators(.hidden)
            }
            ViewOptionsMenu()
                .padding(.trailing, 8)
        }
        .padding(.vertical, 6)
        // On the ground, so no row reads through the chips; the list's soft edge fades out under them.
        .background(Ground.transcript)
        .sensoryFeedback(.selection, trigger: filter)
        // A chip whose sessions are gone leaves the list on All, never on an empty choice.
        .onChange(of: needsYou) { _, count in if count == 0, filter == .needsYou { filter = .all } }
        .onChange(of: pinned) { _, count in if count == 0, filter == .pinned { filter = .all } }
    }

    @ViewBuilder
    private func chips(_ shown: [HomeFilter], counts: [HomeFilter: Int]) -> some View {
        let shape = PillShape(oneLine: max(34, lineHeight + 14))
        ForEach(shown, id: \.self) { chip in
            let chosen = chip == filter
            Button {
                filter = chip
            } label: {
                Text(chip.words(count: counts[chip]))
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(chosen ? Fill.onPrimary : Palette.ink2)
                    .multilineTextAlignment(.leading)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 7)
                    .frame(minHeight: 34)
                    .background(chosen ? Fill.primary : Fill.pill, in: shape)
                    .contentShape(shape)
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(chosen ? .isSelected : [])
            .accessibilityIdentifier("home-chip-\(chip)")
        }
    }
}

/// Manus's new-task button: a round button of ink at the list's foot, with the new session's glyph.
struct NewSessionButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "square.and.pencil")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(Fill.onPrimary)
                .frame(width: 56, height: 56)
                .background(Fill.primary, in: Circle())
                .floatingLift()
        }
        .buttonStyle(.plain)
        .accessibilityLabel("New session")
        .accessibilityIdentifier("new-session")
        .accessibilityShowsLargeContentViewer { Label("New session", systemImage: "square.and.pencil") }
    }
}
