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
final class PetController: NSResponder, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    private var panel: NSPanel!
    private var webView: WKWebView!
    private var petDir = ""
    private var runtimePath = ""
    private var statePath = ""
    private var lockPath = ""
    private var size: CGFloat = 220
    private var parentPid: pid_t = 0
    private var lockFD: Int32 = -1
    private var levelName = "floating"
    private var selfTest = false
    private var diagnose = false
    private var diagnoseAfter: Double = 0
    private var startMouse = NSPoint.zero
    private var startOrigin = NSPoint.zero
    private var moved = false
    private var performNow = false
    private var performanceTimer: Timer?
    private var mouseTimer: Timer?
    private var trackingArea: NSTrackingArea?
    private var pointerInsidePanel = false
    private var lookOutCount = 0

    // A pet is pure data: a manifest plus an atlas. The manifest carries the
    // animation rows, so adding a pet never means changing any code.
    private var manifest: [String: Any] = [:]
    private var manifestScript = ""
    private var hasManifest = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        parseArguments()
        acquireLock()
        guard hasManifest else {
            NSLog("dsh-pet: no usable pet manifest, exiting")
            NSApp.terminate(nil)
            return
        }
        createPanel()
        loadPet()
        watchParent()
        if diagnose { runGazeDrill() }
    }

    /// Exercise the "the cursor left the pet" path.
    ///
    /// The gaze is set by a pointer move over the panel and cleared when the
    /// cursor goes away -- and a cursor that goes away is hard to fake on a
    /// machine where synthetic input is dropped. So the drill puts the panel
    /// under the real cursor, makes the page look at it, and then slides the
    /// panel out from under the cursor again: the window moving away is the
    /// same transition as the cursor moving away.
    private func runGazeDrill() {
        let mouse = NSEvent.mouseLocation
        panel.setFrameOrigin(NSPoint(x: mouse.x - size / 2, y: mouse.y - size / 2))
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            // Make the page gaze at the cursor, the way a pointer move would.
            self.webView.evaluateJavaScript(
                "window.__pet && window.__pet.updateLook(window.innerWidth / 2, 5)"
            ) { _, error in
                if let error {
                    FileHandle.standardError.write("gaze drill failed: \(error)\n".data(using: .utf8)!)
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.5) {
            self.panel.setFrameOrigin(NSPoint(x: self.panel.frame.origin.x + 600, y: self.panel.frame.origin.y))
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    private func parseArguments() {
        var iterator = CommandLine.arguments.dropFirst().makeIterator()
        while let argument = iterator.next() {
            switch argument {
            case "--pet-dir": petDir = iterator.next() ?? ""
            case "--runtime": runtimePath = iterator.next() ?? ""
            case "--state": statePath = iterator.next() ?? ""
            case "--lock": lockPath = iterator.next() ?? ""
            case "--size": size = CGFloat(Double(iterator.next() ?? "") ?? 220)
            case "--parent-pid": parentPid = pid_t(Int32(iterator.next() ?? "") ?? 0)
            case "--level": levelName = iterator.next() ?? "floating"
            case "--self-test": selfTest = true
            case "--perform-now": performNow = true
            case "--diagnose": diagnose = true; diagnoseAfter = Double(iterator.next() ?? "") ?? 0
            default: break
            }
        }
        size = min(260, max(120, size))
        loadManifest()
    }

    /// Read the pet's manifest: the atlas path plus the animation rows.
    /// Everything the player needs travels in this one file.
    private func loadManifest() {
        guard !petDir.isEmpty else { return }
        let url = URL(fileURLWithPath: petDir).appendingPathComponent("pet.json")
        guard let data = try? Data(contentsOf: url),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            NSLog("dsh-pet: no readable manifest at \(url.path)")
            return
        }
        guard let sheet = object["spritesheetPath"] as? String, !sheet.isEmpty else {
            NSLog("dsh-pet: \(url.path) has no spritesheetPath")
            return
        }
        manifest = object

        // The player page lives in the runtime directory, so a relative atlas
        // path would resolve against the wrong place. Resolve it once, here,
        // against the pet's own directory.
        let resolved = URL(fileURLWithPath: petDir).appendingPathComponent(sheet)
        manifest["spritesheetPath"] = resolved.absoluteString
        guard let encoded = try? JSONSerialization.data(withJSONObject: manifest),
              var json = String(data: encoded, encoding: .utf8) else { return }
        // The JSON lands inside a <script> tag, so escape anything that
        // could close it early.
        json = json.replacingOccurrences(of: "<", with: "\\u003c")
        manifestScript = "window.__DSH_PET_MANIFEST__ = \(json);"
        hasManifest = true
    }

    /// A probe that reports what the page is really doing.
    ///
    /// The pet's animation clock lives inside the WebView, so "the pet looks
    /// frozen" is impossible to debug from the outside: the window keeps
    /// rendering, but nothing in the native side can tell a stalled
    /// requestAnimationFrame loop from a pet that is simply standing still.
    /// This script instruments the engine's own step loop and records what it
    /// sees, so `--diagnose` can print the truth.
    private static let diagnosticScript = """
    window.__dshDiag = {
      t0: performance.now(),
      steps: 0,
      sizeMismatch: 0,
      notSane: 0,
      plays: [],
      samples: [],
      errors: []
    };
    window.addEventListener('error', function (event) {
      window.__dshDiag.errors.push(String(event.message) + ' @ ' + event.lineno);
    });
    window.addEventListener('dsh-pet-ready', function (event) {
      window.__dshDiag.pet = event.detail.pet;
      window.__pet = event.detail.pet;
    });
    (function () {
      var d = window.__dshDiag;
      var proto = window.DSHSpritePet && window.DSHSpritePet.SpritePet.prototype;
      d.hasEngine = !!proto;
      if (!proto) return;
      var origStep = proto.step;
      var origPlay = proto.play;
      // Is the engine that actually got injected the one on disk?
      d.engineHasIdleRoutine = String(origStep).indexOf('idleElapsed') >= 0
        || String(origPlay).indexOf('idleElapsed') >= 0;
      proto.step = function (now) {
        d.steps += 1;
        d.lastDelta = Math.round((now - this.lastTime) * 100) / 100;
        try {
          var rect = this.canvas.getBoundingClientRect();
          if (this.canvas.width !== Math.round(rect.width * (window.devicePixelRatio || 1))) d.sizeMismatch += 1;
          if (!(rect.width > 1 && rect.height > 1)) d.notSane += 1;
        } catch (error) {}
        return origStep.call(this, now);
      };
      proto.play = function (name, options) {
        d.plays.push({
          t: Math.round(performance.now() - d.t0),
          name: name,
          loop: !!(options && options.loop)
        });
        if (d.plays.length > 60) d.plays.shift();
        return origPlay.call(this, name, options);
      };
      setInterval(function () {
        var pet = d.pet;
        if (!pet) {
          d.samples.push({ t: Math.round(performance.now() - d.t0), pet: false });
          return;
        }        var rect = pet.canvas.getBoundingClientRect();
        d.samples.push({
          t: Math.round(performance.now() - d.t0),
          anim: pet.animation && pet.animation.name,
          frame: pet.animation && pet.animation.frame,
          animElapsed: pet.animation && Math.round(pet.animation.elapsed || 0),
          idleElapsed: Math.round(pet.idleElapsed || 0),
          look: pet.lookFrame ? pet.lookFrame.row + '/' + pet.lookFrame.column : null,
          routineMs: pet.idleRoutineMin,
          actions: pet.idleActions && pet.idleActions.join(','),
          reduced: pet.reducedMotion,
          canvas: pet.canvas.width + 'x' + pet.canvas.height,
          rect: Math.round(rect.width) + 'x' + Math.round(rect.height),
          dpr: window.devicePixelRatio
        });
        if (d.samples.length > 80) d.samples.shift();
      }, 500);
      // A click drill: press the pet and see whether it answers with a jump.
      // The click is dispatched inside the page, so it does not need the
      // system to let synthetic input through.
      setTimeout(function () {
        var pet = d.pet;
        var canvas = document.getElementById('pet');
        if (!pet || !canvas) { d.click = { error: 'no pet' }; return; }
        var rect = canvas.getBoundingClientRect();
        var options = {
          bubbles: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + 5,
          button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true
        };
        document.dispatchEvent(new PointerEvent('pointermove', options));
        d.click = { before: pet.animation && pet.animation.name, look: pet.lookFrame ? pet.lookFrame.row : null };
        document.dispatchEvent(new PointerEvent('pointerdown', options));
        d.click.after = pet.animation && pet.animation.name;
        d.click.reacting = pet.reacting;
        d.click.lookAfter = pet.lookFrame ? pet.lookFrame.row : null;
        setTimeout(function () {
          d.click.settled = pet.animation && pet.animation.name;
          d.click.reactingAfter = pet.reacting;
        }, 1200);
      }, 4500);
    })();
    """

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
        if !runtimePath.isEmpty, let runtime = try? String(contentsOfFile: runtimePath, encoding: .utf8) {
            configuration.userContentController.addUserScript(WKUserScript(
                source: runtime,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            ))
        }
        // The sprite engine that plays the atlas, plus the manifest itself.
        let engine = runtimeDirectory().appendingPathComponent("sprite-pet.js")
        if let source = try? String(contentsOfFile: engine.path, encoding: .utf8) {
            configuration.userContentController.addUserScript(WKUserScript(
                source: source,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            ))
        }
        if !manifestScript.isEmpty {
            configuration.userContentController.addUserScript(WKUserScript(
                source: manifestScript,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            ))
        }
        if diagnose {
            configuration.userContentController.addUserScript(WKUserScript(
                source: Self.diagnosticScript,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            ))
        }
        webView = WKWebView(
            frame: NSRect(x: 0, y: 0, width: size, height: size),
            configuration: configuration
        )
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.underPageBackgroundColor = .clear
        webView.allowsBackForwardNavigationGestures = false

        panel.contentView = webView
        panel.orderFrontRegardless()

        // The pet looks at the cursor while it is over the panel, and the
        // gaze rows are static frames -- so the pet stops animating until it
        // is told the cursor is gone. A WebView only gets pointer events
        // while the pointer is over it, so the page can never notice on its
        // own; the window has to say it.
        let tracker = NSTrackingArea(
            rect: webView.bounds,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        webView.addTrackingArea(tracker)
        trackingArea = tracker
        watchMouse()
    }

    /// Watch the mouse and tell the page when the cursor leaves the panel.
    ///
    /// The tracking area reports the exit immediately, but a floating panel
    /// that never becomes key does not always get tracking events, so the
    /// mouse position is also polled. `NSEvent.mouseLocation` and
    /// `panel.frame` are both in Cocoa screen coordinates.
    private func watchMouse() {
        mouseTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            guard let self, let panel = self.panel else { return }
            let inside = panel.frame.contains(NSEvent.mouseLocation)
            if inside != self.pointerInsidePanel {
                self.pointerInsidePanel = inside
                if !inside { self.lookOutInPage() }
            }
        }
    }

    /// Tell the page that the cursor is no longer over the pet.
    private func lookOutInPage() {
        lookOutCount += 1
        webView.evaluateJavaScript("window.DSHPet && window.DSHPet.lookOut()") { _, _ in }
    }

    /// The tracking area's owner is told when the cursor enters and leaves.
    override func mouseEntered(with event: NSEvent) {
        pointerInsidePanel = true
    }

    override func mouseExited(with event: NSEvent) {
        pointerInsidePanel = false
        lookOutInPage()
    }

    private func loadPet() {
        loadSpritePet(base: URL(fileURLWithPath: petDir))
    }
    /// Load the shared player page and hand it the pet's manifest.
    ///
    /// The page has to be loaded as a real file rather than from a string:
    /// a page created with `loadHTMLString` has an opaque origin, and WebKit
    /// refuses to pull file:// resources (the sprite atlas) into one -- every
    /// load fails and the pet stays blank. Loading the file directly gives
    /// the page a file:// origin, and `allowingReadAccessTo` opens the pet's
    /// own directory to it.
    private func loadSpritePet(base: URL) {
        let playerPage = runtimeDirectory().appendingPathComponent("player.html")
        guard FileManager.default.fileExists(atPath: playerPage.path) else {
            NSLog("dsh-pet: cannot read the sprite player at \(playerPage.path)")
            NSApp.terminate(nil)
            return
        }
        webView.loadFileURL(playerPage, allowingReadAccessTo: commonAncestor(
            playerPage.deletingLastPathComponent(), base))
    }

    /// The nearest directory that contains both paths. WebKit only grants
    /// read access to a directory URL that ends in "/".
    private func commonAncestor(_ left: URL, _ right: URL) -> URL {
        var a = left.pathComponents
        var b = right.pathComponents
        var shared: [String] = []
        while !a.isEmpty, !b.isEmpty, a.first == b.first {
            shared.append(a.removeFirst())
            b.removeFirst()
        }
        // The first component is already "/", so drop it before joining.
        let path = "/" + shared.dropFirst().joined(separator: "/")
        return URL(fileURLWithPath: path, isDirectory: true)
    }

    private func runtimeDirectory() -> URL {
        URL(fileURLWithPath: runtimePath).deletingLastPathComponent()
    }

    /// Start test hooks only after the HTML has actually loaded; otherwise
    /// `evaluateJavaScript` can run before the pet functions exist.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if selfTest {
            selfTest = false
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
                self?.webView.evaluateJavaScript(
                    "window.__petSelfTest && window.__petSelfTest()",
                    completionHandler: nil
                )
            }
        }
        if performNow {
            performNow = false
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
                self?.startPerformance()
            }
        } else {
            schedulePerformance()
        }
        if diagnose {
            DispatchQueue.main.asyncAfter(deadline: .now() + diagnoseAfter / 1000.0) { [weak self] in
                self?.reportDiagnostics()
            }
        }
    }

    /// Print what the page saw, then quit. Used by `--diagnose`.
    private func reportDiagnostics() {
        webView.evaluateJavaScript("JSON.stringify(window.__dshDiag || null)") { result, error in
            let text = (result as? String) ?? "nil"
            FileHandle.standardError.write("diag: \(text)\n".data(using: .utf8)!)
            let mouse = NSEvent.mouseLocation
            let summary = "diag native: pointerInside=\(self.pointerInsidePanel) "
                + "lookOuts=\(self.lookOutCount) "
                + "mouse=\(Int(mouse.x)),\(Int(mouse.y)) "
                + "panel=\(Int(self.panel.frame.origin.x)),\(Int(self.panel.frame.origin.y))"
            FileHandle.standardError.write((summary + "\n").data(using: .utf8)!)
            if let error {
                FileHandle.standardError.write("diag error: \(error)\n".data(using: .utf8)!)
            }
            NSApp.terminate(nil)
        }
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
        return NSPoint(x: frame.maxX - size - 24, y: frame.minY + 200)
    }

    private func clampToScreen(_ point: NSPoint) -> NSPoint {
        let rect = NSRect(origin: point, size: NSSize(width: size, height: size))
        if NSScreen.screens.contains(where: { $0.visibleFrame.intersects(rect) }) {
            return point
        }
        let frame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        return NSPoint(x: frame.maxX - size - 24, y: frame.minY + 200)
    }

    private func saveOrigin() {
        guard !statePath.isEmpty else { return }
        let origin = panel.frame.origin
        let object: [String: Double] = ["x": origin.x, "y": origin.y]
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        try? data.write(to: URL(fileURLWithPath: statePath), options: .atomic)
    }


    /// Ask the loaded pet to perform. The pet owns the visuals and returns
    /// its duration in milliseconds; the shell only schedules the next show.
    private func schedulePerformance(after delay: TimeInterval? = nil) {
        performanceTimer?.invalidate()
        let wait = delay ?? Double.random(in: 18...30)
        performanceTimer = Timer.scheduledTimer(withTimeInterval: wait, repeats: false) { [weak self] _ in
            self?.startPerformance()
        }
    }

    private func startPerformance() {
        guard panel != nil else {
            schedulePerformance(after: 8)
            return
        }
        // Don't start a show under the cursor.
        if panel.frame.contains(NSEvent.mouseLocation) {
            schedulePerformance(after: 6)
            return
        }
        webView.evaluateJavaScript("window.DSHPet && window.DSHPet.perform()") { [weak self] result, _ in
            let milliseconds = (result as? NSNumber)?.doubleValue ?? 3000
            let seconds = max(0.5, min(15.0, milliseconds / 1000.0))
            self?.schedulePerformance(after: seconds + Double.random(in: 18...30))
        }
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
            performanceTimer?.invalidate()
            schedulePerformance(after: 20)
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
            moved = false
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
