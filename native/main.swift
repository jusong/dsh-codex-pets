import AppKit
import WebKit
import Darwin

/**
 * dsh-pet: a tiny macOS helper that owns the always-on-top pet window.
 *
 * The DSH host plugin spawns this binary, passes the HTML path and its own PID,
 * and kills it on unload. The window is an NSPanel at floating level, joins all
 * Spaces, and activates the DSH Desktop app when the pet is clicked.
 */
final class PetController: NSObject, NSApplicationDelegate, WKScriptMessageHandler {
    private var panel: NSPanel!
    private var webView: WKWebView!
    private var htmlPath = ""
    private var statePath = ""
    private var lockPath = ""
    private var size: CGFloat = 150
    private var parentPid: pid_t = 0
    private var lockFD: Int32 = -1
    private var levelName = "floating"
    private var selfTest = false
    private var startMouse = NSPoint.zero
    private var startOrigin = NSPoint.zero
    private var moved = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        parseArguments()
        acquireLock()
        createPanel()
        loadPet()
        watchParent()

        if selfTest {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
                self?.webView.evaluateJavaScript("window.__petSelfTest && window.__petSelfTest()", completionHandler: nil)
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    private func parseArguments() {
        var iterator = CommandLine.arguments.dropFirst().makeIterator()
        while let argument = iterator.next() {
            switch argument {
            case "--html": htmlPath = iterator.next() ?? ""
            case "--state": statePath = iterator.next() ?? ""
            case "--lock": lockPath = iterator.next() ?? ""
            case "--size": size = CGFloat(Double(iterator.next() ?? "") ?? 150)
            case "--parent-pid": parentPid = pid_t(Int32(iterator.next() ?? "") ?? 0)
            case "--level": levelName = iterator.next() ?? "floating"
            case "--self-test": selfTest = true
            default: break
            }
        }
        size = min(240, max(96, size))
    }

    /// One pet per DSH host: a second helper exits instead of stacking windows.
    private func acquireLock() {
        guard !lockPath.isEmpty else { return }
        lockFD = open(lockPath, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        guard lockFD >= 0 else { return }
        // A plugin reload can overlap the previous helper's shutdown; retry
        // briefly instead of losing the pet for the whole session.
        for _ in 0..<30 {
            if flock(lockFD, LOCK_EX | LOCK_NB) == 0 { return }
            usleep(100_000)
        }
        close(lockFD)
        exit(0)
    }

    private func createPanel() {
        let origin = initialOrigin()
        let rect = NSRect(x: origin.x, y: origin.y, width: size, height: size)
        panel = NSPanel(
            contentRect: rect,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.level = levelName == "screenSaver" ? .screenSaver : .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.isMovableByWindowBackground = false
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.worksWhenModal = true
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true

        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "pet")
        webView = WKWebView(
            frame: NSRect(x: 0, y: 0, width: size, height: size),
            configuration: configuration
        )
        webView.autoresizingMask = [.width, .height]
        webView.setValue(false, forKey: "drawsBackground")
        webView.underPageBackgroundColor = .clear
        webView.allowsBackForwardNavigationGestures = false

        panel.contentView = webView
        panel.orderFrontRegardless()
    }

    private func loadPet() {
        guard !htmlPath.isEmpty,
              let html = try? String(contentsOfFile: htmlPath, encoding: .utf8) else {
            NSLog("dsh-pet: cannot read pet html at \(htmlPath)")
            NSApp.terminate(nil)
            return
        }
        let base = URL(fileURLWithPath: htmlPath).deletingLastPathComponent()
        webView.loadHTMLString(html, baseURL: base)
    }

    private func watchParent() {
        guard parentPid > 0 else { return }
        let pid = parentPid
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
            if kill(pid, 0) != 0 && errno == ESRCH {
                NSApp.terminate(nil)
            }
        }
    }

    private func initialOrigin() -> NSPoint {
        if !statePath.isEmpty,
           let data = try? Data(contentsOf: URL(fileURLWithPath: statePath)),
           let raw = try? JSONSerialization.jsonObject(with: data),
           let object = raw as? [String: Any],
           let x = (object["x"] as? NSNumber)?.doubleValue,
           let y = (object["y"] as? NSNumber)?.doubleValue {
            return clampToScreen(NSPoint(x: x, y: y))
        }
        let frame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        return NSPoint(x: frame.maxX - size - 24, y: frame.minY + 24)
    }

    private func clampToScreen(_ point: NSPoint) -> NSPoint {
        let rect = NSRect(origin: point, size: NSSize(width: size, height: size))
        if NSScreen.screens.contains(where: { $0.visibleFrame.intersects(rect) }) {
            return point
        }
        let frame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        return NSPoint(x: frame.maxX - size - 24, y: frame.minY + 24)
    }

    private func saveOrigin() {
        guard !statePath.isEmpty else { return }
        let origin = panel.frame.origin
        let object: [String: Double] = ["x": origin.x, "y": origin.y]
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        try? data.write(to: URL(fileURLWithPath: statePath), options: .atomic)
    }

    private func activateDSH() {
        if let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.deepseek.dsh").first {
            app.unhide()
            app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
            return
        }
        let url = URL(fileURLWithPath: "/Applications/DeepSeek Harness.app")
        NSWorkspace.shared.openApplication(
            at: url,
            configuration: NSWorkspace.OpenConfiguration(),
            completionHandler: nil
        )
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "pet",
              let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }

        switch type {
        case "down":
            startMouse = NSEvent.mouseLocation
            startOrigin = panel.frame.origin
            moved = false
        case "move":
            // The renderer sends a signal; AppKit supplies the authoritative
            // mouse location, so no JS coordinate conversion is needed.
            let current = NSEvent.mouseLocation
            let dx = current.x - startMouse.x
            let dy = current.y - startMouse.y
            if abs(dx) > 3 || abs(dy) > 3 { moved = true }
            panel.setFrameOrigin(NSPoint(x: startOrigin.x + dx, y: startOrigin.y + dy))
        case "up":
            if moved {
                saveOrigin()
            } else {
                activateDSH()
            }
        default:
            break
        }
    }
}

signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }

let application = NSApplication.shared
let controller = PetController()
application.delegate = controller
application.run()
