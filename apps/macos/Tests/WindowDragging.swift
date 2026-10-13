import AppKit
import SwiftUI
import NotificationCore

/// Standalone AppKit regression: dispatch mouse events through the real window,
/// rather than checking hit testing or calling setFrameOrigin directly.
@main struct WindowDraggingTest {
    @MainActor static func main() {
        setbuf(stdout, nil)
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        var dragStates: [Bool] = []
        let window = NSPanel(contentRect: NSRect(x: 100, y: 100, width: 420, height: 230),
                             styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.level = .statusBar
        window.isMovable = true
        window.isOpaque = false; window.backgroundColor = .clear
        window.hidesOnDeactivate = false; window.isReleasedWhenClosed = false
        let event = AgentNotification(sessionID: "ses_drag_test", title: "Пример перетаскивания", kind: .input, revision: 1)
        let content = NSHostingView(rootView: NotificationView(event: event, open: {}, dismiss: {},
                                                               dragging: { dragStates.append($0) }))
        window.contentView = content
        window.setContentSize(content.fittingSize)
        window.orderFrontRegardless()
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))

        let before = window.frame.origin
        let start = window.convertPoint(toScreen: NSPoint(x: 60, y: window.frame.height - 35))
        func send(_ type: NSEvent.EventType, _ point: NSPoint) {
            let mouse = NSEvent.mouseEvent(with: type, location: window.convertPoint(fromScreen: point),
                                           modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                           windowNumber: window.windowNumber, context: nil,
                                           eventNumber: 1, clickCount: 1, pressure: type == .leftMouseUp ? 0 : 1)!
            app.sendEvent(mouse)
        }
        send(.leftMouseDown, start)
        send(.leftMouseDragged, NSPoint(x: start.x + 80, y: start.y - 40))
        send(.leftMouseUp, NSPoint(x: start.x + 80, y: start.y - 40))
        let after = window.frame.origin
        print("Mouse dispatch: before=\(before), after=\(after), lifecycle=\(dragStates)")
        guard abs(after.x - before.x - 80) < 1, abs(after.y - before.y + 40) < 1 else {
            window.orderOut(nil)
            fputs("FAIL: mouse drag did not move the notification\n", stderr)
            exit(1)
        }
        guard dragStates == [true, false], !window.isKeyWindow else {
            fputs("FAIL: drag lifecycle or focus behavior\n", stderr)
            exit(1)
        }
        let secondStart = window.convertPoint(toScreen: NSPoint(x: 60, y: window.frame.height - 35))
        send(.leftMouseDown, secondStart)
        send(.leftMouseDragged, NSPoint(x: secondStart.x - 45, y: secondStart.y + 25))
        send(.leftMouseDragged, NSPoint(x: secondStart.x - 90, y: secondStart.y + 50))
        send(.leftMouseUp, NSPoint(x: secondStart.x - 90, y: secondStart.y + 50))
        guard abs(window.frame.minX - before.x + 10) < 1,
              abs(window.frame.minY - before.y - 10) < 1,
              dragStates == [true, false, true, false], !window.isKeyWindow else {
            fputs("FAIL: repeated reverse drag drifted or broke lifecycle\n", stderr)
            exit(1)
        }
        window.orderOut(nil)
        print("PASS: notification moves in both directions through repeated AppKit mouse events without drift or taking keyboard focus")
    }
}
