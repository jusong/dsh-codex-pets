import AppKit
import Darwin
import ImageIO
import QuartzCore

/**
 * dsh-pet: a tiny macOS helper that owns the always-on-top pet window.
 *
 * The DSH host plugin spawns this binary, passes the pet directory and its
 * own PID, and kills it on unload. The window is an NSPanel at floating
 * level, joins all Spaces, and activates the DSH Desktop app when the pet is
 * clicked.
 *
 * The pet is drawn with nothing but Core Animation layers, and the helper
 * must not host a web view: WebKit's layer-tree commits and web-process
 * wake-ups hold the main thread for 30-80ms at a time, and a dragged window
 * cannot move while the main thread is held.
 */

/// The bookkeeping of a drag: where it started, and whether it really moved.
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

    mutating func noteMoved(mouse: NSPoint) {
        if abs(mouse.x - startMouse.x) > 3 || abs(mouse.y - startMouse.y) > 3 {
            moved = true
        }
    }

    mutating func end() {
        isDragging = false
    }
}

private func number(_ value: Any?) -> Double? {
    (value as? NSNumber)?.doubleValue
}

/// One row of the atlas, with a duration per frame. The last frame of a row
/// usually lingers.
struct PetAnimation {
    let name: String
    let row: Int
    let durations: [Double]
    let total: Double

    init(name: String, row: Int, durations: [Double]) {
        self.name = name
        self.row = row
        self.durations = durations.isEmpty ? [120] : durations
        let sum = self.durations.reduce(0, +)
        total = sum > 0 ? sum : 1
    }

    func frame(at elapsed: Double) -> Int {
        var end = 0.0
        for (index, duration) in durations.enumerated() {
            end += duration
            if elapsed < end { return index }
        }
        return durations.count - 1
    }
}

/**
 * What the Codex pet contract fixes, and a Codex `pet.json` therefore leaves
 * out: the rows, the frame timings and the behaviour. The same table lives
 * in `lib/codex-pet.js`; a manifest that spells things out wins over it.
 */
enum CodexContract {
    static let animations: [(name: String, durations: [Double])] = [
        ("idle", [280, 110, 110, 140, 140, 320]),
        ("running-right", [120, 120, 120, 120, 120, 120, 120, 220]),
        ("running-left", [120, 120, 120, 120, 120, 120, 120, 220]),
        ("waving", [140, 140, 140, 280]),
        ("jumping", [140, 140, 140, 140, 280]),
        ("failed", [140, 140, 140, 140, 140, 140, 140, 240]),
        ("waiting", [150, 150, 150, 150, 150, 260]),
        ("running", [120, 120, 120, 120, 120, 220]),
        ("review", [150, 150, 150, 150, 150, 280]),
    ]
    /// A v2 atlas (11 rows) carries the 16 gaze directions on rows 9 and 10.
    static let lookRows = [9, 10]
    static let idleActions = ["waiting", "waving", "running"]
    static let performSteps: [(name: String, repeats: Int)] = [("jumping", 1), ("waving", 1)]
}

/**
 * A pet is pure data: `pet.json` plus a sprite atlas. The manifest is the
 * same one the browser preview (`runtime/sprite-pet.js`) plays, and the
 * defaults below must stay in step with that engine.
 */
struct PetManifest {
    let atlasURL: URL
    let cellWidth: Int
    let cellHeight: Int
    let columns: Int
    let rows: Int
    let animations: [String: PetAnimation]
    let idle: String
    /// The gaze rows; empty means the pet does not look at the cursor.
    let lookRows: [Int]
    let lookCount: Int
    let lookStep: Double
    let idleActions: [String]
    /// The pause between two idle actions, in milliseconds.
    let idleMin: Double
    let idleMax: Double
    let performSteps: [(name: String, repeats: Int)]
    /// "water", "sparkle", or nil for no splash after a show.
    let splash: String?
    let dragRight: String
    let dragLeft: String
    let reactName: String

