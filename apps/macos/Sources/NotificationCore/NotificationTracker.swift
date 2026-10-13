import Foundation

public struct SessionCard: Decodable, Equatable {
    public let sessionID: String
    public let title: String
    public let column: String
    public let stage: String
    public let stageSince: Double
    public let finishedAt: Double?
    public var children: [SessionCard] = []

    enum CodingKeys: String, CodingKey {
        case sessionID = "session_id", title, column, stage
        case stageSince = "stage_since", finishedAt = "finished_at", children
    }

    public init(sessionID: String, title: String, column: String, stage: String,
                stageSince: Double, finishedAt: Double? = nil, children: [SessionCard] = []) {
        self.sessionID = sessionID; self.title = title; self.column = column
        self.stage = stage; self.stageSince = stageSince; self.finishedAt = finishedAt
        self.children = children
    }
}

public struct AgentNotification: Equatable, Identifiable {
    public enum Kind: String { case finished, question, permission, input }
    public let sessionID: String
    public let title: String
    public let kind: Kind
    public let revision: Double
    public var id: String { "\(sessionID):\(kind.rawValue):\(revision)" }

    public var message: String {
        switch kind {
        case .finished: return "Ответ готов. Можно посмотреть результат."
        case .question: return "У меня вопрос. Нужен твой ответ."
        case .permission: return "Нужно твоё разрешение."
        case .input: return "Нужен твой ввод: ответ или разрешение."
        }
    }

    public init(sessionID: String, title: String, kind: Kind, revision: Double) {
        self.sessionID = sessionID; self.title = title; self.kind = kind; self.revision = revision
    }

    public static func from(_ card: SessionCard) -> AgentNotification? {
        let kind: Kind
        let revision: Double
        if card.column == "attention" {
            kind = card.stage == "Waiting for permission" ? .permission
                : card.stage == "Waiting for answer" ? .question : .input
            revision = card.stageSince
        } else if card.column == "idle", card.stage == "Finished", let finished = card.finishedAt {
            kind = .finished; revision = finished
        } else { return nil }
        guard revision.isFinite, revision > 0 else { return nil }
        return AgentNotification(sessionID: card.sessionID,
                                 title: card.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                    ? "Сессия без названия" : card.title,
                                 kind: kind, revision: revision)
    }
}

public struct NotificationTracker {
    private var initialized = false
    private var revisions: [String: [AgentNotification.Kind: Double]] = [:]
    private var order: [String] = []
    public init() {}
    public mutating func observe(_ cards: [SessionCard]) -> [AgentNotification] {
        var events: [AgentNotification] = []
        for card in cards {
            let known = revisions[card.sessionID] != nil
            if !known {
                if order.count >= 1000 { revisions.removeValue(forKey: order.removeFirst()) }
                order.append(card.sessionID)
                revisions[card.sessionID] = [:]
            }
            guard let event = AgentNotification.from(card) else { continue }
            if initialized, (known || event.kind != .finished),
               revisions[card.sessionID]?[event.kind] != event.revision {
                events.append(event)
            }
            revisions[card.sessionID]?[event.kind] = event.revision
        }
        initialized = true
        return events
    }
}
