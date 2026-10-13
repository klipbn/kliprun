import Foundation
import CoreGraphics

public final class NotificationPreferences {
    private let defaults: UserDefaults
    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    public var displaySeconds: Double {
        guard let seconds = defaults.object(forKey: "notification.displaySeconds") as? NSNumber,
              validDuration(seconds.doubleValue) else { return 8 }
        return seconds.doubleValue
    }
    public var savedTopLeft: CGPoint? {
        guard let x = defaults.object(forKey: "notification.positionX") as? NSNumber,
              let y = defaults.object(forKey: "notification.positionY") as? NSNumber,
              x.doubleValue.isFinite, y.doubleValue.isFinite else { return nil }
        return CGPoint(x: x.doubleValue, y: y.doubleValue)
    }
    @discardableResult public func setDisplaySeconds(_ seconds: Double) -> Bool {
        guard validDuration(seconds) else { return false }
        defaults.set(seconds, forKey: "notification.displaySeconds")
        return true
    }
    public func saveTopLeft(_ point: CGPoint) {
        guard point.x.isFinite, point.y.isFinite else { return }
        defaults.set(Double(point.x), forKey: "notification.positionX")
        defaults.set(Double(point.y), forKey: "notification.positionY")
    }
    public func resetPosition() {
        defaults.removeObject(forKey: "notification.positionX")
        defaults.removeObject(forKey: "notification.positionY")
    }
    public func origin(for size: CGSize, screens: [CGRect], fallback: CGRect) -> CGPoint {
        guard let topLeft = savedTopLeft else {
            return CGPoint(x: max(fallback.minX, fallback.maxX - size.width - 12),
                           y: max(fallback.minY, fallback.maxY - size.height - 12))
        }
        let wanted = CGRect(x: topLeft.x, y: topLeft.y - size.height, width: size.width, height: size.height)
        func overlap(_ frame: CGRect) -> CGFloat {
            let intersection = frame.intersection(wanted)
            return intersection.isNull ? 0 : intersection.width * intersection.height
        }
        let best = screens.max { overlap($0) < overlap($1) }
        let frame = best.flatMap { overlap($0) > 0 ? $0 : nil } ?? fallback
        return CGPoint(x: min(max(wanted.minX, frame.minX), max(frame.minX, frame.maxX - size.width)),
                       y: min(max(wanted.minY, frame.minY), max(frame.minY, frame.maxY - size.height)))
    }
    private func validDuration(_ seconds: Double) -> Bool {
        seconds.isFinite && seconds.rounded() == seconds && (0...3600).contains(seconds)
    }
}