    init?(directory: URL) {
        let url = directory.appendingPathComponent("pet.json")
        guard let data = try? Data(contentsOf: url),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let sheet = object["spritesheetPath"] as? String, !sheet.isEmpty else {
            return nil
        }
        atlasURL = directory.appendingPathComponent(sheet)

        let cell = object["cell"] as? [String: Any]
        cellWidth = max(1, Int(number(cell?["width"]) ?? 192))
        cellHeight = max(1, Int(number(cell?["height"]) ?? 208))
        // A Codex manifest has no grid. The atlas says how many rows it has:
        // 9 for a v1 pet, 11 for a v2 one.
        var atlasRows = 11
        if let source = CGImageSourceCreateWithURL(atlasURL as CFURL, nil),
           let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
           let pixels = number(properties[kCGImagePropertyPixelHeight]) {
            atlasRows = max(1, Int(pixels) / cellHeight)
        }
        let grid = object["grid"] as? [String: Any]
        columns = max(1, Int(number(grid?["columns"]) ?? 8))
        rows = max(1, Int(number(grid?["rows"]) ?? Double(atlasRows)))

        var animations: [String: PetAnimation] = [:]
        for (name, raw) in (object["animations"] as? [String: Any]) ?? [:] {
            guard let spec = raw as? [String: Any] else { continue }
            let durations = ((spec["durations"] as? [Any]) ?? []).compactMap(number)
            animations[name] = PetAnimation(name: name, row: Int(number(spec["row"]) ?? 0), durations: durations)
        }
        if animations.isEmpty {
            for (row, spec) in CodexContract.animations.enumerated() {
                animations[spec.name] = PetAnimation(name: spec.name, row: row, durations: spec.durations)
            }
        }
        self.animations = animations
        idle = object["idle"] as? String ?? "idle"

        let look = object["look"] as? [String: Any]
        if let declared = look?["rows"] as? [Any] {
            lookRows = declared.compactMap(number).map { Int($0) }
        } else {
            lookRows = rows >= 11 ? CodexContract.lookRows : []
        }
        lookCount = max(1, Int(number(look?["count"]) ?? 16))
        lookStep = number(look?["stepDegrees"]) ?? 22.5

        let routine = object["idleRoutine"] as? [String: Any] ?? [:]
        let actions = (routine["animations"] as? [Any])?.compactMap { $0 as? String } ?? []
        idleActions = actions.isEmpty ? CodexContract.idleActions : actions
        var low = 5000.0
        var high = 5000.0
        if let every = routine["every"] as? [Any], every.count == 2,
           let a = number(every[0]), let b = number(every[1]), a > 0 {
            low = a * 1000
            high = max(low, b * 1000)
        } else if let seconds = number(routine["every"]), seconds > 0 {
            low = seconds * 1000
            high = low
        }
        idleMin = low
        idleMax = high

        let perform = object["perform"] as? [String: Any] ?? [:]
        let steps: [(name: String, repeats: Int)] = ((perform["sequence"] as? [Any]) ?? []).compactMap { step in
            if let name = step as? String { return (name, 1) }
            if let spec = step as? [String: Any], let name = spec["animation"] as? String {
                return (name, max(1, Int(number(spec["repeat"]) ?? 1)))
            }
            return nil
        }
        // A manifest that says nothing about a show gets the Codex one.
        let showDefined = object["perform"] is [String: Any]
        performSteps = showDefined ? steps : CodexContract.performSteps
        switch perform["splash"] {
        case let kind as String: splash = kind == "sparkle" ? "sparkle" : "water"
        case let flag as NSNumber where flag.boolValue: splash = "water"
        default: splash = showDefined ? nil : "sparkle"
        }

        let drag = object["drag"] as? [String: Any]
        dragRight = drag?["right"] as? String ?? "running-right"
        dragLeft = drag?["left"] as? String ?? "running-left"
        reactName = (object["react"] as? [String: Any])?["click"] as? String ?? "jumping"
    }
}

/**
 * Plays a pet: one layer shows one atlas cell at a time.
 *
 * The atlas is sliced into cells once, so a frame change is a pointer swap
 * of the layer's contents and never a redraw.
 */
final class SpritePlayer {
    let petLayer = CALayer()
    let groundShadow = CAGradientLayer()
    private let manifest: PetManifest
    private let cells: [[CGImage?]]
    private let reducedMotion: Bool

    private struct Playing {
        let animation: PetAnimation
        let loop: Bool
        var elapsed = 0.0
        var frame = 0

        /// Move the clock on; true when a one-shot animation is over.
        mutating func advance(by delta: Double) -> Bool {
            elapsed += delta
            frame = animation.frame(at: elapsed)
            guard elapsed >= animation.total else { return false }
            if loop {
                elapsed = elapsed.truncatingRemainder(dividingBy: animation.total)
                return false
            }
            return true
        }
    }

    private struct Sequence {
        let plan: [PetAnimation]
        var index = 0
    }

    private var animation: Playing?
    private var sequence: Sequence?
    private var dragAnimation: Playing?
    private var lookFrame: (row: Int, column: Int)?
    private var reacting = false
    private var idleElapsed = 0.0
    private var idleWait = 0.0
    private var idleCursor = 0
    private var shownCell: (row: Int, column: Int)?

    init?(manifest: PetManifest, reducedMotion: Bool) {
        guard let source = CGImageSourceCreateWithURL(manifest.atlasURL as CFURL, nil),
              let atlas = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            return nil
        }
        self.manifest = manifest
        self.reducedMotion = reducedMotion
        cells = (0..<manifest.rows).map { row in
            (0..<manifest.columns).map { column in
                atlas.cropping(to: CGRect(x: column * manifest.cellWidth,
                                          y: row * manifest.cellHeight,
                                          width: manifest.cellWidth,
                                          height: manifest.cellHeight))
            }
        }
        idleWait = pickIdleWait()

        petLayer.contentsGravity = .resizeAspect
        petLayer.magnificationFilter = .nearest
        petLayer.minificationFilter = .nearest
        petLayer.shadowColor = CGColor(srgbRed: 8 / 255, green: 22 / 255, blue: 44 / 255, alpha: 1)
        petLayer.shadowOpacity = 0.22
        petLayer.shadowRadius = 5
        petLayer.shadowOffset = CGSize(width: 0, height: -8)

        let ground = CGColor(srgbRed: 11 / 255, green: 31 / 255, blue: 58 / 255, alpha: 0.2)
        groundShadow.type = .radial
        groundShadow.startPoint = CGPoint(x: 0.5, y: 0.5)
        groundShadow.endPoint = CGPoint(x: 1, y: 1)
        groundShadow.colors = [ground, ground, ground.copy(alpha: 0)!]
        groundShadow.locations = [0, 0.7, 1]

