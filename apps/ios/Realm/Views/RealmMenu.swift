import SwiftUI
import UIKit

/// Realm's own menu on the phone, where iOS 26 draws every system menu as glass (design.md, the phone's
/// menus). It keeps what the system menu gave: VoiceOver reads it as a menu, Dynamic Type, a touch
/// outside puts it away, a haptic on open, and it never covers the control that opened it.
///
/// The rows are the ordinary controls a system menu takes: `Button` (its role is kept), `Toggle` for a
/// choice, with a check on the one that is on, and `Section(head:)` for a group under its head. A press
/// on any of them puts the menu away before it acts.
struct RealmMenu<Label: View, Content: View>: View {
    let title: String
    var hint: String?
    /// What a tap does where the menu is a second target on the control: a long press opens the menu.
    var primaryAction: (() -> Void)?
    @ViewBuilder let content: () -> Content
    @ViewBuilder let label: () -> Label
    @Environment(AppModel.self) private var model: AppModel?
    @State private var anchor = MenuAnchor()

    init(_ title: String, hint: String? = nil, primaryAction: (() -> Void)? = nil,
         @ViewBuilder content: @escaping () -> Content, @ViewBuilder label: @escaping () -> Label) {
        self.title = title
        self.hint = hint
        self.primaryAction = primaryAction
        self.content = content
        self.label = label
    }

    var body: some View {
        if let primaryAction {
            pressable(primaryAction)
        } else {
            Button(action: open) {
                label().background(MenuAnchorProbe(anchor: anchor))
            }
            .accessibilityHint(Self.spokenHint(hint))
        }
    }

    private func pressable(_ primaryAction: @escaping () -> Void) -> some View {
        label()
            .background(MenuAnchorProbe(anchor: anchor))
            .contentShape(Rectangle())
            .onTapGesture(perform: primaryAction)
            .onLongPressGesture(perform: open)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityAction(.default, primaryAction)
            .accessibilityAction(named: "Show options", open)
    }

    /// What VoiceOver says after the control's name: what it is for, then that it opens a menu.
    static func spokenHint(_ hint: String?) -> String {
        [hint, "Opens a menu."].compactMap { $0 }.joined(separator: ". ")
    }

    private func open() {
        guard let view = anchor.view, let window = view.window else { return }
        RealmMenuHost.shared.present(title: title, anchor: view.convert(view.bounds, to: nil), over: window, model: model, content: content)
    }
}

/// Where a menu was opened from: the control's own view, read for its frame on screen. At the
/// accessibility sizes SwiftUI draws a label a second time, for the large-content viewer, in a view
/// that never reaches a window: the one in a window is the control.
final class MenuAnchor {
    private let views = NSHashTable<UIView>.weakObjects()

    func add(_ view: UIView) { views.add(view) }

    var view: UIView? { views.allObjects.first { $0.window != nil } }
}

private struct MenuAnchorProbe: UIViewRepresentable {
    let anchor: MenuAnchor

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.isUserInteractionEnabled = false
        view.isAccessibilityElement = false
        anchor.add(view)
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {
        anchor.add(view)
    }
}

/// Where a menu of a given size opens beside its control. Below it when it fits there, else above it
/// when it fits there, else on the roomier side, as tall as that side allows. Its edge lines up with
/// the control's edge nearer the screen's, and it keeps inside the room. It never covers the control.
enum RealmMenuPlacement {
    static let gap: CGFloat = 6
    static let margin: CGFloat = 12

    static func frame(size: CGSize, anchor: CGRect, room: CGRect) -> CGRect {
        let below = room.maxY - (anchor.maxY + gap)
        let above = (anchor.minY - gap) - room.minY
        let width = min(size.width, room.width - 2 * margin)
        let opensBelow = size.height <= below || (size.height > above && below >= above)
        let height = min(size.height, max(0, opensBelow ? below : above))
        let y = opensBelow ? anchor.maxY + gap : anchor.minY - gap - height
        let leading = anchor.midX < room.midX
        let x = leading ? anchor.minX : anchor.maxX - width
        let clampedX = min(max(x, room.minX + margin), room.maxX - margin - width)
        return CGRect(x: clampedX, y: y, width: width, height: height)
    }
}

/// Shows one menu at a time, in a window of its own over the app's, so it opens over a sheet as well
/// as a screen. Outside the menu, the window is all backdrop: a touch there, a tap or the start of a
/// swipe, puts it away.
@MainActor
final class RealmMenuHost {
    static let shared = RealmMenuHost()

