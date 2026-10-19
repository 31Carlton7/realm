import Foundation
@testable import RealmKit
import Testing

@Suite("mobile.v1 models (§6, §8)")
struct ModelTests {
    static func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    static let sessionRow = #"""
    {"id":"s1","title":"Fix the flaky test","spaceId":"sp1","spaceName":"Realm","agent":"claude","model":"claude-opus","status":"waiting",
     "needsYou":true,"unread":false,"updatedAt":1790000000000,"preview":"a field a newer Mac added"}
    """#

    @Test func aSessionRowDecodesAndIgnoresNewFields() throws {
        let row = try Self.decode(SessionRow.self, Self.sessionRow)
        #expect(row.id == "s1")
        #expect(row.status == .waiting)
        #expect(row.status.word == "Waiting on you")
        #expect(row.needsYou)
        #expect(row.model == "claude-opus")
        #expect(row.updatedAt == 1_790_000_000_000)
    }

    @Test func anUnknownStatusIsKeptNotRefused() throws {
        let row = try Self.decode(SessionRow.self, #"{"id":"s1","title":"t","spaceId":"x","spaceName":"y","agent":"codex","model":null,"status":"paused","needsYou":false,"unread":true,"updatedAt":1}"#)
        #expect(row.status == .other("paused"))
        #expect(row.model == nil)
    }

    @Test func homeDecodes() throws {
        let home = try Self.decode(Home.self, #"""
        {"mac":{"name":"MacBook Pro","asleepSince":null},"needsYou":[\#(Self.sessionRow)],
         "spaces":[{"id":"sp1","name":"Realm","icon":"🌊","color":"blue","sessions":[\#(Self.sessionRow)],"more":3,"pinned":true}],
         "usage":{"spent":1}}
        """#)
        #expect(home.mac.name == "MacBook Pro")
        #expect(home.needsYou.map(\.id) == ["s1"])
        #expect(home.spaces.first?.more == 3)
        #expect(home.spaces.first?.icon == .string("🌊"))
    }

    static let everyKind = #"""
    {"session":\#(sessionRow),"hasMore":false,"rows":[
      {"key":"u:1","seq":1,"kind":"user","text":"Run the tests"},
      {"key":"m:a","seq":2,"kind":"assistant","text":"Running","streaming":true},
      {"key":"k:a","seq":2,"kind":"thinking","text":"Hmm"},
      {"key":"t:1","seq":3,"kind":"tool","name":"Bash","summary":"pnpm test","state":"done","detail":"ok"},
      {"key":"r:1","seq":4,"kind":"request","requestId":"req1","tool":"AskUserQuestion","title":"Question","summary":"Which?","state":"pending",
       "questions":[{"question":"Which database?","header":"Database","multiSelect":false,"options":[{"label":"Postgres","description":"SQL"},{"label":"SQLite"}]}]},
      {"key":"p:1","seq":5,"kind":"plan","text":null,"steps":[{"text":"Write it","status":"done"}]},
      {"key":"e:6","seq":6,"kind":"notice","text":"Context compacted"},
      {"key":"e:7","seq":7,"kind":"error","text":"Out of credits","hint":"Top up"},
      {"key":"e:8:rate_limit","seq":8,"kind":"unknown","type":"rate_limit"},
      {"key":"d:9","seq":9,"kind":"diff","files":[{"path":"a.ts"}]},
      {"key":"t:2","seq":10,"kind":"tool","name":"Bash"}
    ]}
    """#

    @Test func everyRowKindDecodesAndUnknownKindsDoNotFail() throws {
        let opened = try Self.decode(OpenedSession.self, Self.everyKind)
        let contents = opened.rows.map(\.content)
        #expect(opened.rows.map(\.key) == ["u:1", "m:a", "k:a", "t:1", "r:1", "p:1", "e:6", "e:7", "e:8:rate_limit", "d:9", "t:2"])
        #expect(contents[0] == .user(text: "Run the tests"))
        #expect(contents[1] == .assistant(text: "Running", streaming: true))
        #expect(contents[2] == .thinking(text: "Hmm"))
        #expect(contents[3] == .tool(name: "Bash", summary: "pnpm test", state: .done, detail: "ok"))
        guard case .request(let request) = contents[4] else {
            Issue.record("the request row did not decode")
            return
        }
        #expect(request.requestId == "req1")
        #expect(request.state == .pending)
        #expect(request.questions?.first?.options.map(\.label) == ["Postgres", "SQLite"])
        #expect(request.questions?.first?.options.first?.description == "SQL")
        #expect(contents[5] == .plan(text: nil, steps: [PlanStep(text: "Write it", status: "done")]))
        #expect(contents[6] == .notice(text: "Context compacted"))
        #expect(contents[7] == .error(text: "Out of credits", hint: "Top up"))
        #expect(contents[8] == .unknown(kind: "unknown", type: "rate_limit"))
        // A kind this phone has never heard of.
        #expect(contents[9] == .unknown(kind: "diff", type: nil))
        // A known kind missing its fields is drawn as unknown, not dropped and not fatal.
        #expect(contents[10] == .unknown(kind: "tool", type: nil))
    }

    @Test func everyRowKindEncodesBackToTheWireShape() throws {
        let opened = try Self.decode(OpenedSession.self, Self.everyKind)
        let again = try JSONDecoder().decode(OpenedSession.self, from: try JSONEncoder().encode(opened))
        #expect(again == opened)
        let home = try Self.decode(Home.self, ##"{"mac":{"name":"M"},"needsYou":[],"spaces":[{"id":"sp","name":"S","icon":"emoji:🌊","color":"#112233","sessions":[\##(Self.sessionRow)],"more":2}]}"##)
        #expect(try JSONDecoder().decode(Home.self, from: try JSONEncoder().encode(home)) == home)
    }

    @Test func aQuestionSaysWhetherItTakesWordsOfYourOwn() throws {
        let questions = try Self.decode([Question].self, #"""
        [{"question":"Which?","header":"H","multiSelect":false,"options":[{"label":"A"}]},
         {"question":"Where?","header":"","multiSelect":false,"options":[{"label":"B"}],"allowOther":false},
         {"question":"Token?","header":"","multiSelect":false,"options":[],"secret":true}]
        """#)
        // The desktop's rule: words of your own unless the agent said no.
        #expect(questions.map(\.allowOther) == [true, false, true])
        #expect(questions.map(\.secret) == [false, false, true])
        #expect(questions.map(\.takesText) == [true, false, true])
    }

    @Test func aPhase1MacsQuestionIsAnsweredByItsTextAndADiffLineByItsFirstCharacter() throws {
        let questions = try Self.decode([Question].self, #"""
        [{"question":"Which?","header":"","multiSelect":false,"options":[{"label":"A"}]},
         {"question":"Which file?","header":"","multiSelect":false,"options":[],"id":"file","kind":"file"}]
        """#)
        #expect(questions.map(\.answerKey) == ["Which?", "file"])
        #expect(questions.map(\.isAnswerableHere) == [true, false], "a file is picked on the Mac, from its own workspace")
        #expect(questions[0].options[0].answerValue == "A")
        #expect(["--- a/x", "+++ b/x", "@@ -1 +1 @@", "+a", "-b", " c", "\\ No newline at end of file", ""].map(DiffPage.kind(of:)) ==
                [.fileHeader, .fileHeader, .hunkHeader, .added, .removed, .context, .note, .context])
        #expect(MadeFile(path: "/Users/me/Desktop/shot.png", size: 1).name == "shot.png")
        // A Phase 1 Mac's row names neither its agent nor its model: the phone's own table and the id stand in.
        let row = try Self.decode(SessionRow.self, Self.sessionRow)
        #expect(row.agentDisplayName == "Claude")
        #expect(row.modelDisplayName == "claude-opus")
    }

    @Test func aRequestSaysWhatItAsksFor() throws {
        let opened = try Self.decode(OpenedSession.self, Self.everyKind)
        guard case .request(let question) = opened.rows[4].content else {
            Issue.record("no request row")
            return
        }
        #expect(question.kind == .questions(question.questions ?? []))
        let plan = TranscriptRow.Request(requestId: "p", tool: "ExitPlanMode", title: "Exit plan mode?", summary: "# Ship it",
                                         state: .pending, questions: nil)
        #expect(plan.kind == .plan)
        let bash = TranscriptRow.Request(requestId: "b", tool: "Bash", title: "Allow Bash?", summary: "pnpm test", state: .pending,
                                         questions: [])
        #expect(bash.kind == .permission)
    }

    @Test func answersMapQuestionsToTheirPickedLabels() {
        let questions = [
            Question(question: "Which database?", header: "Database", multiSelect: false,
                     options: [QuestionOption(label: "Postgres", description: nil), QuestionOption(label: "SQLite", description: nil)]),
            Question(question: "Which regions?", header: "Regions", multiSelect: true,
                     options: ["us-east", "eu-west", "ap-south"].map { QuestionOption(label: $0, description: nil) }),
            Question(question: "Anything else?", header: "", multiSelect: false, options: []),
        ]
        let answers = Question.answers(questions, picks: ["Which database?": ["SQLite"], "Which regions?": ["ap-south", "us-east"]])
        #expect(answers == ["Which database?": "SQLite", "Which regions?": "us-east, ap-south"])
        #expect(Question.answers(questions, picks: [:]).isEmpty)
    }

    @Test func responsesCarryResultsOrErrors() throws {
        #expect(Envelope.classify(Data(#"{"id":7,"ok":true,"result":{"at":5}}"#.utf8)) == .response(id: 7))
        let pong = try Envelope.result(Pong.self, from: Data(#"{"id":7,"ok":true,"result":{"at":5,"extra":1}}"#.utf8))
        #expect(pong.at == 5)
        #expect(throws: ChannelError.rpc(RPCError(code: "NOT_FOUND", message: "no session"))) {
            try Envelope.result(Pong.self, from: Data(#"{"id":7,"ok":false,"error":{"code":"NOT_FOUND","message":"no session"}}"#.utf8))
        }
        // The desktop's RPC answers with the id it parsed; a numeric string is the same call.
        #expect(Envelope.classify(Data(#"{"id":"8","ok":true,"result":{}}"#.utf8)) == .response(id: 8))
    }

    @Test func eventsDecodeByName() throws {
        guard case .event(.sessionRows(let rows)) = Envelope.classify(Data(#"{"event":"session.rows","payload":{"id":"s1","rows":[{"key":"u:1","seq":1,"kind":"user","text":"hi"}]}}"#.utf8)) else {
            Issue.record("session.rows did not decode")
            return
        }
        #expect(rows.id == "s1")
        guard case .event(.sessionStatus(let status)) = Envelope.classify(Data(#"{"event":"session.status","payload":{"id":"s1","status":"running"}}"#.utf8)) else {
            Issue.record("session.status did not decode")
            return
        }
        #expect(status.status == .running)
        guard case .event(.homeChanged) = Envelope.classify(Data(#"{"event":"home.changed","payload":{}}"#.utf8)) else {
            Issue.record("home.changed did not decode")
            return
        }
        guard case .event(.pairResult(let declined)) = Envelope.classify(Data(#"{"event":"pair.result","payload":{"ok":false,"reason":"declined"}}"#.utf8)) else {
            Issue.record("pair.result did not decode")
            return
        }
        #expect(declined == PairResult(ok: false, phoneId: nil, reason: "declined"))
        guard case .event(.unknown(name: "session.queue")) = Envelope.classify(Data(#"{"event":"session.queue","payload":{"id":"s1"}}"#.utf8)) else {
            Issue.record("an unknown event was not passed on as unknown")
            return
        }
    }

    @Test func requestsEncodeAsTheEnvelope() throws {
        struct Params: Encodable { let id: String; let text: String; let delivery: Delivery? }
        let data = try Envelope.request(id: 3, method: "session.send", params: Params(id: "s1", text: "a/b", delivery: nil))
        let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(object["id"] as? Int == 3)
        #expect(object["method"] as? String == "session.send")
        #expect(object["params"] as? [String: String] == ["id": "s1", "text": "a/b"])
        #expect(String(decoding: data, as: UTF8.self).contains("a/b"))
        let empty = try Envelope.request(id: 1, method: "ping", params: EmptyParams())
        #expect(String(decoding: empty, as: UTF8.self).contains(#""params":{}"#))
    }
}

extension IncomingMessage: Equatable {
    public static func == (lhs: IncomingMessage, rhs: IncomingMessage) -> Bool {
        switch (lhs, rhs) {
        case (.response(let a), .response(let b)): a == b
        case (.unrecognized, .unrecognized): true
        default: false
        }
    }
}
