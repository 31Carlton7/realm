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

        open("Add the dark-mode toggle")
        XCTAssert(app.staticTexts["Allow Bash?"].waitForExistence(timeout: 10))
        shot("session-request")
        let read = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Read, ")).firstMatch
        if read.waitForExistence(timeout: 3) {
            read.tap()
            shot("session-tool-open")
        }
        back()

        open("Choose the database")
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

        open("Explain the relay")
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

        open("Rework the transcript mapper")
        XCTAssert(element(containing: "Carry the plan as its own event").waitForExistence(timeout: 10))
        shot("session-plan")
        back()

        open("Train the social model")
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
        open("Add the dark-mode toggle")
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
        open("Add the dark-mode toggle")
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
        open("Choose the database")
        XCTAssert(app.buttons["Skip"].waitForExistence(timeout: 10))
        shot("ax-session-question")
        back()
        open("Explain the relay")
        // A long session opens at its newest message, whatever the text size.
        let newest = element(containing: "echo: Ship it on Friday")
        let arrived = newest.waitForExistence(timeout: 10)
        shot("ax-session-markdown")
        XCTAssert(arrived && newest.isHittable, "the session did not open at its newest message")
    }

    /// Reduce Transparency, set on the Simulator by the script: the glass the composer and the bars
    /// wear goes solid enough to read on.
    @MainActor
    func test6_reduceTransparency() throws {
        launch()
        XCTAssert(app.staticTexts["Needs you"].waitForExistence(timeout: 30))
        shot("rt-home")
        open("Add the dark-mode toggle")
        XCTAssert(app.staticTexts["Allowed"].waitForExistence(timeout: 10))
        shot("rt-session")
    }

    // MARK: - Helpers

    @MainActor
    private func element(containing text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    /// Opens a session from its row on Home. The row is scrolled until its head is clear of the bars
    /// — a row under the search field is not one a person can press — and pressed there, since at
    /// the largest text sizes its middle can be off the screen.
    @MainActor
    private func open(_ title: String) {
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
        // A list makes the rows near the screen, so one further down exists only once scrolled to.
        if !row.waitForExistence(timeout: 10) {
            for _ in 0..<12 where !row.exists { app.swipeUp(velocity: .slow) }
        }
        XCTAssert(row.exists, "no row for \(title)")
        let screen = app.windows.firstMatch.frame
        let clear = (screen.minY + 180)...(screen.maxY - 220)
        for _ in 0..<12 {
            let head = row.frame.minY + 24
            if clear.contains(head) { break }
            if head > clear.upperBound { app.swipeUp(velocity: .slow) } else { app.swipeDown(velocity: .slow) }
        }
        row.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: row.frame.width / 2, dy: 24)).tap()
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
