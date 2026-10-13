import AppKit

let portValue = ProcessInfo.processInfo.environment["KLIPRUN_BUN_PORT"] ?? "8792"
guard let port = Int(portValue), (1...65535).contains(port) else {
    fputs("KLIPRUN_BUN_PORT must be a port between 1 and 65535\n", stderr)
    exit(1)
}
MainActor.assumeIsolated {
    let application = NSApplication.shared
    let controller = AppController(port: port)
    application.delegate = controller
    withExtendedLifetime(controller) { application.run() }
}