    /// The tap a menu opens with; replaceable so a test can count it.
    var haptic: () -> Void = { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    private(set) var window: UIWindow?
    /// Where the keyboard stands, on screen, while it is up: a menu opens clear of it.
    private var keyboard: CGRect?
    private var watching: [NSObjectProtocol] = []

    /// Follows the keyboard from launch, since a menu can open while it is already up.
    func watchKeyboard() {
        guard watching.isEmpty else { return }
        let center = NotificationCenter.default
        watching = [
            center.addObserver(forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main) { note in
                let frame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue
                MainActor.assumeIsolated { self.keyboard = frame }
            },
            center.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { self.keyboard = nil }
            },
        ]
    }

    /// Opens a menu beside `anchor`, a frame on screen. Its rows are given the app's model; the face and
    /// the text size are its own window's, so they follow the screen while the menu is up.
    func present(title: String, anchor: CGRect, over parent: UIWindow, model: AppModel? = nil,
                 @ViewBuilder content: () -> some View) {
        dismiss(fading: false)
        guard let scene = parent.windowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.frame = parent.frame
        window.windowLevel = .alert
        let panel = RealmMenuPanel(title: title, close: MenuClose { [weak self] in self?.dismiss() }, content: content())
        let root = model.map { AnyView(panel.environment($0)) } ?? AnyView(panel)
        window.rootViewController = RealmMenuController(panel: root, anchor: anchor, keyboard: keyboard) { [weak self] in
            self?.dismiss()
        }
        window.isHidden = false
        self.window = window
        haptic()
        UIAccessibility.post(notification: .screenChanged, argument: (window.rootViewController as? RealmMenuController)?.host.view)
    }

    /// Puts the menu away on a short fade, with no travel, as a Mac's menu leaves.
    func dismiss(fading: Bool = true) {
        guard let window else { return }
        self.window = nil
        window.isUserInteractionEnabled = false
        guard fading, !UIAccessibility.isReduceMotionEnabled else {
            window.isHidden = true
            UIAccessibility.post(notification: .screenChanged, argument: nil)
            return
        }
        UIView.animate(withDuration: 0.12, animations: { window.alpha = 0 }) { _ in
            window.isHidden = true
            UIAccessibility.post(notification: .screenChanged, argument: nil)
        }
    }
}

/// The menu's window: the backdrop over the whole screen, and the menu over it, placed beside its control.
final class RealmMenuController: UIViewController {
    let backdrop: MenuBackdrop
    let host: UIHostingController<AnyView>
    private let anchor: CGRect
    private let keyboard: CGRect?
    private let close: () -> Void

    init(panel: AnyView, anchor: CGRect, keyboard: CGRect?, close: @escaping () -> Void) {
        self.anchor = anchor
        self.keyboard = keyboard
        self.close = close
        backdrop = MenuBackdrop(close: close)
        host = UIHostingController(rootView: panel)
        host.sizingOptions = .preferredContentSize
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        // VoiceOver stays inside the menu, as it does inside the system's.
        view.accessibilityViewIsModal = true
        backdrop.frame = view.bounds
        backdrop.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(backdrop)
        addChild(host)
        host.view.backgroundColor = .clear
        view.addSubview(host.view)
        host.didMove(toParent: self)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        place()
    }

    /// The room a menu may take: the screen inside its safe area, above the keyboard while it is up.
    var room: CGRect {
        var room = view.bounds.inset(by: view.safeAreaInsets)
        if let keyboard, keyboard.minY < room.maxY, keyboard.height > 0 {
            room.size.height = max(0, keyboard.minY - room.minY)
        }
        return room
    }

    func place() {
        let fitted = host.sizeThatFits(in: CGSize(width: room.width - 2 * RealmMenuPlacement.margin, height: 10_000))
        host.view.frame = RealmMenuPlacement.frame(size: fitted, anchor: anchor, room: room)
    }

    /// A row that opens more rows under it changes the menu's height: place it again.
    override func preferredContentSizeDidChange(forChildContentContainer container: UIContentContainer) {
        super.preferredContentSizeDidChange(forChildContentContainer: container)
        place()
    }

    override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        close()
    }

    override func accessibilityPerformEscape() -> Bool {
        close()
        return true
    }
}

