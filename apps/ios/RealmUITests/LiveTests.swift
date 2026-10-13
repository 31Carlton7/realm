import XCTest

/// The app against a real Mac, relay and gateway, staged by `scripts/screens-live.mts --ui`. The
/// script moves the Mac between phases — awake, asleep, the relay gone — and runs one test per phase.
/// It hands the runner a pairing link and a folder for screenshots (`TEST_RUNNER_PAIR_LINK`,
/// `TEST_RUNNER_SHOTS`).
final class LiveTests: XCTestCase {
    private var app: XCUIApplication!
    private let environment = ProcessInfo.processInfo.environment

    override func setUp() {
        continueAfterFailure = false
    }

    /// The app, unattended so it asks for no permission, with any launch arguments the phase adds.
    @MainActor
    private func launch(_ arguments: [String] = []) {
        app = XCUIApplication()
        app.launchArguments = ["-unattended", "1"] + arguments
        app.launch()
    }

    // MARK: - Phases

    /// Forgets whatever Mac the app showed, then pairs with the staged one through its link. The Mac
    /// holds its answer for a few seconds, which is when the phone says to confirm there.
    @MainActor
    func test0_forgetThenPair() throws {
        launch()
        if element(containing: "Sessions").waitForExistence(timeout: 8) {
            app.navigationBars.buttons["Settings"].tap()
            let forget = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Forget ")).firstMatch
            XCTAssert(forget.waitForExistence(timeout: 5))
            shot("settings")
            forget.tap()
            let confirm = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Forget ")).element(boundBy: 1)
            XCTAssert(confirm.waitForExistence(timeout: 5))
            confirm.tap()
        }
        XCTAssert(app.buttons["Scan the code"].waitForExistence(timeout: 10))
        shot("pair")
        app.buttons["Paste the link"].tap()
        XCTAssert(app.navigationBars["Paste the link"].waitForExistence(timeout: 5))
        shot("pair-paste")
        app.navigationBars["Paste the link"].buttons["Cancel"].tap()
        let link = try XCTUnwrap(environment["PAIR_LINK"], "the staging script passes a pairing link")
        app.terminate()
        launch(["-pairLink", link])
        XCTAssert(element(containing: "Confirm on your Mac").waitForExistence(timeout: 15))
        shot("pair-confirm")
        XCTAssert(app.staticTexts["Needs you"].waitForExistence(timeout: 30))
    }

