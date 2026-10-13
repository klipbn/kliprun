import Foundation
import CoreGraphics
import Testing
@testable import NotificationCore

struct NotificationPreferencesTests {
    @Test func durationPersistsAndZeroMeansUntilDismissed() {
        let suite = "local.kliprun.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = NotificationPreferences(defaults: defaults)
        #expect(preferences.displaySeconds == 8)
        #expect(preferences.setDisplaySeconds(17))
        #expect(NotificationPreferences(defaults: defaults).displaySeconds == 17)
        #expect(preferences.setDisplaySeconds(0))
        #expect(NotificationPreferences(defaults: defaults).displaySeconds == 0)
        for invalid in [-1.0, Double.nan, Double.infinity, 0.5, 3601] {
            #expect(!preferences.setDisplaySeconds(invalid))
            #expect(preferences.displaySeconds == 0)
        }
    }

    @Test func savedTopEdgeSurvivesHeightChangesAndRestart() {
        let suite = "local.kliprun.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = NotificationPreferences(defaults: defaults)
        let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
        #expect(preferences.origin(for: CGSize(width: 420, height: 150), screens: [screen], fallback: screen)
                == CGPoint(x: 1008, y: 738))
        preferences.saveTopLeft(CGPoint(x: 100, y: 800))
        let restored = NotificationPreferences(defaults: defaults)
        #expect(restored.origin(for: CGSize(width: 420, height: 200), screens: [screen], fallback: screen)
                == CGPoint(x: 100, y: 600))
        restored.resetPosition()
        #expect(preferences.savedTopLeft == nil)
    }

    @Test func positionsStayVisibleAfterScreenRemovalAndOnNegativeCoordinateDisplays() {
        let suite = "local.kliprun.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = NotificationPreferences(defaults: defaults)
        let main = CGRect(x: 0, y: 0, width: 1440, height: 900)
        let secondary = CGRect(x: -1280, y: 0, width: 1280, height: 800)
        preferences.saveTopLeft(CGPoint(x: -900, y: 700))
        #expect(preferences.origin(for: CGSize(width: 420, height: 150), screens: [secondary, main], fallback: main)
                == CGPoint(x: -900, y: 550))
        let recovered = preferences.origin(for: CGSize(width: 420, height: 150), screens: [main], fallback: main)
        #expect(main.contains(CGRect(origin: recovered, size: CGSize(width: 420, height: 150))))
        preferences.saveTopLeft(CGPoint(x: 1420, y: 20))
        #expect(preferences.origin(for: CGSize(width: 420, height: 150), screens: [main], fallback: main)
                == CGPoint(x: 1020, y: 0))
    }
}
