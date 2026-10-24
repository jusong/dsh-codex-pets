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

/**
 * The bookkeeping of a drag.
 *
 * The pet follows the cursor **directly**: every frame the helper reads the
 * real cursor position and puts the window where it belongs. Two things
 * used to stand between the cursor and the window:
 *
 *   * a WebView stops delivering pointer events as soon as the cursor
 *     leaves it, and the cursor leaves it the moment the window lags
 *     behind -- so a lagging pet stopped receiving the very events that
 *     would have caught it up. The lag fed itself.
 *   * the press itself used to reach the helper through the page: the
 *     WebView had to turn it into a pointer event, the page had to turn
 *     that into a message, and only then did the helper learn where the
 *     press happened. By then the cursor had already travelled, and the
 *     pet started the drag from the wrong place -- so it trailed the
 *     cursor by however far the cursor moved in the meantime, for the
 *     whole drag.
 *
 * The helper now watches the mouse itself, so the drag starts at the
 * position of the press and the pet keeps following whether or not the
 * page hears anything.
 */
struct DragState {
    private(set) var isDragging = false
    /// Whether the pet was really moved, as opposed to clicked.
    private(set) var moved = false
    private var startMouse = NSPoint.zero
    private var startOrigin = NSPoint.zero

    mutating func begin(at mouse: NSPoint, origin: NSPoint) {
        isDragging = true
        moved = false
        startMouse = mouse
        startOrigin = origin
    }

    /// Where the window belongs, given where the cursor is now.
    func windowOrigin(for mouse: NSPoint) -> NSPoint {
        NSPoint(x: startOrigin.x + (mouse.x - startMouse.x),
                y: startOrigin.y + (mouse.y - startMouse.y))
    }

    /// Where on the pet the cursor grabbed it, relative to the window.
    var grabOffset: NSPoint {
        NSPoint(x: startMouse.x - startOrigin.x, y: startMouse.y - startOrigin.y)
    }

    /// Note that the pet has really moved, if it has.
    mutating func noteMoved(mouse: NSPoint) {
        if abs(mouse.x - startMouse.x) > 3 || abs(mouse.y - startMouse.y) > 3 {
            moved = true
        }
    }

