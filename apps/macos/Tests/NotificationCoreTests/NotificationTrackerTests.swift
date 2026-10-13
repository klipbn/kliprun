import Testing
import Foundation
@testable import NotificationCore

struct NotificationTrackerTests {
    @Test func confirmedCompletionAfterRunningEmitsSessionTitle() {
        var tracker = NotificationTracker()
        #expect(tracker.observe([card("running", "Working")]).isEmpty)
        let events = tracker.observe([card("idle", "Finished", finished: 200)])
        #expect(events.count == 1)
        #expect(events.first?.title == "Исправление отчёта")
        #expect(events.first?.kind == .finished)
    }

    @Test func startupIsSilentAndSnapshotsDoNotRepeatButNewRepliesDo() {
        var tracker = NotificationTracker()
        #expect(tracker.observe([card("idle", "Finished", finished: 200)]).isEmpty)
        #expect(tracker.observe([card("idle", "Finished", finished: 200)]).isEmpty)
        _ = tracker.observe([card("running", "Working")])
        #expect(tracker.observe([card("idle", "Finished", finished: 300)]).count == 1)
        #expect(tracker.observe([card("idle", "Finished", finished: 300)]).isEmpty)
    }

    @Test func unknownAndReappearingSnapshotsNeverInventCompletions() {
        var tracker = NotificationTracker()
        _ = tracker.observe([card("running", "Working")])
        for stage in ["Status unknown", "Inactive", "Interrupted", "Error", "Finished"] {
            #expect(tracker.observe([card("idle", stage)]).isEmpty)
        }
        #expect(tracker.observe([card("idle", "Finished", finished: 200)]).count == 1)
        _ = tracker.observe([])
        _ = tracker.observe([card("idle", "Status unknown")])
        #expect(tracker.observe([card("idle", "Finished", finished: 200)]).isEmpty)
        let oldSession = SessionCard(sessionID: "ses_new", title: "Old reply", column: "idle",
                                    stage: "Finished", stageSince: 100, finishedAt: 100)
        #expect(tracker.observe([oldSession]).isEmpty)
    }

    @Test func waitingReasonsAreTruthfulAndHeartbeatsDoNotRepeat() {
        var tracker = NotificationTracker()
        _ = tracker.observe([card("running", "Working")])
        for (stage, kind) in [("Waiting for answer", AgentNotification.Kind.question),
                              ("Waiting for permission", .permission), ("Waiting for input", .input)] {
            #expect(tracker.observe([card("attention", stage)]).first?.kind == kind)
            #expect(tracker.observe([card("attention", stage)]).isEmpty)
        }
    }

    @Test func boardDecodingIncludesVisibleDescendants() throws {
        let json = #"{"columns":{"attention":{"cards":[{"session_id":"ses_parent","title":"Parent","column":"attention","stage":"Waiting for input","stage_since":100,"finished_at":null,"children":[{"session_id":"ses_child","title":"Child","column":"attention","stage":"Waiting for answer","stage_since":100,"finished_at":null,"children":[]}]}]},"running":{"cards":[]},"idle":{"cards":[]}}}"#
        let board = try JSONDecoder().decode(BoardSnapshot.self, from: Data(json.utf8))
        #expect(board.cards.map(\.sessionID) == ["ses_parent", "ses_child"])
    }

    @Test func queueIsBoundedDeduplicatesAndDropsResolvedQuestions() {
        var queue = NotificationQueue()
        let events = (1...25).map {
            AgentNotification(sessionID: "ses_\($0)", title: "Demo", kind: .input, revision: 100)
        }
        queue.enqueue(events + events)
        #expect(queue.count == 20)
        let waiting = SessionCard(sessionID: "ses_25", title: "Demo", column: "attention",
                                  stage: "Waiting for input", stageSince: 100)
        queue.reconcile([waiting])
        #expect(queue.count == 1)
        #expect(queue.next()?.sessionID == "ses_25")
        #expect(queue.next() == nil)
        queue.enqueue([events[24]])
        queue.reconcile([])
        #expect(queue.count == 0)
    }

    private func card(_ column: String, _ stage: String, finished: Double? = nil) -> SessionCard {
        SessionCard(sessionID: "ses_demo", title: "Исправление отчёта", column: column,
                    stage: stage, stageSince: finished ?? 100, finishedAt: finished)
    }
}