    /// Home, a permission and a question; the question's sheet put away answers nothing; a message
    /// sent shows until the Mac has it; a plan and an error with its fix.
    @MainActor
    func test1_awake() throws {
        launch()
        XCTAssert(element(containing: "· Connected").waitForExistence(timeout: 30))
        XCTAssert(app.staticTexts["Needs you"].waitForExistence(timeout: 10))
        shot("home")
        app.swipeUp()
        shot("home-spaces")
        app.swipeDown()

        card("Add the dark-mode toggle").tap()
        XCTAssert(app.staticTexts["Allow Bash?"].waitForExistence(timeout: 10))
        shot("session-request")
        let read = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Read, ")).firstMatch
        if read.waitForExistence(timeout: 3) {
            read.tap()
            shot("session-tool-open")
        }
        back()

        card("Choose the database").tap()
        let answer = app.buttons["Answer"]
        XCTAssert(answer.waitForExistence(timeout: 10))
        shot("session-question")
        answer.tap()
        let sqlite = app.buttons["SQLite"]
        XCTAssert(sqlite.waitForExistence(timeout: 5))
        sqlite.tap()
        app.buttons["us-east-1"].tap()
        // Every question answered, so a sheet that answered on its way out would have something to send.
        let token = app.textFields["Your answer"]
        token.tap()
        token.typeText("staging-token")
        XCTAssert(app.navigationBars["Codex asks"].buttons["Send"].isEnabled, "the answers are complete")
        shot("question-sheet")
        // Dragging the sheet away is a way out, never an answer.
        let sheet = app.navigationBars["Codex asks"]
        sheet.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)))
        XCTAssert(sheet.waitForNonExistence(timeout: 5), "the sheet did not go away")
        XCTAssert(app.buttons["Continue answering"].waitForExistence(timeout: 5), "the picks were not kept")
        sleep(3)
        XCTAssertFalse(element(containing: "Sending").exists, "putting the sheet away sent an answer")
        XCTAssert(app.staticTexts["Waiting on you"].exists, "putting the sheet away answered the request")
        shot("question-put-away")
        back()

        card("Explain the relay").tap()
        XCTAssert(element(containing: "How the relay works").waitForExistence(timeout: 10)
                  || element(containing: "dials out").waitForExistence(timeout: 5))
        shot("session-markdown")
        let field = app.textViews["Message"].exists ? app.textViews["Message"] : app.textFields["Message"]
        field.tap()
        field.typeText("Ship it on Friday")
        shot("composer-typing")
        app.buttons["Send"].tap()
        XCTAssert(element(containing: "echo: Ship it on Friday").waitForExistence(timeout: 15), "the Mac never answered the message")
        XCTAssertFalse(element(containing: "Sending").exists)
        shot("session-sent")
        back()

        card("Rework the transcript mapper").tap()
        XCTAssert(element(containing: "Carry the plan as its own event").waitForExistence(timeout: 10))
        shot("session-plan")
        back()

        card("Train the social model").tap()
        XCTAssert(element(containing: "limit").waitForExistence(timeout: 10))
        shot("session-error")
        back()

        app.navigationBars.buttons["Settings"].tap()
        XCTAssert(element(containing: "Relay").waitForExistence(timeout: 5))
        shot("settings-connected")
    }

    /// The Mac is asleep: Home says so from the cache, and an answer given now waits in the outbox.
    @MainActor
    func test2_asleep() throws {
        launch()
        XCTAssert(element(containing: "Asleep since").waitForExistence(timeout: 90), "the phone was never told the Mac slept")
        XCTAssert(element(containing: "Last updated").exists)
        shot("asleep-home")
        card("Add the dark-mode toggle").tap()
        let allow = app.buttons["Allow"]
        XCTAssert(allow.waitForExistence(timeout: 10))
        allow.tap()
        XCTAssert(element(containing: "Your Mac is asleep. This sends when it wakes.").waitForExistence(timeout: 5))
        shot("asleep-answer-waiting")
    }

    /// The Mac woke: the answer given while it slept went, after a relaunch, without being given again.
    @MainActor
    func test3_awakeAgain() throws {
        launch()
        XCTAssert(element(containing: "· Connected").waitForExistence(timeout: 30))
        card("Add the dark-mode toggle").tap()
        XCTAssert(app.staticTexts["Allowed"].waitForExistence(timeout: 30), "the answer kept while the Mac slept never went")
        shot("answer-delivered")
    }

    /// The relay is gone: the phone says it cannot reach it, rather than looking stuck.
    @MainActor
    func test4_relayDown() throws {
        launch()
        XCTAssert(element(containing: "Can't reach the relay").waitForExistence(timeout: 40))
        shot("relay-unreachable")
    }

    /// The largest accessibility text size: Home, a session and its question card still read whole.
    @MainActor
    func test5_largestText() throws {
        launch(["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        XCTAssert(app.staticTexts["Needs you"].waitForExistence(timeout: 30))
        shot("ax-home")
        card("Choose the database").tap()
        XCTAssert(app.buttons["Skip"].waitForExistence(timeout: 10))
        shot("ax-session-question")
        back()
        card("Explain the relay").tap()
        XCTAssert(element(containing: "dials out").waitForExistence(timeout: 10))
        shot("ax-session-markdown")
    }

    /// Reduce Transparency, set on the Simulator by the script: the glass the composer and the bars
    /// wear goes solid enough to read on.
    @MainActor
    func test6_reduceTransparency() throws {
        launch()
        XCTAssert(app.staticTexts["Needs you"].waitForExistence(timeout: 30))
        shot("rt-home")
        card("Add the dark-mode toggle").tap()
        XCTAssert(app.staticTexts["Allowed"].waitForExistence(timeout: 10))
        shot("rt-session")
    }

    // MARK: - Helpers

    @MainActor
    private func element(containing text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    /// A session's row on Home, scrolled to if it is further down.
    @MainActor
    private func card(_ title: String) -> XCUIElement {
        let card = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
        if !card.waitForExistence(timeout: 10) || !card.isHittable {
            for _ in 0..<6 where !(card.exists && card.isHittable) { app.swipeUp() }
        }
        XCTAssert(card.exists, "no row for \(title)")
        return card
    }

    @MainActor
    private func back() {
        app.navigationBars.buttons.element(boundBy: 0).tap()
    }

    /// After a push, a sheet or a send: lets the transition land before the picture is taken.
    @MainActor
    private func shot(_ name: String) {
        usleep(900_000)
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = environment["SHOTS"] {
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appending(path: "\(name).png"))
        }
    }
}