/// Everything around the menu. A touch on it puts the menu away the moment it lands, so a swipe that
/// starts out there does too. VoiceOver reads it as the system's own: Close menu, a button.
final class MenuBackdrop: UIControl {
    private let close: () -> Void

    init(close: @escaping () -> Void) {
        self.close = close
        super.init(frame: .zero)
        addTarget(self, action: #selector(touched), for: .touchDown)
        isAccessibilityElement = true
        accessibilityLabel = "Close menu"
        accessibilityTraits = .button
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    @objc private func touched() { close() }

    override func accessibilityActivate() -> Bool {
        close()
        return true
    }
}

/// The menu's card: the solid surface, a floating menu's edge and lift, and its rows in one column,
/// grouped by section with a head where the section has one and a hairline between sections.
struct RealmMenuPanel<Content: View>: View {
    let title: String
    let close: MenuClose
    let content: Content
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Radius.menu, style: .continuous)
        ViewThatFits(in: .vertical) {
            column
            ScrollView { column }
                .scrollBounceBehavior(.basedOnSize)
        }
        .background(Fill.card, in: shape)
        .clipShape(shape)
        .overlay(shape.strokeBorder(Palette.lineStrong, lineWidth: 1 / displayScale))
        .shadow(color: .black.opacity(0.1), radius: 24, y: 10)
        .floatingLift()
        .buttonStyle(RealmMenuButtonStyle())
        .toggleStyle(RealmMenuToggleStyle())
        .labelStyle(RealmMenuLabelStyle())
        .environment(\.realmMenuClose, close)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(title), menu")
        .accessibilityAddTraits(.isModal)
        .accessibilityAction(.escape, close.action)
    }

    private var column: some View {
        MenuColumn {
            Group(sections: content) { sections in
                let shown = sections.filter { !$0.content.isEmpty }
                ForEach(shown) { section in
                    if section.id != shown.first?.id {
                        Rectangle()
                            .fill(Palette.divider)
                            .frame(height: 1 / displayScale)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 5)
                            .accessibilityHidden(true)
                    }
                    if !section.header.isEmpty {
                        section.header
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Palette.ink2)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 12)
                            .padding(.top, 8)
                            .padding(.bottom, 2)
                            .accessibilityAddTraits(.isHeader)
                    }
                    section.content
                }
            }
        }
    }
}

/// The menu's rows in one column, as wide as its widest row and at least a system menu's width, never
/// wider than it is offered: a row that would be wider wraps its words.
struct MenuColumn: Layout {
    static let minWidth: CGFloat = 250
    static let inset: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = rowWidth(proposal, subviews)
        let height = subviews.reduce(0) { $0 + $1.sizeThatFits(ProposedViewSize(width: width, height: nil)).height }
        return CGSize(width: width + 2 * Self.inset, height: height + 2 * Self.inset)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let width = rowWidth(ProposedViewSize(width: bounds.width, height: nil), subviews)
        var y = bounds.minY + Self.inset
        for subview in subviews {
            let row = ProposedViewSize(width: width, height: nil)
            let height = subview.sizeThatFits(row).height
            subview.place(at: CGPoint(x: bounds.minX + Self.inset, y: y), proposal: ProposedViewSize(width: width, height: height))
            y += height
        }
    }

    private func rowWidth(_ proposal: ProposedViewSize, _ subviews: Subviews) -> CGFloat {
        let widest = subviews.map { $0.sizeThatFits(.unspecified).width }.max() ?? 0
        let wanted = max(Self.minWidth, widest + 2 * Self.inset)
        return min(wanted, proposal.width ?? wanted) - 2 * Self.inset
    }
}

extension EnvironmentValues {
    /// Puts away the menu a row is in; nil outside a Realm menu.
    @Entry var realmMenuClose: MenuClose?
}

/// What puts one menu away. It is the same value for as long as the menu is up, so the rows that read it
/// draw once.
struct MenuClose: Equatable {
    private let id = UUID()
    let action: () -> Void

    static func == (a: MenuClose, b: MenuClose) -> Bool { a.id == b.id }
}

/// A row of the menu: its words in ink, red where it destroys, on a fill while it is pressed. A press
/// puts the menu away, then acts.
struct RealmMenuButtonStyle: PrimitiveButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        MenuRowButton(configuration: configuration)
    }
}

private struct MenuRowButton: View {
    let configuration: PrimitiveButtonStyleConfiguration
    @Environment(\.realmMenuClose) private var close

