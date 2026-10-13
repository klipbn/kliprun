import AppKit
import SwiftUI
import NotificationCore

/// Refuse redirects: this companion only reads the configured loopback server.
private final class LoopbackDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

@MainActor
final class AppController: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var statusItem: NSStatusItem!
    private let connectionItem = NSMenuItem(title: "Подключение…", action: nil, keyEquivalent: "")
    private let pauseItem = NSMenuItem(title: "Приостановить уведомления", action: #selector(togglePause), keyEquivalent: "")
    private let durationMenu = NSMenu(title: "Время показа")
    private let preferences: NotificationPreferences
    private var panel: NSPanel?
    private var tracker = NotificationTracker()
    private var queue = NotificationQueue()
    private var current: AgentNotification?
    private var expiration: Timer?
    private var pollTimer: Timer?
    private var polling = false
    private var paused = false
    private var dragging = false
    private var etag: String?
    private var pollTask: Task<Void, Never>?
    private let baseURL: URL
    private let session = URLSession(configuration: .ephemeral, delegate: LoopbackDelegate(), delegateQueue: nil)

    init(port: Int, defaults: UserDefaults = .standard) {
        baseURL = URL(string: "http://127.0.0.1:\(port)")!
        preferences = NotificationPreferences(defaults: defaults)
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // A second launch must not produce duplicate desktop notifications.
        if let id = Bundle.main.bundleIdentifier,
           NSRunningApplication.runningApplications(withBundleIdentifier: id).count > 1 {
            NSApp.terminate(nil); return
        }
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = NSImage(systemSymbolName: "person.crop.square", accessibilityDescription: "KlipRun")
        let menu = NSMenu()
        menu.addItem(connectionItem); menu.addItem(.separator())
        let durationItem = NSMenuItem(title: "Время показа", action: nil, keyEquivalent: "")
        durationItem.submenu = durationMenu
        menu.addItem(durationItem)
        updateDurationMenu()
        for item in [NSMenuItem(title: "Открыть KlipRun", action: #selector(openBoard), keyEquivalent: ""),
                     pauseItem,
                     NSMenuItem(title: "Показать пример", action: #selector(preview), keyEquivalent: ""),
                     NSMenuItem(title: "Вернуть в правый верхний угол", action: #selector(resetPosition), keyEquivalent: ""),
                     NSMenuItem(title: "Выход", action: #selector(quit), keyEquivalent: "q")] {
            item.target = self; menu.addItem(item)
        }
        statusItem.menu = menu
        if CommandLine.arguments.contains("--preview") { preview() }
        poll()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.poll() }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        pollTimer?.invalidate(); expiration?.invalidate(); pollTask?.cancel()
        session.invalidateAndCancel()
    }

    private func poll() {
        guard !polling else { return }
        polling = true
        pollTask = Task { [weak self] in
            guard let self else { return }
            defer { self.polling = false }
            var request = URLRequest(url: baseURL.appendingPathComponent("api/board"))
            request.timeoutInterval = 5
            request.cachePolicy = .reloadIgnoringLocalCacheData
            if let etag { request.setValue(etag, forHTTPHeaderField: "If-None-Match") }
            do {
                let (data, response) = try await session.data(for: request)
                guard !Task.isCancelled else { return }
                guard let http = response as? HTTPURLResponse,
                      http.statusCode == 200 || http.statusCode == 304 else {
                    throw URLError(.badServerResponse)
                }
                if http.statusCode == 200 {
                    let board = try JSONDecoder().decode(BoardSnapshot.self, from: data)
                    etag = http.value(forHTTPHeaderField: "ETag")
                    let events = tracker.observe(board.cards)
                    if !paused {
                        queue.reconcile(board.cards)
                        if preferences.displaySeconds > 0, !dragging, let current,
                           !board.cards.contains(where: { AgentNotification.from($0)?.id == current.id }),
                           current.sessionID != "ses_preview" { hideCurrent() }
                        queue.enqueue(events)
                        showNext()
                    }
                }
                connectionItem.title = paused ? "Уведомления приостановлены" : "KlipRun подключён"
                statusItem.button?.toolTip = "KlipRun · \(baseURL.absoluteString)"
            } catch {
                guard !Task.isCancelled else { return }
                connectionItem.title = "Сервер KlipRun недоступен"
                statusItem.button?.toolTip = "Запусти сервер KlipRun на \(baseURL.absoluteString)"
                // Reconnect establishes a fresh baseline, without replaying stale replies.
                etag = nil; tracker = NotificationTracker(); queue = NotificationQueue()
                if preferences.displaySeconds > 0, !dragging, current?.sessionID != "ses_preview" { hideCurrent() }
            }
        }
    }

    private func showNext() {
        guard current == nil, !paused, let event = queue.next() else { return }
        show(event)
    }

    private func show(_ event: AgentNotification) {
        hideCurrent()
        current = event
        let window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 420, height: 230),
                             styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.level = .statusBar
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        window.isOpaque = false; window.backgroundColor = .clear; window.hasShadow = false
        window.hidesOnDeactivate = false; window.isReleasedWhenClosed = false
        window.isMovable = true
        let content = NSHostingView(rootView: NotificationView(event: event, open: { [weak self] in
            self?.openSession(event)
        }, dismiss: { [weak self] in self?.dismissCurrent() }, dragging: { [weak self] active in
            self?.dragging = active
            self?.scheduleExpiration()
        }))
        window.contentView = content
        window.setContentSize(content.fittingSize)
        position(window)
        panel = window
        window.delegate = self
        window.orderFrontRegardless()
        scheduleExpiration()
    }

    private func scheduleExpiration() {
        expiration?.invalidate(); expiration = nil
        guard current != nil, !dragging, preferences.displaySeconds > 0 else { return }
        expiration = Timer.scheduledTimer(withTimeInterval: preferences.displaySeconds, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.dismissCurrent() }
        }
    }

    private func position(_ window: NSWindow) {
        let screen = NSScreen.screens.first(where: { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) })
            ?? NSScreen.main
        guard let frame = screen?.visibleFrame else { return }
        window.setFrameOrigin(preferences.origin(for: window.frame.size,
                                                screens: NSScreen.screens.map(\.visibleFrame), fallback: frame))
    }

    func windowDidMove(_ notification: Notification) {
        guard let window = notification.object as? NSWindow, window === panel else { return }
        preferences.saveTopLeft(CGPoint(x: window.frame.minX, y: window.frame.maxY))
    }

    private func updateDurationMenu() {
        durationMenu.removeAllItems()
        let seconds = Int(preferences.displaySeconds)
        var choices = [5, 8, 15, 30, 60]
        if seconds > 0 && !choices.contains(seconds) { choices.append(seconds); choices.sort() }
        for value in choices + [0] {
            let item = NSMenuItem(title: value == 0 ? "До закрытия" : "\(value) сек.",
                                  action: #selector(setDuration(_:)), keyEquivalent: "")
            item.tag = value; item.target = self
            item.state = value == seconds ? .on : .off
            durationMenu.addItem(item)
        }
        durationMenu.addItem(.separator())
        let custom = NSMenuItem(title: "Другое…", action: #selector(customDuration), keyEquivalent: "")
        custom.target = self; durationMenu.addItem(custom)
    }

    @objc private func setDuration(_ item: NSMenuItem) {
        guard preferences.setDisplaySeconds(Double(item.tag)) else { return }
        updateDurationMenu(); scheduleExpiration()
    }

    @objc private func customDuration() {
        expiration?.invalidate(); expiration = nil
        defer { scheduleExpiration() }
        let alert = NSAlert()
        alert.messageText = "Сколько секунд показывать уведомление?"
        alert.informativeText = "Введите целое число от 1 до 3600."
        alert.addButton(withTitle: "Сохранить"); alert.addButton(withTitle: "Отмена")
        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 240, height: 24))
        input.stringValue = String(Int(preferences.displaySeconds == 0 ? 8 : preferences.displaySeconds))
        alert.accessoryView = input
        NSApp.activate(ignoringOtherApps: true)
        alert.window.initialFirstResponder = input
        while alert.runModal() == .alertFirstButtonReturn {
            if let seconds = Int(input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)),
               seconds > 0, preferences.setDisplaySeconds(Double(seconds)) {
                updateDurationMenu(); return
            }
            alert.informativeText = "Нужно целое число от 1 до 3600. Для показа без таймера выберите «До закрытия» в меню."
        }
    }

    @objc private func resetPosition() {
        preferences.resetPosition()
        if let panel {
            panel.delegate = nil
            position(panel)
            panel.delegate = self
        }
    }

    private func hideCurrent() {
        expiration?.invalidate(); expiration = nil
        panel?.orderOut(nil); panel = nil; current = nil
        dragging = false
    }

    private func dismissCurrent() { hideCurrent(); showNext() }

    private func openSession(_ event: AgentNotification) {
        if event.sessionID == "ses_preview" { openBoard() }
        else {
            var link = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
            link.path = "/"
            link.queryItems = [URLQueryItem(name: "session", value: event.sessionID)]
            if let url = link.url { NSWorkspace.shared.open(url) }
        }
        dismissCurrent()
    }

    @objc private func openBoard() { NSWorkspace.shared.open(baseURL) }
    @objc private func quit() { NSApp.terminate(nil) }
    @objc private func togglePause() {
        paused.toggle()
        pauseItem.title = paused ? "Возобновить уведомления" : "Приостановить уведомления"
        if paused { queue = NotificationQueue(); hideCurrent() }
        connectionItem.title = paused ? "Уведомления приостановлены" : "Подключение…"
    }
    @objc private func preview() {
        show(AgentNotification(sessionID: "ses_preview", title: "Пример: исправление отчёта",
                               kind: .question, revision: 1))
    }
}
