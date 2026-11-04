import ActivityKit
import RealmKit
import SwiftUI
import WidgetKit

@main
struct RealmActivityBundle: WidgetBundle {
    var body: some Widget {
        WorkActivityWidget()
    }
}

/// A session at work, on the Lock Screen and in the Dynamic Island: who is working, on what, for how
/// long and how far the plan has got. Amber is its one colour, for needs you and failed. A tap opens
/// the session.
struct WorkActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: WorkActivityAttributes.self) { context in
            LockScreenActivity(subject: context.attributes, state: context.state)
                .activityBackgroundTint(Palette.surface)
                .activitySystemActionForegroundColor(Palette.ink)
                .widgetURL(SessionURL.url(context.attributes.sessionId))
        } dynamicIsland: { context in
            let subject = context.attributes, state = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    ActivityMark(subject: subject, size: 26)
                        .padding(.leading, 6)
                        .padding(.top, 2)
                        .island()
                }
                DynamicIslandExpandedRegion(.trailing) {
                    ActivityClock(state: state)
                        .font(.subheadline)
                        .foregroundStyle(Palette.ink2)
                        .frame(maxWidth: 64, alignment: .trailing)
                        .padding(.trailing, 6)
                        .padding(.top, 4)
                        .island()
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(subject.title)
                        .font(.headline)
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1)
                        .island()
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 8) {
                        StepLine(state: state)
                            .font(.subheadline)
                        if state.count != nil { PlanLine(state: state) }
                    }
                    .padding(.horizontal, 6)
                    .padding(.top, 2)
                    .island()
                }
            } compactLeading: {
                ActivityMark(subject: subject, size: 18)
                    .island()
            } compactTrailing: {
                CompactState(state: state)
                    .island()
            } minimal: {
                Group {
                    if state.isAmber {
                        StateGlyph(state: state)
                    } else {
                        ActivityMark(subject: subject, size: 16)
                    }
                }
                .island()
            }
            .widgetURL(SessionURL.url(subject.sessionId))
        }
    }
}

/// The Lock Screen's card: the mark, the title and the clock, then the step, then the plan's count
/// over its hairline.
struct LockScreenActivity: View {
    let subject: WorkActivityAttributes
    let state: WorkActivityContent

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ActivityMark(subject: subject, size: 28)
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(subject.title)
                        .font(.headline)
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    ActivityClock(state: state)
                        .font(.subheadline)
                        .foregroundStyle(Palette.ink2)
                        .frame(maxWidth: 72, alignment: .trailing)
                }
                StepLine(state: state)
                    .font(.subheadline)
                if state.count != nil {
                    PlanLine(state: state)
                        .padding(.top, 3)
                }
            }
        }
        .padding(16)
    }
}

/// The step, led by its state's word where the step alone does not say it: "Needs you · Allow Bash".
struct StepLine: View {
    let state: WorkActivityContent

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            if state.phase != .working {
                StateGlyph(state: state)
                    .font(.footnote.weight(.semibold))
            }
            if let label = state.label {
                Text(label)
                    .fontWeight(.semibold)
                    .foregroundStyle(Palette.orange)
                    .fixedSize()
            }
            Text(state.step)
                .foregroundStyle(state.phase == .failed ? Palette.orange : Palette.ink2)
                .lineLimit(1)
        }
    }
}

/// "2 of 5" over the plan's hairline, as the work dock draws it.
struct PlanLine: View {
    let state: WorkActivityContent

    var body: some View {
        HStack(spacing: 8) {
            GeometryReader { proxy in
                Capsule().fill(Palette.mark)
                    .overlay(alignment: .leading) {
                        Capsule().fill(Palette.ink2)
                            .frame(width: proxy.size.width * (state.progress ?? 0))
                    }
            }
            .frame(height: 3)
            Text(state.count ?? "")
                .font(.footnote)
                .monospacedDigit()
                .foregroundStyle(Palette.ink2)
                .fixedSize()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(state.done ?? 0) of \(state.total ?? 0) done")
    }
}

/// The turn's clock: counting while it works, stopped where it finished.
struct ActivityClock: View {
    let state: WorkActivityContent

    var body: some View {
        Group {
            if let elapsed = state.elapsed {
                Text(elapsed)
            } else {
                Text(timerInterval: state.startedAt...Date.distantFuture, countsDown: false)
            }
        }
        .monospacedDigit()
        .multilineTextAlignment(.trailing)
        .lineLimit(1)
    }
}

/// The compact island's right side: the clock while it works, else the state's glyph.
struct CompactState: View {
    let state: WorkActivityContent

    var body: some View {
        if state.phase == .working {
            ActivityClock(state: state)
                .font(.footnote)
                .foregroundStyle(Palette.ink)
                .frame(maxWidth: 44)
        } else {
            StateGlyph(state: state)
                .font(.footnote.weight(.semibold))
        }
    }
}

/// Needs you's raised hand and Failed's mark in amber; Done's check in ink.
struct StateGlyph: View {
    let state: WorkActivityContent

    var body: some View {
        switch state.phase {
        case .working: EmptyView()
        case .needsYou: Image(systemName: "hand.raised.fill").foregroundStyle(Palette.orange)
        case .failed: Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Palette.orange)
        case .done: Image(systemName: "checkmark").foregroundStyle(Palette.ink2)
        }
    }
}

/// Who is working: the teammate's mark, else the agent's in its vendor's colour or the ink.
struct ActivityMark: View {
    let subject: WorkActivityAttributes
    let size: CGFloat

    var body: some View {
        if let teammate = subject.teammate {
            TeammateMark(icon: teammate, size: size)
        } else if let icon = subject.agentIcon {
            Image("Agents/\(icon)")
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .frame(width: size, height: size)
                .foregroundStyle(subject.agentColor.flatMap { Color(hex: $0) } ?? Palette.ink)
                .accessibilityHidden(true)
        } else {
            Image(systemName: "cube")
                .font(.system(size: size * 0.7, weight: .medium))
                .foregroundStyle(Palette.ink2)
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        }
    }
}

extension View {
    /// The island is black in both appearances: the palette is read in its dark face there.
    fileprivate func island() -> some View {
        environment(\.colorScheme, .dark)
    }
}
