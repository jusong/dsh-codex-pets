import AppKit
import WebKit

/**
 * Render a sprite pet to a PNG, headlessly.
 *
 * This mirrors what native/main.swift does when the real helper starts:
 * the same manifest injection, the same user scripts, the same player page.
 * The only difference is that the WebView is rendered off the user's
 * desktop and snapshotted, so the result does not depend on what else is
 * on screen.
 *
 *   swiftc -O -swift-version 5 -framework AppKit -framework WebKit \
 *     tools/render-pet.swift -o /tmp/render-pet
 *
 *   /tmp/render-pet --pet-dir pets/hoots --runtime runtime \
 *     --out /tmp/pet.png --animation jumping --after 1200
 */
final class Renderer: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private var webView: WKWebView!
    private var window: NSWindow!
    private var outputPath = ""
    private var animation = ""
    private var afterMilliseconds = 800
    private var performNow = false
    private var script = ""
    private var evaluate = ""
    /// How many messages the page sent across the bridge, by type.
    private var messageCounts: [String: Int] = [:]
    /// Print the message counts when the render is done.
    private var showMessages = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        render()
    }

    private func render() {
        let arguments = CommandLine.arguments
        var petDir = ""
        var runtimeDir = ""
        var index = 1
        while index < arguments.count {
            switch arguments[index] {
            case "--pet-dir": petDir = arguments[index + 1]; index += 2
            case "--runtime": runtimeDir = arguments[index + 1]; index += 2
            case "--out": outputPath = arguments[index + 1]; index += 2
            case "--animation": animation = arguments[index + 1]; index += 2
            case "--after": afterMilliseconds = Int(arguments[index + 1]) ?? 800; index += 2
            case "--perform": performNow = true; index += 1
            case "--script": script = arguments[index + 1] ?? ""; index += 2
            case "--eval": evaluate = arguments[index + 1] ?? ""; index += 2
            case "--messages": showMessages = true; index += 1
            default: index += 1
            }
        }

        let manifestURL = URL(fileURLWithPath: petDir).appendingPathComponent("pet.json")
        guard let data = try? Data(contentsOf: manifestURL),
              var manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            FileHandle.standardError.write("cannot read \(manifestURL.path)\n".data(using: .utf8)!)
            exit(1)
        }

        // The player page lives in the runtime directory, so the atlas has to
        // be resolved to an absolute path -- exactly like the helper does.
        if let relative = manifest["spritesheetPath"] as? String {
            manifest["spritesheetPath"] = URL(fileURLWithPath: petDir)
                .appendingPathComponent(relative).absoluteString
        }
        guard let manifestData = try? JSONSerialization.data(withJSONObject: manifest),
              var manifestJSON = String(data: manifestData, encoding: .utf8) else {
            FileHandle.standardError.write("cannot encode the manifest\n".data(using: .utf8)!)
            exit(1)
        }
        manifestJSON = manifestJSON.replacingOccurrences(of: "<", with: "\\u003c")

        let configuration = WKWebViewConfiguration()
        // Count what the page sends across the bridge, so a test can see how
        // often the page talks to the native helper.
        configuration.userContentController.add(self, name: "pet")
        // The page is loaded from a string, so the WebView treats it as an
        // opaque origin and refuses to pull in file:// subresources (the
        // sprite atlas). Grant the page read access to the filesystem.
        configuration.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        for name in ["pet-runtime.js", "sprite-pet.js"] {
            let script = URL(fileURLWithPath: runtimeDir).appendingPathComponent(name)
            if let source = try? String(contentsOfFile: script.path, encoding: .utf8) {
                configuration.userContentController.addUserScript(WKUserScript(
                    source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
            }
        }

        // Collect page errors so a blank render can be diagnosed.
        let probeScript = """
        window.__dshErrors = [];
        window.addEventListener('error', function (event) {
          window.__dshErrors.push(String(event.message) + ' @ ' + event.filename + ':' + event.lineno);
        });
        window.addEventListener('unhandledrejection', function (event) {
          window.__dshErrors.push('unhandled rejection: ' + String(event.reason));
        });
        var nativeError = console.error;
        console.error = function () {
          window.__dshErrors.push(Array.prototype.join.call(arguments, ' '));
          nativeError.apply(console, arguments);
        };
        window.__imgTests = {};
        function testImage(key, src) {
          window.__imgTests[key] = 'pending';
          var t = new Image();
          t.onload = function () { window.__imgTests[key] = 'ok ' + t.naturalWidth + 'x' + t.naturalHeight; };
          t.onerror = function () { window.__imgTests[key] = 'error'; };
          t.src = src;
        }
        testImage('relative', 'spritesheet.webp');
        testImage('absolute', new URL('spritesheet.webp', document.baseURI).href);
        testImage('data', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
        testImage('fileAbs', '\(URL(fileURLWithPath: petDir).appendingPathComponent("preview.png").absoluteString)');
        // Does the rendering loop actually tick in this WebView? A WKWebView
        // that is not on screen stops servicing requestAnimationFrame, and the
        // pet would then sit on its first frame forever.
        window.__rafCount = 0;
        (function loop() { window.__rafCount++; requestAnimationFrame(loop); })();
        // The pet instance, so a test can read the engine's state.
        window.__pet = null;
        window.addEventListener('dsh-codex-pets-ready', function (event) {
          window.__pet = event.detail.pet;
        });
        """
        configuration.userContentController.addUserScript(WKUserScript(
            source: probeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))

        configuration.userContentController.addUserScript(WKUserScript(
            source: "window.__DSH_CODEX_PETS_MANIFEST__ = \(manifestJSON);",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true))

        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 220, height: 220), configuration: configuration)
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.underPageBackgroundColor = .clear

        // The window has to be on screen: WebKit suspends rendering (and
        // cancels image loads) for a view that is entirely off screen. The
        // snapshot is taken from the WebView, not from the screen, so what
        // is behind the window does not matter.
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 220, height: 220),
                          styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = webView
        window.orderFrontRegardless()

        let playerPage = URL(fileURLWithPath: runtimeDir).appendingPathComponent("player.html")
        guard FileManager.default.fileExists(atPath: playerPage.path) else {
            FileHandle.standardError.write("cannot read the player page\n".data(using: .utf8)!)
            exit(1)
        }
        // Load the page as a real file: a page built from a string has an
        // opaque origin and WebKit blocks every file:// subresource. The
        // granted access has to cover both the page and the atlas.
        webView.loadFileURL(playerPage, allowingReadAccessTo: commonAncestor(
            playerPage.deletingLastPathComponent(), URL(fileURLWithPath: petDir)))

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            if self.performNow {
                self.webView.evaluateJavaScript("window.DSHPet && window.DSHPet.perform()") { _, error in
                    if let error { FileHandle.standardError.write("perform failed: \(error)\n".data(using: .utf8)!) }
                }
            } else if !self.animation.isEmpty {
                self.webView.evaluateJavaScript(
                    "window.DSHPet && window.DSHPet.perform()") { _, _ in }
            }
        }

        // An extra script, so a test can drive the page the way a user
        // would (move the pointer, call into the bridge) and then read the
        // engine's state back with `--eval`.
        if !script.isEmpty {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                self.webView.evaluateJavaScript(self.script) { _, error in
                    if let error { FileHandle.standardError.write("script failed: \(error)\n".data(using: .utf8)!) }
                }
            }
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + Double(afterMilliseconds) / 1000.0) {
            self.probe()
            self.snapshot()
        }
    }

    /// The nearest directory that contains both paths.
    private func commonAncestor(_ left: URL, _ right: URL) -> URL {
        var a = left.pathComponents
        var b = right.pathComponents
        var shared: [String] = []
        while !a.isEmpty, !b.isEmpty, a.first == b.first {
            shared.append(a.removeFirst())
            b.removeFirst()
        }
        // The first path component is already "/", so drop it before
        // joining. WebKit only grants directory access to a URL that ends
        // in "/".
        let path = "/" + shared.dropFirst().joined(separator: "/")
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        FileHandle.standardError.write("read access: \(directory.absoluteString)\n".data(using: .utf8)!)
        return directory
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        FileHandle.standardError.write("navigated: \(webView.url?.absoluteString ?? "?")\n".data(using: .utf8)!)
    }

    /// Count what the page sends across the bridge.
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        let type = (message.body as? [String: Any])?["type"] as? String ?? "unknown"
        messageCounts[type, default: 0] += 1
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        FileHandle.standardError.write("navigation failed: \(error)\n".data(using: .utf8)!)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        FileHandle.standardError.write("provisional failed: \(error)\n".data(using: .utf8)!)
    }

    /// Ask the page what state it is in before the snapshot is taken.
    private func probe() {
        if !evaluate.isEmpty {
            webView.evaluateJavaScript(evaluate) { result, error in
                let text = (result as? String) ?? "nil"
                FileHandle.standardError.write("eval: \(text)\n".data(using: .utf8)!)
                if let error {
                    FileHandle.standardError.write("eval error: \(error)\n".data(using: .utf8)!)
                }
            }
        }
        if showMessages {
            let counts = messageCounts
                .sorted { $0.key < $1.key }
                .map { "\($0.key)=\($0.value)" }
                .joined(separator: " ")
            FileHandle.standardError.write("messages: \(counts)\n".data(using: .utf8)!)
        }
        let expression = """
        (function () {
          var canvas = document.getElementById('pet');
          var rect = canvas ? canvas.getBoundingClientRect() : null;
          var probe = new Image();
          probe.src = 'spritesheet.webp';
          var info = {
            errors: window.__dshErrors || [],
            manifest: !!window.__DSH_CODEX_PETS_MANIFEST__,
            engine: !!window.DSHSpritePet,
            img: window.__imgTests || {},
            backing: canvas ? [canvas.width, canvas.height] : null,
            css: rect ? [Math.round(rect.width), Math.round(rect.height)] : null,
            animation: document.body ? document.body.dataset.animation : null,
            resolved: probe.src,
            natural: [probe.naturalWidth, probe.naturalHeight],
            baseHref: document.baseURI,
            rafCount: window.__rafCount ?? -1,
            dbg: window.__dbg || null,
          };
          return JSON.stringify(info);
        })()
        """
        webView.evaluateJavaScript(expression) { result, error in
            let text = (result as? String) ?? "nil"
            FileHandle.standardError.write("probe: \(text)\n".data(using: .utf8)!)
            if let error {
                FileHandle.standardError.write("probe error: \(error)\n".data(using: .utf8)!)
            }
        }
    }

    private func snapshot() {
        let configuration = WKSnapshotConfiguration()
        configuration.rect = webView.bounds
        webView.takeSnapshot(with: configuration) { image, error in
            guard let image, let tiff = image.tiffRepresentation,
                  let bitmap = NSBitmapImageRep(data: tiff),
                  let png = bitmap.representation(using: .png, properties: [:]) else {
                FileHandle.standardError.write("snapshot failed: \(error?.localizedDescription ?? "?")\n".data(using: .utf8)!)
                exit(1)
            }
            try? png.write(to: URL(fileURLWithPath: self.outputPath))
            print(self.outputPath)
            NSApp.terminate(nil)
        }
    }
}

let application = NSApplication.shared
let renderer = Renderer()
application.delegate = renderer
application.run()
