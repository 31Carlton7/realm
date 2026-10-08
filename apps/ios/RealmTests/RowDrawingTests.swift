import RealmKit
import SwiftUI
import Testing
import UIKit
import Vision
@testable import Realm

/// Draws a view the way the screen does — hosted in a window, so UIKit-backed pieces draw too — and
/// reads back the words on it with Vision.
@MainActor
enum Drawing {
    static func image(of view: some View, width: CGFloat = 390, dark: Bool = true) throws -> UIImage {
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.overrideUserInterfaceStyle = dark ? .dark : .light
        let host = UIHostingController(rootView: view.frame(width: width).fixedSize(horizontal: false, vertical: true)
            .padding(16).background(Palette.canvas))
        host.sizingOptions = [.preferredContentSize]
        window.rootViewController = host
        window.makeKeyAndVisible()
        let size = host.sizeThatFits(in: CGSize(width: width + 32, height: 4_000))
        window.frame = CGRect(origin: .zero, size: CGSize(width: width + 32, height: max(1, size.height)))
        host.view.frame = window.bounds
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.15))
        let renderer = UIGraphicsImageRenderer(bounds: host.view.bounds)
        let image = renderer.image { _ in _ = host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true) }
        window.isHidden = true
        return image
    }

    static func words(_ view: some View, width: CGFloat = 390, dark: Bool = true) throws -> String {
        let image = try image(of: view, width: width, dark: dark)
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: try #require(image.cgImage)).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
    }
}

@MainActor
@Suite("Every row of a transcript draws", .serialized)
struct RowDrawingTests {
    static func row(_ content: TranscriptRow.Content, key: String = "k:1") -> TranscriptRow {
        TranscriptRow(key: key, seq: 4, content: content)
    }

    static func words(_ content: TranscriptRow.Content, model: AppModel = AppModel()) throws -> String {
        try Drawing.words(TranscriptRowView(row: row(content), sessionId: "s1").environment(model))
    }

    /// A row this version cannot draw says so: nothing in a transcript is ever blank.
    @Test func anUnknownRowSaysOpenThisOnYourMac() throws {
        #expect(try Self.words(.unknown(kind: "diff", type: nil)).contains("Open this on your Mac"))
        #expect(try Self.words(.unknown(kind: "unknown", type: "rate_limit")).contains("Open this on your Mac"))
    }

    @Test func everyKnownKindDrawsItsWords() throws {
        #expect(try Self.words(.user(text: "Run the tests")).contains("Run the tests"))
        #expect(try Self.words(.assistant(text: "All **four** pass.", streaming: false)).contains("four pass"))
        #expect(try Self.words(.assistant(text: "Reading the page", streaming: true)).contains("Writing"))
        #expect(try Self.words(.thinking(text: "Hmm")).contains("Thinking"))
        let tool = try Self.words(.tool(name: "Bash", summary: "pnpm test", state: .done, detail: "ok"))
        #expect(tool.contains("Bash") && tool.contains("pnpm test"))
        let plan = try Self.words(.plan(text: nil, steps: [PlanStep(text: "Carry the plan", status: "in_progress")]))
        #expect(plan.contains("Plan") && plan.contains("Carry the plan"))
        #expect(try Self.words(.notice(text: "Context compacted")).contains("Context compacted"))
        let error = try Self.words(.error(text: "Out of credits", hint: "Top up in Settings"))
        #expect(error.contains("Out of credits") && error.contains("Top up"))
    }

    @Test func aPermissionIsAnsweredInPlace() throws {
        let words = try Self.words(.request(.init(requestId: "r1", tool: "Bash", title: "Allow Bash?", summary: "pnpm test",
                                                   state: .pending, questions: nil)))
        #expect(words.contains("Allow Bash?"))
        #expect(words.contains("Waiting on you"))
        #expect(words.contains("Deny"))
    }

    @Test func aPlanIsApprovedNotAllowed() throws {
        let words = try Self.words(.request(.init(requestId: "p1", tool: "ExitPlanMode", title: "Exit plan mode?",
                                                   summary: "Ship the mapper", state: .pending, questions: nil)))
        #expect(words.contains("Implement this plan"))
        #expect(words.contains("Keep planning"))
    }

    /// An answer given while the Mac sleeps is kept, and the card says where it is.
    @Test func anAnswerWaitingForASleepingMacSaysSo() throws {
        let model = AppModel()
        model.store.finishOpening(OpenedSession(
            session: SessionRow(id: "s1", title: "T", spaceId: "sp", spaceName: "Realm", agent: "claude", model: nil, status: .waiting,
                                needsYou: true, unread: false, updatedAt: 0),
            rows: [], hasMore: false))
        model.store.connection = .macOffline(lastSeen: 1_790_000_000_000)
        let request = TranscriptRow.Request(requestId: "r1", tool: "Bash", title: "Allow Bash?", summary: "pnpm test", state: .pending,
                                            questions: nil)
        model.store.enqueueAnswer(.allow, to: "r1", in: "s1")
        let words = try Self.words(.request(request), model: model)
        #expect(words.contains("You allowed it"))
        #expect(words.contains("Your Mac is asleep"))
        #expect(words.contains("Don't send") || words.contains("Don’t send"))
    }
}

@MainActor
@Suite("The app's own type, colour and categories")
struct AppResourceTests {
    @Test func theBundledFacesRegistered() {
        #expect(RealmType.isInstalled)
        let inter = RealmType.uiFont(.body, weight: .title)
        #expect(inter.familyName.hasPrefix("Inter"))
        #expect(RealmType.uiFont(.body, mono: true).fontName == "JetBrainsMono-Regular")
    }

    @Test func everyPaletteColourIsInTheCatalog() {
        let names = ["Page", "Canvas", "Surface", "Inset", "Hover", "Hover2", "Field", "Ink", "Ink2", "Ink3", "AccentColor", "AccentInk",
                     "AccentTint", "Green", "GreenTint", "Orange", "OrangeTint", "Red", "RedTint", "Line", "LineStrong", "Divider", "Mark"]
        for name in names { #expect(UIColor(named: name) != nil, "\(name) is missing from the asset catalog") }
        let dark = UITraitCollection(userInterfaceStyle: .dark), light = UITraitCollection(userInterfaceStyle: .light)
        #expect(UIColor(named: "Page")!.resolvedColor(with: dark) != UIColor(named: "Page")!.resolvedColor(with: light))
    }

    @Test func everyKindOfPushHasACategory() {
        #expect(Set(NotificationKinds.categories.map(\.identifier)) == ["permission", "question", "finished", "failed", "blocked", "test"])
    }
}