    var body: some View {
        Button {
            close?.action()
            configuration.trigger()
        } label: {
            configuration.label
        }
        .buttonStyle(MenuRowLook(destructive: configuration.role == .destructive))
    }
}

/// A choice: a row with the accent's check on the one that is on, as the phone's settings check theirs.
struct RealmMenuToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        MenuToggleRow(configuration: configuration)
    }
}

private struct MenuToggleRow: View {
    let configuration: ToggleStyleConfiguration
    @Environment(\.realmMenuClose) private var close

    var body: some View {
        Button {
            close?.action()
            configuration.isOn.toggle()
        } label: {
            HStack(spacing: 8) {
                configuration.label
                Spacer(minLength: 8)
                Image(systemName: "checkmark")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Palette.accent)
                    .opacity(configuration.isOn ? 1 : 0)
                    .accessibilityHidden(true)
            }
        }
        .buttonStyle(MenuRowLook(destructive: false))
        .accessibilityAddTraits(configuration.isOn ? .isSelected : [])
    }
}

private struct MenuRowLook: ButtonStyle {
    let destructive: Bool

    func makeBody(configuration: Configuration) -> some View {
        MenuRowFace(configuration: configuration, destructive: destructive)
    }
}

private struct MenuRowFace: View {
    let configuration: ButtonStyleConfiguration
    let destructive: Bool
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        configuration.label
            .font(.body)
            .foregroundStyle(destructive ? DestructiveInk.color : Palette.ink)
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 2)
            .background(configuration.isPressed ? Palette.hover2 : .clear,
                        in: RoundedRectangle(cornerRadius: Radius.menu - MenuColumn.inset, style: .continuous))
            .contentShape(Rectangle())
            .opacity(isEnabled ? 1 : 0.45)
    }
}

/// A row's glyph in a column of its own, so every row's words start at one edge.
struct RealmMenuLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        MenuLabel(configuration: configuration)
    }
}

private struct MenuLabel: View {
    let configuration: LabelStyleConfiguration
    @ScaledMetric(relativeTo: .body) private var glyph: CGFloat = 24

    var body: some View {
        HStack(spacing: 10) {
            configuration.icon
                .frame(width: glyph)
            configuration.title
        }
    }
}

/// A row's name and, where it needs one, the line under it saying what it does or why it is off.
struct MenuRowWords: View {
    let title: String
    var line: String?

    init(_ title: String, line: String? = nil) {
        self.title = title
        self.line = line
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title)
            if let line {
                Text(line)
                    .font(.subheadline)
                    .foregroundStyle(Palette.ink2)
            }
        }
        .padding(.vertical, line == nil ? 0 : 6)
    }
}

/// A row that opens more rows under it, in place: the system menu's submenu, which a card cannot open
/// beside itself.
struct MenuDisclosure<Rows: View>: View {
    let title: String
    let systemImage: String
    @ViewBuilder let rows: Rows
    @State private var open = false
    @ScaledMetric(relativeTo: .body) private var indent: CGFloat = 34

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                open.toggle()
            } label: {
                Label {
                    HStack {
                        Text(title)
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.right")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Palette.ink3)
                            .rotationEffect(.degrees(open ? 90 : 0))
                    }
                } icon: {
                    Image(systemName: systemImage)
                }
            }
            .buttonStyle(MenuRowLook(destructive: false))
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            if open {
                VStack(alignment: .leading, spacing: 0) { rows }
                    .padding(.leading, indent)
            }
        }
    }
}

/// A mark that is only a picture — a profile's glyph in its colour, an emoji drawn into one — at a row's
/// glyph size.
struct MenuMark: View {
    let image: Image
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 20

    var body: some View {
        image
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
    }
}

/// A menu's glyph in a bar. A bar draws a plain button with a bare `Label` as its own item, which never
/// reaches a window, so the menu would have nowhere to open: the glyph is drawn here instead, a touch
/// wide, and its button takes the plain style.
struct BarMenuLabel: View {
    let title: String
    let systemImage: String

    init(_ title: String, systemImage: String) {
        self.title = title
        self.systemImage = systemImage
    }

    var body: some View {
        Label(title, systemImage: systemImage)
            .labelStyle(.iconOnly)
            .font(.body.weight(.medium))
            .foregroundStyle(Palette.ink)
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
    }
}