        play(manifest.idle, loop: true)
    }

    /// Whether a cell has anything drawn in it.
    private static func hasPixels(_ image: CGImage?) -> Bool {
        guard let image else { return false }
        let width = image.width
        let height = image.height
        var data = [UInt8](repeating: 0, count: width * height * 4)
        let drawn = data.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
                                          bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { return false }
        for index in stride(from: 3, to: data.count, by: 4) where data[index] != 0 { return true }
        return false
    }

    /// How the manifest reads against the atlas, for `--describe`: every
    /// animation with the number of its frames that really have a sprite.
    func report() -> [String: Any] {
        var animations: [String: Any] = [:]
        for (name, spec) in manifest.animations {
            let frames = spec.durations.count
            let drawn = (0..<frames).filter { frame in
                cells.indices.contains(spec.row) && cells[spec.row].indices.contains(frame)
                    && SpritePlayer.hasPixels(cells[spec.row][frame])
            }.count
            animations[name] = ["row": spec.row, "frames": frames, "drawn": drawn]
        }
        var look: [String: Any] = ["rows": manifest.lookRows]
        var drawnLook = 0
        for index in 0..<(manifest.lookRows.isEmpty ? 0 : manifest.lookCount) {
            let row = manifest.lookRows[min(index / manifest.columns, manifest.lookRows.count - 1)]
            let column = index % manifest.columns
            if cells.indices.contains(row), cells[row].indices.contains(column), SpritePlayer.hasPixels(cells[row][column]) {
                drawnLook += 1
            }
        }
        look["drawn"] = drawnLook
        look["count"] = manifest.lookRows.isEmpty ? 0 : manifest.lookCount
        return [
            "grid": ["columns": manifest.columns, "rows": manifest.rows],
            "cell": ["width": manifest.cellWidth, "height": manifest.cellHeight],
            "idle": manifest.idle,
            "drag": ["right": manifest.dragRight, "left": manifest.dragLeft],
            "react": manifest.reactName,
            "animations": animations,
            "look": look,
        ]
    }

    /// Lay the pet out as a square of `edge`, centred in a container.
    func layout(in container: CGRect, edge: CGFloat, scale: CGFloat) {
        let pet = CGRect(x: container.midX - edge / 2, y: container.midY - edge / 2, width: edge, height: edge)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        petLayer.frame = pet
        petLayer.contentsScale = scale
        // The ground shadow sits just under the feet, which land around 70%
        // down the cell.
        groundShadow.bounds = CGRect(x: 0, y: 0, width: pet.width * 0.52, height: pet.height * 0.06)
        groundShadow.position = CGPoint(x: pet.midX, y: pet.minY + pet.height * 0.23)
        CATransaction.commit()
    }

    // -- clock -------------------------------------------------------------

    func tick(delta: Double) {
        if reducedMotion {
            show(idleRow, 0)
            return
        }
        if sequence != nil {
            stepSequence(delta)
            return
        }
        if var drag = dragAnimation {
            _ = drag.advance(by: delta)
            dragAnimation = drag
            draw()
            return
        }
        guard var active = animation else {
            draw()
            return
        }
        if active.advance(by: delta) {
            animation = nil
            reacting = false
            play(manifest.idle, loop: true)
            return
        }
        animation = active
        // The idle rows barely move on their own, so every few seconds the
        // pet takes a short turn at another row.
        if active.animation.name == manifest.idle {
            idleElapsed += delta
            if idleElapsed >= idleWait {
                idleElapsed = 0
                idleWait = pickIdleWait()
                playIdleAction()
            }
        }
        draw()
    }

    private func pickIdleWait() -> Double {
        guard manifest.idleMax > manifest.idleMin else { return manifest.idleMin }
        return Double.random(in: manifest.idleMin...manifest.idleMax)
    }

    private func playIdleAction() {
        let options = manifest.idleActions
        for offset in 0..<options.count {
            let name = options[(idleCursor + offset) % options.count]
            guard name != manifest.idle, manifest.animations[name] != nil else { continue }
            idleCursor = (idleCursor + offset + 1) % options.count
            play(name, loop: false)
            return
        }
    }

    /// Play one named animation; an unknown name falls back to idle, so a
    /// typo in a manifest can never leave the pet frozen.
    private func play(_ name: String, loop: Bool) {
        guard let spec = manifest.animations[name] else {
            if name != manifest.idle { play(manifest.idle, loop: true) }
            return
        }
        animation = Playing(animation: spec, loop: loop)
        idleElapsed = 0
        applyState(name)
        draw()
    }

    private var idleRow: Int { manifest.animations[manifest.idle]?.row ?? 0 }

    // -- behaviour ---------------------------------------------------------

    /// The scheduled show. Returns its length in milliseconds.
    func perform() -> Double {
        var plan: [PetAnimation] = []
        for step in manifest.performSteps {
            guard let spec = manifest.animations[step.name] else { continue }
            plan.append(contentsOf: Array(repeating: spec, count: step.repeats))
        }
        guard !plan.isEmpty else {
            play(manifest.idle, loop: true)
            return 0
        }
        sequence = Sequence(plan: plan)
        playStep()
        return plan.reduce(0) { $0 + $1.total }
    }

    private func playStep() {
        guard let sequence else { return }
        let step = sequence.plan[sequence.index]
        animation = Playing(animation: step, loop: false)
        applyState(step.name)
        draw()
    }

    private func stepSequence(_ delta: Double) {
        guard var sequence, var active = animation else { return }
        if active.advance(by: delta) {
            sequence.index += 1
            if sequence.index >= sequence.plan.count {
                self.sequence = nil
                play(manifest.idle, loop: true)
                if let kind = manifest.splash { splash(kind: kind) }
                return
            }
            self.sequence = sequence
            playStep()
            return
        }
        animation = active
        draw()
    }

    /// Answer a click with the reaction animation; the reaction outranks
    /// the gaze, so the pet jumps instead of staring.
    func react() {
        stopAll()
        lookFrame = nil
        guard manifest.animations[manifest.reactName] != nil else {
            play(manifest.idle, loop: true)
            return
        }
        reacting = true
        play(manifest.reactName, loop: false)
    }

    /// Drop the show, the reaction and the gaze, and stand still.
    func interrupt() {
        stopAll()
        lookFrame = nil
        play(manifest.idle, loop: true)
    }

    private func stopAll() {
        sequence = nil
        dragAnimation = nil
        reacting = false
    }

    /// Run left or right while dragged; nil stands still.
    func setDragDirection(right: Bool?) {
        guard let right else {
            guard dragAnimation != nil else { return }
            dragAnimation = nil
            applyState(animation?.animation.name ?? manifest.idle)
            draw()
            return
        }
        let name = right ? manifest.dragRight : manifest.dragLeft
        guard let spec = manifest.animations[name], dragAnimation?.animation.name != name else { return }
        dragAnimation = Playing(animation: spec, loop: true)
        applyState(name)
        draw()
    }

    func endDrag() {
        dragAnimation = nil
        play(manifest.idle, loop: true)
    }

    /// Look in a direction: 0 degrees is straight up, growing clockwise.
    func look(degrees: Double) {
        guard !manifest.lookRows.isEmpty else { return }
        let count = manifest.lookCount
        // Rounded the way the browser engine's Math.round does.
        let bucket = Int((degrees / manifest.lookStep + 0.5).rounded(.down))
        let index = ((bucket % count) + count) % count
        let rowIndex = index / manifest.columns
        let row = manifest.lookRows.indices.contains(rowIndex) ? manifest.lookRows[rowIndex] : manifest.lookRows[0]
        let next = (row: row, column: index % manifest.columns)
        if let current = lookFrame, current == next { return }
        lookFrame = next
        draw()
    }

    func lookOut() {
        guard lookFrame != nil else { return }
        lookFrame = nil
        draw()
    }

    // -- drawing -----------------------------------------------------------

    /// A show beats a drag, a drag beats a reaction, a reaction beats the
    /// gaze, and the gaze beats the animation.
    private func draw() {
        if sequence != nil, let active = animation { return show(active.animation.row, active.frame) }
        if let drag = dragAnimation { return show(drag.animation.row, drag.frame) }
        if reacting, let active = animation { return show(active.animation.row, active.frame) }
        if let look = lookFrame { return show(look.row, look.column) }
        if let active = animation { return show(active.animation.row, active.frame) }
        show(idleRow, 0)
    }

    private func show(_ row: Int, _ column: Int) {
        if let shown = shownCell, shown == (row, column) { return }
        guard cells.indices.contains(row), cells[row].indices.contains(column) else { return }
        shownCell = (row, column)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        petLayer.contents = cells[row][column]
        CATransaction.commit()
    }

    /// The ground shadow shrinks while the pet is in the air.
    private func applyState(_ name: String) {
        let (scale, opacity): (CGFloat, Float)
        switch name {
        case "jumping": (scale, opacity) = (0.72, 0.55)
        case "waving": (scale, opacity) = (0.92, 1)
        case "failed": (scale, opacity) = (1.06, 0.28)
        default: (scale, opacity) = (1, 1)
        }
        CATransaction.begin()
        CATransaction.setAnimationDuration(reducedMotion ? 0 : 0.18)
        groundShadow.setAffineTransform(CGAffineTransform(scaleX: scale, y: scale))
        groundShadow.opacity = opacity
        CATransaction.commit()
    }

    /// Particles that fly up from the pet's feet after a show.
    private func splash(kind: String) {
        guard !reducedMotion, let host = petLayer.superlayer else { return }
        let bounds = host.bounds
        let now = CACurrentMediaTime()
        let sparkle = kind == "sparkle"
        let color = sparkle
            ? CGColor(srgbRed: 1, green: 233 / 255, blue: 168 / 255, alpha: 1)
            : CGColor(srgbRed: 143 / 255, green: 216 / 255, blue: 1, alpha: 1)
        var added: [CALayer] = []

        for _ in 0..<20 {
            let particle = CALayer()
            particle.bounds = sparkle ? CGRect(x: 0, y: 0, width: 6, height: 6) : CGRect(x: 0, y: 0, width: 7, height: 10)
            particle.cornerRadius = sparkle ? 2 : 3.5
            particle.backgroundColor = color
            particle.shadowColor = color
            particle.shadowOpacity = 0.9
            particle.shadowRadius = sparkle ? 4 : 3
            particle.shadowOffset = .zero
            particle.opacity = 0
            let start = CGPoint(x: bounds.width * (0.5 + Double.random(in: -0.06...0.06)),
                                y: bounds.height * 0.2)
            particle.position = start
            // Up, give or take 63 degrees either side.
            let angle = Double.pi / 2 + Double.random(in: -1.1...1.1)
            let distance = 16 + Double.random(in: 0...44)
            let end = CGPoint(x: start.x + cos(angle) * distance, y: start.y + sin(angle) * distance)
            let early = CGPoint(x: start.x + (end.x - start.x) * 0.18, y: start.y + (end.y - start.y) * 0.18)

            let move = CAKeyframeAnimation(keyPath: "position")
            move.values = [start, early, end].map { NSValue(point: $0) }
            move.keyTimes = [0, 0.15, 1]
            let fade = CAKeyframeAnimation(keyPath: "opacity")
            fade.values = [0, 1, 0]
            fade.keyTimes = [0, sparkle ? 0.2 : 0.15, 1]
            let grow = CAKeyframeAnimation(keyPath: "transform.scale")
            grow.values = sparkle ? [0.3, 1, 0.4] : [0.35, 1.15, 0.3]
            grow.keyTimes = [0, 0.15, 1]
            var parts: [CAAnimation] = [move, fade, grow]
            if sparkle {
                let spin = CABasicAnimation(keyPath: "transform.rotation.z")
                spin.fromValue = 0
                spin.toValue = Double.pi
                parts.append(spin)
            }
            let group = CAAnimationGroup()
            group.animations = parts
            group.duration = Double.random(in: 0.85...1.1)
            group.beginTime = now + Double.random(in: 0...0.1)
            group.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.7, 0.3, 1)
            group.fillMode = .both
            group.isRemovedOnCompletion = false
            particle.add(group, forKey: "fly")
            host.addSublayer(particle)
            added.append(particle)
        }

        if !sparkle {
            for index in 0..<2 {
                let ripple = CAShapeLayer()
                ripple.bounds = CGRect(x: 0, y: 0, width: 72, height: 14)
                ripple.position = CGPoint(x: bounds.midX, y: bounds.height * 0.16 + 7)
                ripple.path = CGPath(ellipseIn: ripple.bounds, transform: nil)
                ripple.fillColor = nil
                ripple.strokeColor = color
                ripple.lineWidth = 2
                ripple.opacity = 0
                let grow = CABasicAnimation(keyPath: "transform.scale")
                grow.fromValue = 0.4
                grow.toValue = 1.9
                let fade = CABasicAnimation(keyPath: "opacity")
                fade.fromValue = 0.75
                fade.toValue = 0
                let group = CAAnimationGroup()
                group.animations = [grow, fade]
                group.duration = 1.05
                group.beginTime = now + Double(index) * 0.16
                group.timingFunction = CAMediaTimingFunction(name: .easeOut)
                group.fillMode = .both
                group.isRemovedOnCompletion = false
                ripple.add(group, forKey: "ripple")
                host.addSublayer(ripple)
                added.append(ripple)
            }
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            added.forEach { $0.removeFromSuperlayer() }
        }
    }
}