    mutating func end() {
        isDragging = false
    }
}

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
    private var drag = DragState()
    /// Where the cursor is, as far as the drag is concerned.
    ///
    /// The real cursor is read from the system, but the benchmark needs a
    /// cursor it controls, so it can hand the drag a path that moves faster
    /// than any display.
    private var cursorOverride: NSPoint?
    private var cursor: NSPoint { cursorOverride ?? NSEvent.mouseLocation }
    /// Whether the mouse button counts as held down.
    ///
    /// The benchmark drives the drag with a cursor it controls, and a
    /// cursor it controls has no button under it.
    private var buttonOverride: Bool?
    private var buttonDown: Bool {
        buttonOverride ?? (NSEvent.pressedMouseButtons & 1 != 0)
    }
    private var followTimer: Timer?
    /// The mouse monitor that sees the press before the page does.
    ///
    /// A mouse-down on the pet reaches the WebView and the page before it
    /// reaches the helper over the message bridge. Watching the event
    /// here means the drag starts at the exact spot of the press.
    private var mouseMonitor: Any?
    /// The timer that keeps the gaze in step with the cursor.
    private var gazeTimer: Timer?
    /// Which way the pet is looking, as one of the sixteen buckets.
    ///
    /// `-1` means "not looking", which is also how the helper asks the
    /// page to drop the gaze.
    private var gazeIndex = -1
    /// The biggest gap between the cursor and the window during a drag.
    ///
    /// This is the distance a person would see the pet trailing behind,
    /// so it is worth writing down.
    private var maxTrail: Double = 0
    /// When the pet first moved after the press.
    private var firstMoveTime: Double = 0
    /// When the press happened.
    private var pressTime: Double = 0
    /// Where to write a line about every drag.
    private var dragLogPath = ""
    /// Where the cursor was before the press benchmark moved it.
    private var pressBenchmarkOrigin = NSPoint.zero
    /// How many times the window has actually been moved during this drag.
    private var windowMoves = 0
    /// How many times the window was asked to move, moved or not.
    private var moveAttempts = 0
    /// How long the window server took to answer the probe, in total.
    private var probeCost: Double = 0
    private var probeCount = 0
    private var dragRequests = 0
    /// Whether to measure where the window server painted the window.
    private var measureLag = false
    /// How far behind the cursor the window has ever been painted.
    private var maxDragLag: Double = 0
    /// How many frames the drag has run for.
    private var frameCounter = 0
    /// When the window was moved, to measure how regular the moves are.
    private var moveStamps: [Double] = []
    /// When the follow timer fired, to measure how regular that is.
    private var tickStamps: [Double] = []
    /// The longest the main thread was blocked, and how many beats it took.
    private var heartbeatGaps: () -> Double = { 0 }
    private var heartbeatCount: () -> Int = { 0 }
    /// How long the window moves have taken in total.
    private var moveCost: Double = 0
    private var dragBench = false
    /// Which parts of the drag the benchmark switches off.
    ///
    /// The benchmark has to be able to take the measurement out of the
    /// picture, otherwise it ends up measuring its own probe: reading the
    /// window list is a synchronous conversation with the window server, and
    /// it happens right after a window move, which is exactly when the
    /// window server has the least time to spare.
    private var benchProfile: Set<String> = []
    private var performNow = false
    private var performanceTimer: Timer?
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
        if dragBench {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                guard let self else { return }
                if self.benchProfile.contains("press")
                    || self.benchProfile.contains("oldpress") {
                    self.runPressBenchmark()
                } else {
                    self.runDragBenchmark()
                }
            }
        }
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
            case "--drag-bench": dragBench = true
            case "--drag-log": dragLogPath = iterator.next() ?? ""
            case "--bench-profile": benchProfile = Set((iterator.next() ?? "").split(separator: ",").map(String.init))
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
        watchGaze()
        watchPresses()
    }

    /// Watch for the press, so the drag can start where it happened.
    ///
    /// The event monitor runs before the window hands the event to the
    /// WebView, so the helper knows where the press happened while the
    /// page is still working out what to do with it. The event is passed
    /// on unchanged: the page still needs it to play the pet's reaction.
    private func watchPresses() {
        mouseMonitor = NSEvent.addLocalMonitorForEvents(
            matching: [.leftMouseDown, .leftMouseUp, .leftMouseDragged]
        ) { [weak self] event in
            self?.handleMouseEvent(event) ?? event
        }
    }

    /// Whether the press that began the current interaction was kept from
    /// the WebView -- and so its release and its drag events must be kept
    /// from it too.
    private var swallowingMouse = false

    /// React to the mouse before the page gets the chance to.
    ///
    /// The drag events are swallowed on purpose: every one of them used to
    /// reach the WebView, and the press especially made WebKit hold the
    /// main thread for ~50ms -- the time to ask the sleeping web process
    /// what the page meant to do with the click. The pet froze under the
    /// cursor at exactly the moment the hand started moving, which is the
    /// lag the drag log kept recording. The page now hears nothing: the
    /// window is moved natively and the click's reaction is asked for
    /// through an asynchronous request, so nothing in WebKit can stand
    /// between the cursor and the window.
    private func handleMouseEvent(_ event: NSEvent) -> NSEvent? {
        switch event.type {
        case .leftMouseDown:
            let point = panel.convertPoint(toScreen: event.locationInWindow)
            // Only a press on the pet itself starts a drag.
            guard panel.frame.contains(point) else { return event }
            pressTime = CFAbsoluteTimeGetCurrent()
            maxTrail = 0
            firstMoveTime = 0
            windowMoves = 0
            moveAttempts = 0
            moveStamps = []
            tickStamps = []
            // The benchmark can put the drag back on the old path, where
            // the page reported the press, to see what that costs.
            guard !benchProfile.contains("oldpress") else { return event }
            drag.begin(at: point, origin: panel.frame.origin)
            startFollowTimer()
            // Nothing below may talk to the web view: the press is exactly
            // when the web process is most likely asleep, and the first
            // request that wakes it can hold the main thread for ~60ms --
            // the press stall the drag log kept recording. The gaze is
            // forgotten silently (a fresh one is sent once the drag is
            // over), and the click's reaction waits until the release,
            // when a no-move press turns out to have been a click after
            // all -- so a drag never wakes the page up mid-flight either.
            pressedWithGaze = gazeIndex != -1
            gazeIndex = -1
            // A click still interrupts the next performance, the way the
            // page's message used to.
            performanceTimer?.invalidate()
            schedulePerformance(after: 20)
            swallowingMouse = true
            return nil
        case .leftMouseUp:
            let swallow = swallowingMouse
            swallowingMouse = false
            finishDrag()
            return swallow ? nil : event
        case .leftMouseDragged:
            // Catch up inside the event itself, the way native window
            // dragging does: the follow timer polls at the refresh rate,
            // and a busy main run loop can hold a tick back until the pet
            // visibly trails the cursor.
            followCursor()
            return swallowingMouse ? nil : event
        default:
            return event
        }
    }

    /// Whether the pet was mid-gaze when the press happened -- the gaze was
    /// then dropped silently (no request could be spared at the press), so
    /// the page may still be showing that stale frame once the drag ends.
    private var pressedWithGaze = false

    /// Ask the page for the click reaction without handing it the event.
    private func reactInPage() {
        webView.evaluateJavaScript("window.DSHPet && window.DSHPet.react()") { _, _ in }
    }

    /// Keep the pet's gaze on the cursor.
    ///
    /// The gaze used to be driven by the page's pointer events, and that
    /// only works when the helper happens to be the frontmost app: macOS
    /// sends mouse-moved events to the active application, and a pet
    /// floating over somebody's desktop is not it. The helper knows where
    /// the cursor is at all times, so it tells the page instead -- and the
    /// pet looks at the cursor without the delay of a round trip through
    /// the web view.
    private func watchGaze() {
        let rate = panel.screen?.maximumFramesPerSecond ?? 60
        let timer = Timer(timeInterval: 1.0 / Double(max(1, rate)), repeats: true) { [weak self] _ in
            self?.updateGaze()
        }
        // Common mode, so the gaze keeps up while AppKit is tracking the
        // mouse.
        RunLoop.main.add(timer, forMode: .common)
        gazeTimer = timer
    }

    /// Point the pet at the cursor, if the cursor is close enough.
    private func updateGaze() {
        guard let panel else { return }
        let mouse = cursor
        let inside = panel.frame.contains(mouse)
        if inside != pointerInsidePanel {
            pointerInsidePanel = inside
        }
        // A drag already has the pet's attention.
        if drag.isDragging { return }
        // The web view counts from the top left, the screen from the
        // bottom left.
        let clientX = mouse.x - panel.frame.origin.x
        let clientY = panel.frame.height - (mouse.y - panel.frame.origin.y)
        let dx = clientX - size / 2
        // The pet's eyes sit a little above the middle of the cell.
        let dy = clientY - size * 0.42
        if hypot(dx, dy) > size * 1.4 {
            dropGaze()
            return
        }
        // 0 degrees points straight up; the angle grows clockwise.
        let degrees = atan2(dx, -dy) * 180 / .pi
        let index = ((Int((degrees / 22.5).rounded()) % 16) + 16) % 16
        guard index != gazeIndex else { return }
        gazeIndex = index
        webView.evaluateJavaScript(
            "window.DSHPet && window.DSHPet.look(\(clientX), \(clientY))"
        ) { _, _ in }
    }

    /// Stop looking at the cursor.
    private func dropGaze() {
        guard gazeIndex != -1 else { return }
        gazeIndex = -1
        lookOutInPage()
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
        // Forget the direction as well, so the gaze comes back when the
        // cursor comes back.
        dropGaze()
    }

    private func loadPet() {
        // The benchmark can leave the page empty, to find out how much of a
        // drag is the web view's doing and how much is the window's.
        if benchProfile.contains("noweb") { return }
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
            // The press reached the event monitor before it reached the
            // page, so the drag is already running and it started at the
            // place the press happened. Starting it again from here would
            // move the pet by however far the cursor travelled while the
            // press was on its way through the web view.
            if !drag.isDragging {
                startMouse = cursor
                startOrigin = panel.frame.origin
                drag.begin(at: startMouse, origin: startOrigin)
                windowMoves = 0
                dragRequests = 0
                startFollowTimer()
            }
        case "move":
            // The page used to send a move for every pointer event, and the
            // window used to be moved for every one of them. The pet now
            // follows the cursor by itself, so there is nothing to do.
            break
        case "ready":
            // The pet has arrived; the gaze has to be sent again.
            gazeIndex = -1
        case "up":
            finishDrag()
        default:
            break
        }
    }

    /// Follow the cursor, once per frame, for as long as the button is down.
    ///
    /// The button state is read from the system rather than taken from the
    /// page, because the page cannot tell us when the drag ends once the
    /// cursor has left the pet.
    private func followCursor() {
        guard drag.isDragging else { return }
        tickStamps.append(CFAbsoluteTimeGetCurrent())
        if !buttonDown {
            finishDrag()
            return
        }
        let current = cursor
        drag.noteMoved(mouse: current)
        let target = drag.windowOrigin(for: current)
        if target == panel.frame.origin { return }
        moveAttempts += 1
        // How far the pet is behind the cursor right now. This is the
        // distance a person sees the pet trailing, so it is worth
        // keeping the worst one of the drag.
        let trail = hypot(target.x - panel.frame.origin.x,
                          target.y - panel.frame.origin.y)
        maxTrail = max(maxTrail, trail)
        if firstMoveTime == 0 {
            firstMoveTime = CFAbsoluteTimeGetCurrent()
        }
        let started = CFAbsoluteTimeGetCurrent()
        if !benchProfile.contains("nomove") {
            panel.setFrameOrigin(target)
        }
        moveCost += CFAbsoluteTimeGetCurrent() - started
        windowMoves += 1
        moveStamps.append(CFAbsoluteTimeGetCurrent())
        if measureLag, !benchProfile.contains("noprobe") {
            // Reading the window list is expensive, so it is sampled rather
            // than done every frame.
            frameCounter += 1
            if frameCounter % 4 == 0 {
                let probeStarted = CFAbsoluteTimeGetCurrent()
                let painted = paintedOrigin()
                probeCost += CFAbsoluteTimeGetCurrent() - probeStarted
                probeCount += 1
                if let painted {
                    maxDragLag = max(maxDragLag, hypot(painted.x - target.x,
                                                        painted.y - target.y))
                }
            }
        }
    }

    /// The drag is over: either the button was released or the page said so.
    private func finishDrag() {
        guard drag.isDragging else { return }
        drag.end()
        stopFollowTimer()
        if drag.moved {
            saveOrigin()
        } else {
            activateDSH()
            // Only a no-move press was a click, and the click's reaction
            // belongs here: asking at the press itself woke the web
            // process at the worst possible moment, and asking at every
            // press made the jump's compositing contend with the very
            // drags that had just started.
            reactInPage()
        }
        writeDragLog()
        // If the press silenced a live gaze without telling the page, that
        // stale frame is still on the pet; one request now -- after the
        // drag, when a moment of latency costs nothing -- clears it.
        if pressedWithGaze {
            pressedWithGaze = false
            lookOutInPage()
        }
        // The pet looks at the cursor again once the drag is over.
        gazeIndex = -1
    }

    /// Write down what the drag actually did.
    ///
    /// The pet is supposed to be under the cursor the whole time, and the
    /// only honest way to know whether it was is to let somebody drag it
    /// and read the numbers afterwards: how long the pet took to start
    /// following, and how far behind the cursor it ever was.
    private func writeDragLog() {
        guard !dragLogPath.isEmpty else { return }
        let first = firstMoveTime == 0 ? 0 : (firstMoveTime - pressTime) * 1000
        // How far apart two window moves ever were: a stall in the middle
        // of the drag shows up here even when the trail alone does not say
        // whether the pet froze at the press or halfway through.
        var worstGap = 0.0
        for index in 1..<max(1, moveStamps.count) {
            worstGap = max(worstGap, (moveStamps[index] - moveStamps[index - 1]) * 1000)
        }
        let last = firstMoveTime == 0 ? 0 : (CFAbsoluteTimeGetCurrent() - firstMoveTime) * 1000
        let object: [String: Any] = [
            "at": Date().timeIntervalSince1970,
            "moves": windowMoves,
            "pressToFirstMoveMs": (first * 10).rounded() / 10,
            "maxTrailPx": (maxTrail * 10).rounded() / 10,
            "dragMs": (last * 10).rounded() / 10,
            "worstMoveGapMs": (worstGap * 10).rounded() / 10,
            "moved": drag.moved,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        var line = data
        line.append(0x0A)
        let url = URL(fileURLWithPath: dragLogPath)
        // `FileHandle(forWritingTo:)` refuses to create the file, and the
        // very first drag -- the one a fresh install is most likely to be
        // asked about -- found nothing to write to. Create it once here so
        // the log can bootstrap itself.
        if !FileManager.default.fileExists(atPath: dragLogPath) {
            FileManager.default.createFile(atPath: dragLogPath, contents: nil)
        }
        // Keep the log small: it is a note of the last few drags, not a
        // history of every drag ever.
        if let attributes = try? FileManager.default.attributesOfItem(atPath: dragLogPath),
           let size = attributes[.size] as? Int, size > 32_768 {
            try? FileManager.default.removeItem(at: url)
        }
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(line)
            try? handle.close()
        }
    }

    /// Follow the cursor at the refresh rate of the display.
    ///
    /// The rate is the refresh rate of the display the pet is on, so a
    /// ProMotion screen is not held back to 60.
    private func startFollowTimer() {
        guard followTimer == nil else { return }
        let rate = panel.screen?.maximumFramesPerSecond ?? 60
        let timer = Timer(timeInterval: 1.0 / Double(max(1, rate)), repeats: true) {
            [weak self] _ in
            self?.followCursor()
        }
        // Common mode, so the timer keeps firing while AppKit is tracking
        // the mouse.
        RunLoop.main.add(timer, forMode: .common)
        followTimer = timer
    }

    private func stopFollowTimer() {
        followTimer?.invalidate()
        followTimer = nil
    }

    /// How well the window kept up with a fast drag.
    ///
    /// A real drag cannot be timed from here: the cursor belongs to the
    /// person using the machine, and a synthetic cursor is not trusted
    /// enough to measure anything the user would feel. So this drives the
    /// very same code path with a cursor it controls, moving faster than
    /// any display, and reports what the window did with it.
    ///
    /// The interesting number is not how often the window was asked to
    /// move, but where the window server actually **painted** it: that
    /// gap between where the window was asked to be and where it ended up
    /// on the screen is exactly what a person feels as "the pet does not
    /// follow the cursor".
    private func runDragBenchmark() {
        let start = NSPoint(x: 400, y: 400)
        // The "events" profile posts drag events at the synthetic cursor,
        // so the panel has to sit under it -- otherwise every event falls
        // outside the window and the WebView never does the work a real
        // drag makes it do.
        if benchProfile.contains("events") {
            panel.setFrameOrigin(NSPoint(x: start.x - size / 2, y: start.y - size / 2))
        }
        let origin = panel.frame.origin
        cursorOverride = start
        buttonOverride = true
        drag.begin(at: start, origin: origin)
        windowMoves = 0
        moveAttempts = 0
        probeCost = 0
        probeCount = 0
        dragRequests = 0
        moveCost = 0
        maxDragLag = 0
        moveStamps = []
        tickStamps = []
        measureLag = true
        pressTime = CFAbsoluteTimeGetCurrent()
        maxTrail = 0
        firstMoveTime = 0
        startFollowTimer()

        // 240 requests a second for two seconds: a fast trackpad, and
        // twice the refresh rate of the display.
        let total = 480
        let interval = 1.0 / 240.0
        // The cursor path runs on its own timer rather than a chain of
        // delayed blocks: a chain of blocks monopolises the main queue and
        // would starve the follow timer, which is exactly the jitter this
        // is trying to measure. The cursor is placed by the clock rather
        // than by the number of steps, so a late tick still leaves the
        // cursor in the right place.
        let began = CFAbsoluteTimeGetCurrent()
        let speed = 480.0
        var path: Timer?
        path = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            guard let self else { return }
            let elapsed = CFAbsoluteTimeGetCurrent() - began
            self.cursorOverride = NSPoint(x: start.x + elapsed * speed, y: start.y)
            self.dragRequests += 1
            guard elapsed >= Double(total) * interval else { return }
            path?.invalidate()
            self.finishDrag()
            self.reportDragBenchmark()
        }
        if let path { RunLoop.main.add(path, forMode: .common) }
        // The "events" profile turns the drag into a real one: it posts a
        // stream of mouse-dragged events into the app, at the rate a real
        // trackpad delivers them, so the WebView does the per-event work a
        // real drag makes it do -- on the same main thread as the follow
        // timer.
        if benchProfile.contains("events") {
            var events: Timer?
            events = Timer(timeInterval: 1.0 / 120.0, repeats: true) { [weak self] _ in
                guard let self, self.drag.isDragging else { return }
                self.postTestDragged(at: self.cursorOverride ?? .zero)
                if !self.drag.isDragging { events?.invalidate() }
            }
            if let events { RunLoop.main.add(events, forMode: .common) }
        }
        // A heartbeat on the main run loop: if the thread is blocked, this
        // timer cannot fire either, and the gap between two beats is the
        // length of the block.
        var beats = 0
        var last = CFAbsoluteTimeGetCurrent()
        var worst = 0.0
        let heartbeat = Timer(timeInterval: 0.001, repeats: true) { _ in
            let now = CFAbsoluteTimeGetCurrent()
            worst = max(worst, (now - last) * 1000)
            last = now
            beats += 1
        }
        RunLoop.main.add(heartbeat, forMode: .common)
        heartbeatGaps = { worst }
        heartbeatCount = { beats }
    }

    /// Post a press at the cursor, so the drag can be exercised without a
    /// real mouse.
    ///
    /// Synthetic mouse *events* are dropped by the system on this machine,
    /// but an event posted straight into the app still reaches the event
    /// monitor -- which is the part this needs to test.
    private func postTestPress(at point: NSPoint) {
        let local = panel.convertPoint(fromScreen: point)
        guard let event = NSEvent.mouseEvent(
            with: .leftMouseDown,
            location: local,
            modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: Int(panel.windowNumber),
            context: nil,
            eventNumber: 0,
            clickCount: 1,
            pressure: 1
        ) else { return }
        NSApp.postEvent(event, atStart: false)
    }

    /// Post a drag event at the cursor.
    ///
    /// A real drag does not just move the cursor: it streams mouse-dragged
    /// events into the app, and the WebView does real work for every one of
    /// them -- hit-testing, pointer capture, drag bookkeeping. The benchmark
    /// needs that stream to measure what a real drag does to the follow
    /// timer, because the stream runs on the very same main thread.
    private func postTestDragged(at point: NSPoint) {
        let local = panel.convertPoint(fromScreen: point)
        guard let event = NSEvent.mouseEvent(
            with: .leftMouseDragged,
            location: local,
            modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: Int(panel.windowNumber),
            context: nil,
            eventNumber: 0,
            clickCount: 1,
            pressure: 1
        ) else { return }
        NSApp.postEvent(event, atStart: false)
    }

    /// Post a release at the cursor.
    private func postTestRelease(at point: NSPoint) {
        let local = panel.convertPoint(fromScreen: point)
        guard let event = NSEvent.mouseEvent(
            with: .leftMouseUp,
            location: local,
            modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: Int(panel.windowNumber),
            context: nil,
            eventNumber: 0,
            clickCount: 1,
            pressure: 0
        ) else { return }
        NSApp.postEvent(event, atStart: false)
    }

    /// Drive a whole drag the way a person would, and report what the pet
    /// did.
    ///
    /// The press is posted into the app, the cursor is really warped along
    /// a straight line, and the helper follows it. The interesting number
    /// is the trail: how far behind the cursor the pet ever was.
    private func runPressBenchmark() {
        let origin = panel.frame.origin
        // Press on the pet itself, the way a person would.
        let start = NSPoint(x: origin.x + size / 2, y: origin.y + size / 2)
        pressBenchmarkOrigin = NSEvent.mouseLocation
        warpCursor(to: start)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            guard let self else { return }
            // A posted event does not press the real button, so the
            // helper is told about the button as well.
            self.buttonOverride = true
            self.maxTrail = 0
            self.firstMoveTime = 0
            self.windowMoves = 0
            self.moveAttempts = 0
            // The press and the movement start together: the pet is
            // expected to be under the cursor from the first frame of the
            // drag.
            self.postTestPress(at: start)
            self.warpPath(from: start, duration: 1.0, speed: 700)
        }
    }

    /// Move the real cursor to a point.
    private func warpCursor(to point: NSPoint) {
        let union = NSScreen.screens.map(\.frame).reduce(NSRect.null) { $0.union($1) }
        let height = union.maxY - union.minY
        CGWarpMouseCursorPosition(CGPoint(x: point.x, y: height - (point.y - union.minY)))
    }

    /// Drag the real cursor along a straight line.
    private func warpPath(from start: NSPoint, duration: Double, speed: Double) {
        let began = CFAbsoluteTimeGetCurrent()
        var timer: Timer?
        timer = Timer(timeInterval: 1.0 / 240.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            let elapsed = CFAbsoluteTimeGetCurrent() - began
            self.warpCursor(to: NSPoint(x: start.x + elapsed * speed, y: start.y))
            guard elapsed >= duration else { return }
            timer?.invalidate()
            let end = NSPoint(x: start.x + duration * speed, y: start.y)
            self.postTestRelease(at: end)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                self.reportPressBenchmark()
            }
        }
        if let timer { RunLoop.main.add(timer, forMode: .common) }
    }

    /// Print what the drag benchmark measured.
    private func reportPressBenchmark() {
        let mouse = cursor
        let grab = drag.grabOffset
        let trail = hypot(mouse.x - panel.frame.origin.x - grab.x,
                          mouse.y - panel.frame.origin.y - grab.y)
        let first = firstMoveTime == 0 ? 0 : (firstMoveTime - pressTime) * 1000
        print("press bench: moves=\(windowMoves) attempts=\(moveAttempts) "
              + "pressToFirstMoveMs=\(String(format: "%.1f", first)) "
              + "maxTrailPx=\(String(format: "%.1f", maxTrail)) "
              + "finalTrailPx=\(String(format: "%.1f", trail)) "
              + "moved=\(drag.moved)")
        warpCursor(to: pressBenchmarkOrigin)
        buttonOverride = nil
        NSApp.terminate(nil)
    }

    /// Print what the drag benchmark measured.
    private func reportDragBenchmark() {
        let target = drag.windowOrigin(for: cursor)
        let painted = benchProfile.contains("noprobe") ? nil : paintedOrigin()
        let lag = painted.map { hypot($0.x - target.x, $0.y - target.y) }
            ?? hypot(target.x - panel.frame.origin.x, target.y - panel.frame.origin.y)
        var gaps: [Double] = []
        for index in 1..<max(1, moveStamps.count) {
            gaps.append((moveStamps[index] - moveStamps[index - 1]) * 1000)
        }
        let over20 = gaps.filter { $0 > 20 }.count
        let over50 = gaps.filter { $0 > 50 }.count
        let head = gaps.prefix(6).map { String(format: "%.1f", $0) }.joined(separator: ",")
        var tickGaps: [Double] = []
        for index in 1..<max(1, tickStamps.count) {
            tickGaps.append((tickStamps[index] - tickStamps[index - 1]) * 1000)
        }
        tickGaps.sort()
        let tickMedian = tickGaps.isEmpty ? 0 : tickGaps[tickGaps.count / 2]
        let tickWorst = tickGaps.last ?? 0
        let tickOver20 = tickGaps.filter { $0 > 20 }.count
        gaps.sort()
        let median = gaps.isEmpty ? 0 : gaps[gaps.count / 2]
        let worst = gaps.last ?? 0
        let spread = gaps.isEmpty ? 0 : (gaps.last! - gaps.first!)
        print("drag bench: requests=\(dragRequests) "
              + "windowMoves=\(windowMoves) moveAttempts=\(moveAttempts) "
              + "moveCostMs=\(Int(moveCost * 1000)) "
              + "probeCostMs=\(Int(probeCost * 1000)) probes=\(probeCount) "
              + "maxPaintedLagPx=\(Int(maxDragLag)) "
              + "finalPaintedLagPx=\(Int(lag)) "
              + "moveGapMedianMs=\(String(format: "%.2f", median)) "
              + "moveGapWorstMs=\(String(format: "%.2f", worst)) "
              + "moveGapSpreadMs=\(String(format: "%.2f", spread)) "
              + "gapsOver20ms=\(over20) gapsOver50ms=\(over50) "
              + "firstGaps=\(head) "
              + "mainThreadWorstBlockMs=\(String(format: "%.1f", heartbeatGaps())) "
              + "heartbeats=\(heartbeatCount()) "
              + "tickMedianMs=\(String(format: "%.2f", tickMedian)) "
              + "tickWorstMs=\(String(format: "%.2f", tickWorst)) "
              + "tickOver20ms=\(tickOver20)")
        drag.end()
        stopFollowTimer()
        cursorOverride = nil
        buttonOverride = nil
        NSApp.terminate(nil)
    }

    /// Where the window is actually painted, as the window server sees it.
    ///
    /// `panel.frame` is where the window was asked to be. The window server
    /// paints it a frame or so later, and that gap is what a person feels.
    private func paintedOrigin() -> NSPoint? {
        let number = panel.windowNumber
        guard number > 0,
              let list = CGWindowListCopyWindowInfo([.optionIncludingWindow],
                                                    CGWindowID(number)) as? [[String: Any]],
              let info = list.first,
              let bounds = info[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary),
              let screen = panel.screen else { return nil }
        // The window server reports the top-left corner of a top-left
        // space; AppKit wants the bottom-left one.
        return NSPoint(x: rect.origin.x,
                       y: screen.frame.maxY - rect.origin.y - rect.height)
    }
}

signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }

let application = NSApplication.shared
let controller = PetController()
application.delegate = controller
application.run()
