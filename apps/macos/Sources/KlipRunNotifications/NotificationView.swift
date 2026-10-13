import SwiftUI
import AppKit
import NotificationCore

struct NotificationView: View {
    let event: AgentNotification
    let open: () -> Void
    let dismiss: () -> Void
    var dragging: (Bool) -> Void = { _ in }

    var body: some View {
        HStack(alignment: .bottom, spacing: 12) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(event.kind == .finished ? "KlipRun · Ответ готов" : "KlipRun · Нужен ты")
                        .font(.system(size: 11, weight: .medium)).foregroundStyle(accent)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .overlay(WindowDragHandle(dragging: dragging))
                        .help("Перетащите уведомление в удобное место")
                    Button(action: dismiss) { Image(systemName: "xmark").font(.system(size: 11)) }
                        .buttonStyle(.plain).foregroundStyle(.gray)
                        .accessibilityLabel("Закрыть уведомление")
                }
                Text(String(event.title.prefix(250)))
                    .font(.system(size: 14, weight: .semibold)).lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
                Text(event.message).font(.system(size: 13)).foregroundStyle(Color(white: 0.75))
                    .fixedSize(horizontal: false, vertical: true)
                Button("Открыть сессию", action: open)
                    .font(.system(size: 12, weight: .medium)).buttonStyle(.plain).foregroundStyle(accent)
            }
            .padding(16).frame(width: 285, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 16).fill(Color(red: 0.05, green: 0.07, blue: 0.10)))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(accent.opacity(0.5), lineWidth: 1))
            .overlay(alignment: .bottomTrailing) {
                Triangle().fill(Color(red: 0.05, green: 0.07, blue: 0.10))
                    .frame(width: 14, height: 18).rotationEffect(.degrees(-90)).offset(x: 11, y: -26)
            }
            .shadow(color: .black.opacity(0.25), radius: 8, y: 4)
            Button(action: open) { PixelCoworker(sessionID: event.sessionID) }
                .buttonStyle(.plain).frame(width: 85, height: 105)
                .accessibilityLabel("Открыть сессию \(event.title)")
        }
        .padding(12).frame(width: 420, alignment: .top)
        .foregroundStyle(.white).environment(\.colorScheme, .dark)
    }

    private var accent: Color {
        event.kind == .finished ? Color(red: 0.35, green: 0.65, blue: 1)
            : Color(red: 0.94, green: 0.76, blue: 0.35)
    }
}

private struct WindowDragHandle: NSViewRepresentable {
    let dragging: (Bool) -> Void
    func makeNSView(context: Context) -> DragHandleView { DragHandleView() }
    func updateNSView(_ view: DragHandleView, context: Context) { view.dragging = dragging }

    final class DragHandleView: NSView {
        var dragging: (Bool) -> Void = { _ in }
        private var mouseOffset: NSPoint?
        override var mouseDownCanMoveWindow: Bool { false }
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
        override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }
        override func mouseDown(with event: NSEvent) {
            guard let window else { return }
            let point = window.convertPoint(toScreen: event.locationInWindow)
            mouseOffset = NSPoint(x: point.x - window.frame.minX, y: point.y - window.frame.minY)
            dragging(true)
        }
        override func mouseDragged(with event: NSEvent) {
            guard let window, let mouseOffset else { return }
            let point = window.convertPoint(toScreen: event.locationInWindow)
            window.setFrameOrigin(NSPoint(x: point.x - mouseOffset.x, y: point.y - mouseOffset.y))
        }
        override func mouseUp(with event: NSEvent) {
            guard mouseOffset != nil else { return }
            mouseOffset = nil
            dragging(false)
        }
    }
}

private struct Triangle: Shape {
    func path(in rect: CGRect) -> Path {
        Path { p in
            p.move(to: .zero); p.addLine(to: CGPoint(x: rect.maxX, y: 0))
            p.addLine(to: CGPoint(x: rect.midX, y: rect.maxY)); p.closeSubpath()
        }
    }
}

/// The same stepped silhouette and per-session palette as the Office coworker.
private struct PixelCoworker: View {
    let sessionID: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 0.1, paused: reduceMotion)) { timeline in
            let phase = reduceMotion ? 0 : timeline.date.timeIntervalSinceReferenceDate * 4
            Canvas { context, size in
                context.scaleBy(x: size.width / 100, y: size.height / 100)
                context.translateBy(x: 4, y: 28 + (reduceMotion ? 0 : sin(phase) * 2))
                let color = coworkerColor
                var body = Path()
                for (index, point) in [(16.0, 0.0), (72, 0), (72, 8), (80, 8), (80, 41),
                                       (72, 41), (72, 49), (16, 49), (16, 41), (8, 41), (8, 8), (16, 8)].enumerated() {
                    if index == 0 { body.move(to: CGPoint(x: point.0, y: point.1)) }
                    else { body.addLine(to: CGPoint(x: point.0, y: point.1)) }
                }
                body.closeSubpath(); context.fill(body, with: .color(color))
                for x in [22.0, 42, 62] { fill(&context, x, 41, 10, 18, color) }
                fill(&context, 25, 17, 6, 10, Color(red: 0.10, green: 0.13, blue: 0.17))
                fill(&context, 55, 17, 6, 10, Color(red: 0.10, green: 0.13, blue: 0.17))
                fill(&context, 36, 33, 14, 4, .black.opacity(0.35))
                fill(&context, 0, 21, 8, 20, color)
                var arm = context
                arm.translateBy(x: 80, y: 24)
                arm.rotate(by: .degrees(-145 + (reduceMotion ? 0 : sin(phase * 1.6) * 20)))
                fill(&arm, 0, 0, 8, 25, color)
            }
        }
        .accessibilityHidden(true)
    }

    private func fill(_ context: inout GraphicsContext, _ x: Double, _ y: Double,
                      _ width: Double, _ height: Double, _ color: Color) {
        context.fill(Path(CGRect(x: x, y: y, width: width, height: height)), with: .color(color))
    }

    private var coworkerColor: Color {
        let colors: [UInt32] = [0xed987f, 0x8eb5ff, 0xc3a0ef, 0x8dd5ae, 0xefd081, 0xed9dc5, 0x85d5de]
        let hash = sessionID.utf16.reduce(UInt32(0)) { ($0 &* 31) &+ UInt32($1) }
        let rgb = colors[Int(hash % UInt32(colors.count))]
        return Color(red: Double(rgb >> 16) / 255, green: Double((rgb >> 8) & 255) / 255,
                     blue: Double(rgb & 255) / 255)
    }
}