/// The pet's content view: it takes the clicks and hands them to the
/// controller.
final class PetView: NSView {
    weak var controller: PetController?

    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { controller?.beginDrag(with: event) }
    override func mouseDragged(with event: NSEvent) { controller?.continueDrag() }
    override func mouseUp(with event: NSEvent) { controller?.endDrag() }
}

final class PetController: NSObject, NSApplicationDelegate {
    private var panel: NSPanel!
    private var player: SpritePlayer!
    private var petDir = ""
    /// Print how the pet's manifest reads against its atlas, then exit.
    private var describe = false
    private var statePath = ""
    private var lockPath = ""
    private var dragLogPath = ""
    private var size: CGFloat = 220
    private var parentPid: pid_t = 0
    private var lockFD: Int32 = -1
    private var levelName = "floating"
    private var performNow = false
    private var dragBench = false

    private var drag = DragState()
    /// The benchmark drives the drag with a cursor it controls.
    private var cursorOverride: NSPoint?
    private var cursor: NSPoint { cursorOverride ?? NSEvent.mouseLocation }

    private var animationTimer: Timer?
    private var lastTick = CACurrentMediaTime()
    private var gazeTimer: Timer?
    private var performanceTimer: Timer?
    /// Keeps App Nap and timer coalescing away while the pet is in the hand.
    private var dragActivity: NSObjectProtocol?
    /// When the drag last moved sideways, so a pet held still stops running.
    private var lastSidewaysMove: CFTimeInterval = 0
    /// Whether the window server is carrying the current drag.
    private var serverDrag = false
    private var releaseTimer: Timer?
    private var lastSeenOrigin = NSPoint.zero
    private var lastCursor = NSPoint.zero

