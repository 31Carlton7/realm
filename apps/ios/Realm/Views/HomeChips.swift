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
/// filled with ink as Manus fills it; and at the end, how the list is laid out.
struct HomeChips: View {
    @Binding var filter: HomeFilter
    let needsYou: Int
    let pinned: Int

    var body: some View {
        let counts: [HomeFilter: Int] = [.needsYou: needsYou, .pinned: pinned]
        let shown = HomeFilter.allCases.filter { $0 == .all || $0 == filter || (counts[$0] ?? 0) > 0 }
        HStack(spacing: 8) {
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    ForEach(shown, id: \.self) { chip in
                        let chosen = chip == filter
                        Button {
                            filter = chip
                        } label: {
                            Text(chip.words(count: counts[chip]))
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(chosen ? Fill.onPrimary : Palette.ink2)
                                .padding(.horizontal, 14)
                                .frame(minHeight: 34)
                                .background(chosen ? Fill.primary : Fill.pill, in: Capsule())
                                .contentShape(Capsule())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(chosen ? .isSelected : [])
                    }
                }
                .padding(.leading, 16)
            }
            .scrollIndicators(.hidden)
            ViewOptionsMenu()
                .padding(.trailing, 8)
        }
        .padding(.vertical, 6)
        .background(Ground.transcript)
        .sensoryFeedback(.selection, trigger: filter)
        // A chip whose sessions are gone leaves the list on All, never on an empty choice.
        .onChange(of: needsYou) { _, count in if count == 0, filter == .needsYou { filter = .all } }
        .onChange(of: pinned) { _, count in if count == 0, filter == .pinned { filter = .all } }
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
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
