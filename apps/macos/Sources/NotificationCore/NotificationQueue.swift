public struct NotificationQueue {
    private var pending: [AgentNotification] = []
    public init() {}
    public var count: Int { pending.count }
    public mutating func enqueue(_ events: [AgentNotification]) {
        var seen = Set(pending.map(\.id))
        for event in events where seen.insert(event.id).inserted {
            pending.append(event)
            if pending.count > 20 { pending.removeFirst() }
        }
    }
    public mutating func next() -> AgentNotification? {
        pending.isEmpty ? nil : pending.removeFirst()
    }
    public mutating func reconcile(_ cards: [SessionCard]) {
        let current = Set(cards.compactMap { AgentNotification.from($0)?.id })
        pending.removeAll { !current.contains($0.id) }
    }
}