    // What a drag did, for the drag log.
    private var pressTime: CFTimeInterval = 0
    private var firstMoveTime: CFTimeInterval = 0
    private var lastMoveTime: CFTimeInterval = 0
    private var worstMoveGap: Double = 0
    private var windowMoves = 0
    private var maxTrail: Double = 0
    private var moveCost: Double = 0
    private var watchdog: Timer?
    private var lastBeat: CFTimeInterval = 0
    private var worstBlock: Double = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        parseArguments()
        if describe {
            describePet()
            return
        }
        acquireLock()
        guard let manifest = PetManifest(directory: URL(fileURLWithPath: petDir)) else {
            NSLog("dsh-pet: no usable pet manifest in \(petDir), exiting")
            NSApp.terminate(nil)
            return
        }
        guard let player = SpritePlayer(
            manifest: manifest,
            reducedMotion: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        ) else {
            NSLog("dsh-pet: cannot read the atlas at \(manifest.atlasURL.path), exiting")
            NSApp.terminate(nil)
            return
        }
        self.player = player
        createPanel()
        startClocks()
        watchParent()
        watchCommands()
        if dragBench {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in self?.runDragBenchmark() }
        } else if performNow {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in self?.startPerformance() }
        } else {
            schedulePerformance()
        }
    }

    /// `--describe`: a report for checking a pet without showing it.
    private func describePet() {
        guard let manifest = PetManifest(directory: URL(fileURLWithPath: petDir)),
              let player = SpritePlayer(manifest: manifest, reducedMotion: true),
              let data = try? JSONSerialization.data(withJSONObject: player.report(), options: [.prettyPrinted, .sortedKeys]) else {
            FileHandle.standardError.write(Data("no usable pet in \(petDir)\n".utf8))
            exit(1)
        }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
        exit(0)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    private func parseArguments() {
        var iterator = CommandLine.arguments.dropFirst().makeIterator()
        while let argument = iterator.next() {
            switch argument {
            case "--pet-dir": petDir = iterator.next() ?? ""
            case "--state": statePath = iterator.next() ?? ""
            case "--lock": lockPath = iterator.next() ?? ""
            case "--drag-log": dragLogPath = iterator.next() ?? ""
            case "--size": size = CGFloat(Double(iterator.next() ?? "") ?? 220)
            case "--parent-pid": parentPid = pid_t(Int32(iterator.next() ?? "") ?? 0)
            case "--level": levelName = iterator.next() ?? "floating"
            case "--perform-now": performNow = true
            case "--drag-bench": dragBench = true
            case "--describe": describe = true
            // The host still passes the web runtime; the helper no longer
            // needs it.
            case "--runtime": _ = iterator.next()
            default: break
            }
        }
        size = min(260, max(120, size))
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

        let view = PetView(frame: NSRect(x: 0, y: 0, width: size, height: size))
        view.controller = self
        view.wantsLayer = true
        if let host = view.layer {
            host.backgroundColor = .clear
            host.addSublayer(player.groundShadow)
            host.addSublayer(player.petLayer)
        }
        shownEdge = size
        player.layout(in: view.bounds, edge: size, scale: panel.backingScaleFactor)
        panel.contentView = view
        panel.orderFrontRegardless()
        NotificationCenter.default.addObserver(
            self, selector: #selector(windowDidMove(_:)),
            name: NSWindow.didMoveNotification, object: panel
        )
    }

    // -- clocks ------------------------------------------------------------

    private func startClocks() {
        // Frames last 110ms and more, so 60 ticks a second is plenty; common
        // mode keeps them running while AppKit tracks the mouse.
        let animation = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in self?.tick() }
        animation.tolerance = 0.002
        RunLoop.main.add(animation, forMode: .common)
        animationTimer = animation
        lastTick = CACurrentMediaTime()

        let gaze = Timer(timeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in self?.updateGaze() }
        gaze.tolerance = 0.005
        RunLoop.main.add(gaze, forMode: .common)
        gazeTimer = gaze
    }

    private func tick() {
        let now = CACurrentMediaTime()
        let delta = (now - lastTick) * 1000
        lastTick = now
        if drag.isDragging, now - lastSidewaysMove > 0.2 {
            player.setDragDirection(right: nil)
        }
        player.tick(delta: delta)
    }

    /// Point the pet at the cursor, if the cursor is close enough.
    ///
    /// The helper reads the cursor itself: a floating pet is never the
    /// frontmost app, and macOS only sends mouse-moved events to that one.
    private func updateGaze() {
        guard !drag.isDragging else { return }
        let mouse = NSEvent.mouseLocation
        let frame = panel.frame
        // Measured from the pet's eyes, a little above the middle, in a
        // top-left space. While the pet is being resized the window is
        // bigger than the pet, which sits in its middle.
        let dx = (mouse.x - frame.minX) - frame.width / 2
        let dy = (frame.height - (mouse.y - frame.minY)) - ((frame.height - size) / 2 + size * 0.42)
        guard hypot(dx, dy) <= size * 1.4 else {
            player.lookOut()
            return
        }
        player.look(degrees: atan2(dx, -dy) * 180 / .pi)
    }

    // -- drag --------------------------------------------------------------

    /**
     * Start a drag.
     *
     * A real drag is handed to the window server with `performDrag(with:)`,
     * the machinery a title-bar drag uses: the server moves the window with
     * the cursor itself. The helper must not move the window on its own --
     * every `setFrameOrigin` is a round trip to the window server, and a
     * busy server (a 5K display at 120Hz is enough) holds the main thread
     * for up to 60ms per move, which is exactly the lag a person sees.
     *
     * Without an event (the benchmark) the helper moves the window itself,
     * so that path can still be measured.
     */
    func beginDrag(with event: NSEvent? = nil) {
        let now = CACurrentMediaTime()
        drag.begin(at: cursor, origin: panel.frame.origin)
        dragActivity = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiated, .latencyCritical],
            reason: "dragging the pet"
        )
        pressTime = now
        firstMoveTime = 0
        lastMoveTime = 0
        worstMoveGap = 0
        windowMoves = 0
        maxTrail = 0
        moveCost = 0
        lastSidewaysMove = 0
        player.interrupt()
        // A click puts the next show off.
        schedulePerformance(after: 20)
        startWatchdog()
        guard let event else { return }
        serverDrag = true
        lastSeenOrigin = panel.frame.origin
        lastCursor = cursor
        // The release may never reach the view once the server owns the
        // drag, so the button is watched instead.
        let release = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            self?.watchServerDrag()
        }
        RunLoop.main.add(release, forMode: .common)
        releaseTimer = release
        panel.performDrag(with: event)
        if NSEvent.pressedMouseButtons & 1 == 0 { endDrag() }
    }

    /// Follow the cursor while the window server carries the drag.
    ///
    /// The way the pet runs comes from the cursor, not from the window:
    /// the move notifications arrive a few times a second at best, too few
    /// to tell left from right.
    private func watchServerDrag() {
        guard drag.isDragging, serverDrag else { return }
        if NSEvent.pressedMouseButtons & 1 == 0 {
            endDrag()
            return
        }
        let mouse = cursor
        drag.noteMoved(mouse: mouse)
        let dx = mouse.x - lastCursor.x
        lastCursor = mouse
        // 2pt a tick (120pt/s) keeps a mostly vertical drag from flipping
        // the pet on every wobble.
        guard drag.moved, abs(dx) >= 2 else { return }
        lastSidewaysMove = CACurrentMediaTime()
        player.setDragDirection(right: dx > 0)
    }

    /// The window server moved the window during a drag.
    @objc private func windowDidMove(_ notification: Notification) {
        guard drag.isDragging, serverDrag else { return }
        let now = CACurrentMediaTime()
        let origin = panel.frame.origin
        drag.noteMoved(mouse: cursor)
        if firstMoveTime == 0 { firstMoveTime = now }
        if lastMoveTime > 0 { worstMoveGap = max(worstMoveGap, (now - lastMoveTime) * 1000) }
        lastMoveTime = now
        windowMoves += 1
        maxTrail = max(maxTrail, hypot(origin.x - lastSeenOrigin.x, origin.y - lastSeenOrigin.y))
        lastSeenOrigin = origin
    }

    func continueDrag() {
        guard drag.isDragging, !serverDrag else { return }
        let mouse = cursor
        drag.noteMoved(mouse: mouse)
        let origin = panel.frame.origin
        let target = drag.windowOrigin(for: mouse)
        guard target != origin else { return }

        let started = CACurrentMediaTime()
        panel.setFrameOrigin(target)
        let now = CACurrentMediaTime()
        moveCost += now - started
        maxTrail = max(maxTrail, hypot(target.x - origin.x, target.y - origin.y))
        if firstMoveTime == 0 { firstMoveTime = now }
        if lastMoveTime > 0 { worstMoveGap = max(worstMoveGap, (now - lastMoveTime) * 1000) }
        lastMoveTime = now
        windowMoves += 1

        if drag.moved, abs(target.x - origin.x) >= 1 {
            lastSidewaysMove = now
            player.setDragDirection(right: target.x > origin.x)
        }
    }

    func endDrag() {
        guard drag.isDragging else { return }
        continueDrag()
        drag.noteMoved(mouse: cursor)
        drag.end()
        releaseTimer?.invalidate()
        releaseTimer = nil
        let byServer = serverDrag
        serverDrag = false
        stopWatchdog()
        if let dragActivity { ProcessInfo.processInfo.endActivity(dragActivity) }
        dragActivity = nil
        if drag.moved {
            saveOrigin()
            player.endDrag()
        } else {
            activateDSH()
            player.react()
        }
        writeDragLog(byServer: byServer)
    }

    /// A 4ms heartbeat while dragging: the longest gap between two beats is
    /// the longest the main thread was held, which is what a person feels.
    private func startWatchdog() {
        lastBeat = CACurrentMediaTime()
        worstBlock = 0
        let timer = Timer(timeInterval: 0.004, repeats: true) { [weak self] _ in
            guard let self else { return }
            let now = CACurrentMediaTime()
            self.worstBlock = max(self.worstBlock, (now - self.lastBeat) * 1000)
            self.lastBeat = now
        }
        RunLoop.main.add(timer, forMode: .common)
        watchdog = timer
    }

    private func stopWatchdog() {
        watchdog?.invalidate()
        watchdog = nil
    }

    private func rounded(_ value: Double) -> Double { (value * 10).rounded() / 10 }

    /// Write a line about the drag, so "does it follow?" has numbers.
    private func writeDragLog(byServer: Bool) {
        guard !dragLogPath.isEmpty else { return }
        let first = firstMoveTime == 0 ? 0 : (firstMoveTime - pressTime) * 1000
        let object: [String: Any] = [
            "at": Date().timeIntervalSince1970,
            "mover": byServer ? "window-server" : "helper",
            "moved": drag.moved,
            "moves": windowMoves,
            "dragMs": rounded((CACurrentMediaTime() - pressTime) * 1000),
            "pressToFirstMoveMs": rounded(first),
            "maxTrailPx": rounded(maxTrail),
            "worstMoveGapMs": rounded(worstMoveGap),
            "worstMainBlockMs": rounded(worstBlock),
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        var line = data
        line.append(0x0A)
        let manager = FileManager.default
        // A note of the last few drags, not a history of every drag ever.
        if let attributes = try? manager.attributesOfItem(atPath: dragLogPath),
           let bytes = attributes[.size] as? Int, bytes > 32_768 {
            try? manager.removeItem(atPath: dragLogPath)
        }
        // FileHandle(forWritingTo:) will not create the file.
        if !manager.fileExists(atPath: dragLogPath) {
            manager.createFile(atPath: dragLogPath, contents: nil)
        }
        if let handle = FileHandle(forWritingAtPath: dragLogPath) {
            handle.seekToEndOfFile()
            handle.write(line)
            try? handle.close()
        }
    }

    // -- performance -------------------------------------------------------

    private func schedulePerformance(after delay: TimeInterval? = nil) {
        performanceTimer?.invalidate()
        let wait = delay ?? Double.random(in: 18...30)
        performanceTimer = Timer.scheduledTimer(withTimeInterval: wait, repeats: false) { [weak self] _ in
            self?.startPerformance()
        }
    }

    private func startPerformance() {
        // Don't start a show under the cursor or in the hand.
        if drag.isDragging || panel.frame.contains(NSEvent.mouseLocation) {
            schedulePerformance(after: 6)
            return
        }
        let seconds = max(0.5, min(15.0, player.perform() / 1000))
        schedulePerformance(after: seconds + Double.random(in: 18...30))
    }

    // -- host --------------------------------------------------------------

    private func activateDSH() {
        if let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.deepseek.dsh").first {
            app.unhide()
            app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
            return
        }
        NSWorkspace.shared.openApplication(
            at: URL(fileURLWithPath: "/Applications/DeepSeek Harness.app"),
            configuration: NSWorkspace.OpenConfiguration(),
            completionHandler: nil
        )
    }

    /**
     * Take commands from the host on stdin, one per line.
     *
     * `size N` resizes the pet while it stays on screen: the settings page
     * writes the slider's value on every step, and restarting the helper
     * for each one would make the pet vanish and come back again and again.
     * Anything else, and a closed pipe, is ignored.
     */
    private func watchCommands() {
        var pending = Data()
        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            // End of input: nobody is going to write any more.
            guard !chunk.isEmpty else {
                handle.readabilityHandler = nil
                return
            }
            pending.append(chunk)
            while let newline = pending.firstIndex(of: 0x0A) {
                let line = String(decoding: pending[pending.startIndex..<newline], as: UTF8.self)
                pending.removeSubrange(pending.startIndex...newline)
                let parts = line.split(separator: " ")
                guard parts.count == 2, parts[0] == "size", let value = Double(parts[1]) else { continue }
                DispatchQueue.main.async { self?.resize(to: CGFloat(value)) }
            }
        }
    }

    private static let maxEdge: CGFloat = 260
    private static let minEdge: CGFloat = 120
    /// How long the slider has to rest before the window is fitted to the pet.
    private static let settleDelay: TimeInterval = 0.25
    private var settleTimer: Timer?
    /// The size the pet is drawn at this frame, on its way to `size`.
    private var shownEdge: CGFloat = 0
    private var glideTimer: Timer?
    private var glideClock: CFTimeInterval = 0
    /// Time constant of the glide, in seconds.
    private static let glideTau: Double = 0.05

    /**
     * Change the pet's size, keeping its centre where it is.
     *
     * Resizing the window itself is what flashed: every `setFrame` makes the
     * window server rebuild the backing store of a transparent window, the
     * pet's layer only learns the new size afterwards, and the sizes arrive
     * in steps of 10px with nothing in between. So while the size is in
     * motion the window is opened up to its largest once and stays there,
     * and the pet is only a layer inside it, eased towards each new size
     * frame by frame. When the slider rests, the window is fitted to the pet
     * in a single step that changes nothing on screen.
     */
    private func resize(to requested: CGFloat) {
        let edge = min(Self.maxEdge, max(Self.minEdge, requested.rounded()))
        guard edge != size, let view = panel.contentView else { return }

        if panel.frame.width < Self.maxEdge {
            // The pet keeps its current size and place; only the room around
            // it grows. The window may reach past the screen's edge for a
            // moment -- the fit below pulls it back.
            let old = panel.frame
            let wide = NSRect(x: old.midX - Self.maxEdge / 2, y: old.midY - Self.maxEdge / 2,
                              width: Self.maxEdge, height: Self.maxEdge)
            shownEdge = size
            panel.setFrame(wide, display: false)
            player.layout(in: view.bounds, edge: shownEdge, scale: panel.backingScaleFactor)
        }

        size = edge
        settleTimer?.invalidate()
        settleTimer = nil
        guard glideTimer == nil else { return }
        glideClock = CACurrentMediaTime()
        let timer = Timer(timeInterval: 1.0 / 120, repeats: true) { [weak self] _ in self?.glideStep() }
        RunLoop.main.add(timer, forMode: .common)
        glideTimer = timer
    }

    /// One frame of the glide: close part of the gap to the wanted size.
    private func glideStep() {
        guard let view = panel.contentView else { return }
        let now = CACurrentMediaTime()
        let delta = min(0.05, now - glideClock)
        glideClock = now
        // Exponential easing: quick to react, no overshoot, and a target
        // that moves mid-glide just changes where it is heading.
        let gap = size - shownEdge
        shownEdge = abs(gap) < 0.25 ? size : shownEdge + gap * (1 - CGFloat(exp(-delta / Self.glideTau)))
        player.layout(in: view.bounds, edge: shownEdge, scale: panel.backingScaleFactor)
        guard shownEdge == size else { return }
        glideTimer?.invalidate()
        glideTimer = nil
        settleTimer = Timer.scheduledTimer(withTimeInterval: Self.settleDelay, repeats: false) { [weak self] _ in
            self?.fitWindowToPet()
        }
    }

    /// Shrink the window around the pet once the size has stopped changing.
    private func fitWindowToPet() {
        settleTimer = nil
        guard let view = panel.contentView, panel.frame.width != size else { return }
        let old = panel.frame
        var origin = NSPoint(x: old.midX - size / 2, y: old.midY - size / 2)
        // A pet that grew past the edge of its screen is pulled back in.
        if let visible = (panel.screen ?? NSScreen.main)?.visibleFrame {
            origin.x = min(max(origin.x, visible.minX), max(visible.minX, visible.maxX - size))
            origin.y = min(max(origin.y, visible.minY), max(visible.minY, visible.maxY - size))
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        panel.setFrame(NSRect(x: origin.x, y: origin.y, width: size, height: size), display: false)
        player.layout(in: view.bounds, edge: size, scale: panel.backingScaleFactor)
        CATransaction.commit()
        saveOrigin()
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
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let x = number(object["x"]),
           let y = number(object["y"]) {
            return clampToScreen(NSPoint(x: x, y: y))
        }
        return defaultOrigin()
    }

    private func defaultOrigin() -> NSPoint {
        let frame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        return NSPoint(x: frame.maxX - size - 24, y: frame.minY + 200)
    }

    private func clampToScreen(_ point: NSPoint) -> NSPoint {
        let rect = NSRect(origin: point, size: NSSize(width: size, height: size))
        if NSScreen.screens.contains(where: { $0.visibleFrame.intersects(rect) }) {
            return point
        }
        return defaultOrigin()
    }

    private func saveOrigin() {
        guard !statePath.isEmpty else { return }
        let origin = panel.frame.origin
        let object: [String: Double] = ["x": origin.x, "y": origin.y]
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        try? data.write(to: URL(fileURLWithPath: statePath), options: .atomic)
    }

    // -- benchmark ---------------------------------------------------------

    /// Drive the real drag path with a cursor the helper controls: 240 moves
    /// a second for two seconds, while the pet animates as usual. Synthetic
    /// system input is dropped on this machine, so the press itself is
    /// simulated; everything after it is the code a real drag runs.
    private func runDragBenchmark() {
        let start = NSPoint(x: 400, y: 400)
        panel.setFrameOrigin(NSPoint(x: start.x - size / 2, y: start.y - size / 2))
        cursorOverride = start
        beginDrag()
        let began = CACurrentMediaTime()
        var path: Timer?
        path = Timer(timeInterval: 1.0 / 240.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            let elapsed = CACurrentMediaTime() - began
            self.cursorOverride = NSPoint(x: start.x + elapsed * 480, y: start.y)
            self.continueDrag()
            guard elapsed >= 2 else { return }
            path?.invalidate()
            let block = self.worstBlock
            self.endDrag()
            print("drag bench: mover=helper moves=\(self.windowMoves) "
                  + "moveCostMs=\(Int(self.moveCost * 1000)) "
                  + "worstMoveGapMs=\(String(format: "%.1f", self.worstMoveGap)) "
                  + "mainThreadWorstBlockMs=\(String(format: "%.1f", block)) "
                  + "moved=\(self.drag.moved)")
            NSApp.terminate(nil)
        }
        if let path { RunLoop.main.add(path, forMode: .common) }
    }
}

signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }

let application = NSApplication.shared
let controller = PetController()
application.delegate = controller
application.run()
