import Foundation

public struct BoardSnapshot: Decodable {
    private struct Column: Decodable { let cards: [SessionCard] }
    private let columns: [String: Column]

    public var cards: [SessionCard] {
        var result: [SessionCard] = []
        var seen = Set<String>()
        func visit(_ card: SessionCard) {
            guard seen.insert(card.sessionID).inserted else { return }
            result.append(card)
            card.children.forEach(visit)
        }
        for key in ["attention", "running", "idle"] {
            columns[key]?.cards.forEach(visit)
        }
        return result
    }
}
