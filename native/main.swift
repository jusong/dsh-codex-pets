import AppKit
import Carbon
import Darwin
import ImageIO
import QuartzCore

/**
 * dsh-codex-pets: a tiny macOS helper that owns the always-on-top pet window.
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

        // Start from the Codex contract, then let the manifest override any
        // named row. A pet that only customises `jumping` must still keep
        // `running-right` / `running-left` for drag.
        var animations: [String: PetAnimation] = [:]
        for (row, spec) in CodexContract.animations.enumerated() {
            animations[spec.name] = PetAnimation(name: spec.name, row: row, durations: spec.durations)
        }
        for (name, raw) in (object["animations"] as? [String: Any]) ?? [:] {
            guard let spec = raw as? [String: Any] else { continue }
            let durations = ((spec["durations"] as? [Any]) ?? []).compactMap(number)
            let row = Int(number(spec["row"]) ?? Double(animations[name]?.row ?? 0))
            animations[name] = PetAnimation(name: name, row: row, durations: durations.isEmpty ? (animations[name]?.durations ?? []) : durations)
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
    /// Keep the pet in its running row while a listed session is working.
    private var workRunning = false
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
            resumeAfterOneShot()
            return
        }
        animation = active
        // The idle rows barely move on their own, so every few seconds the
        // pet takes a short turn at another row. Skip that while a session
        // is keeping the pet in its running row.
        if !workRunning, active.animation.name == manifest.idle {
            idleElapsed += delta
            if idleElapsed >= idleWait {
                idleElapsed = 0
                idleWait = pickIdleWait()
                playIdleAction()
            }
        }
        draw()
    }

    /// The gait used while work is in progress: the same row as dragging right.
    private var workAnimationName: String {
        if manifest.animations[manifest.dragRight] != nil { return manifest.dragRight }
        if manifest.animations["running"] != nil { return "running" }
        return manifest.idle
    }

    private var jumpAnimationName: String {
        if manifest.animations["jumping"] != nil { return "jumping" }
        return manifest.reactName
    }

    private func resumeAfterOneShot() {
        if workRunning { play(workAnimationName, loop: true) }
        else { play(manifest.idle, loop: true) }
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
                resumeAfterOneShot()
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
            resumeAfterOneShot()
            return
        }
        reacting = true
        play(manifest.reactName, loop: false)
    }

    /// Drop the show, the reaction and the gaze, and stand still.
    func interrupt() {
        stopAll()
        lookFrame = nil
        resumeAfterOneShot()
    }

    /// Stay in the drag-right gait while sessions are working.
    func setWorkRunning(_ on: Bool) {
        workRunning = on
        if on { lookFrame = nil }
        guard dragAnimation == nil, sequence == nil else { return }
        if on {
            if animation?.animation.name != workAnimationName {
                play(workAnimationName, loop: true)
            } else {
                draw()
            }
        } else if animation?.animation.name == workAnimationName {
            play(manifest.idle, loop: true)
        }
    }

    /// Jump a few times when a listed session finishes, then resume work or idle.
    func celebrateJumps(_ count: Int = 3) {
        guard !reducedMotion else { return }
        let name = jumpAnimationName
        guard let spec = manifest.animations[name], count > 0 else { return }
        lookFrame = nil
        reacting = false
        dragAnimation = nil
        sequence = Sequence(plan: Array(repeating: spec, count: count))
        playStep()
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
            applyState(animation?.animation.name ?? (workRunning ? workAnimationName : manifest.idle))
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
        resumeAfterOneShot()
    }

    /// Look in a direction: 0 degrees is straight up, growing clockwise.
    func look(degrees: Double) {
        // A working pet is already mid-stride; staring would replace the gait.
        guard !workRunning else { return }
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

    /// A show beats a drag, a drag beats a reaction, work-running beats the
    /// gaze (same idea as a drag: the body is moving), a reaction beats the
    /// gaze, and the gaze beats a quiet idle animation.
    private func draw() {
        if sequence != nil, let active = animation { return show(active.animation.row, active.frame) }
        if let drag = dragAnimation { return show(drag.animation.row, drag.frame) }
        if reacting, let active = animation { return show(active.animation.row, active.frame) }
        if workRunning, let active = animation { return show(active.animation.row, active.frame) }
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

/// The name the pet shows for a workspace. The host stores `default-workspace`;
/// the Mac's language decides whether that reads as 默认工作区.
func petWorkspaceLabel(_ title: String) -> String {
    guard title == "default-workspace" else { return title }
    let chinese = Locale.preferredLanguages.first?.hasPrefix("zh") ?? false
    return chinese ? "默认工作区" : "Default workspace"
}

/**
 * The count under the pet, and the session list it opens.
 *
 * It only takes clicks that land on the ball or a row. Everywhere else the
 * click falls through to the pet, which is what starts a drag.
 */
final class SessionChrome: NSView {
    static let badge: CGFloat = 36
    static let listWidth: CGFloat = 300
    static let rowHeight: CGFloat = 48

    struct Item {
        let id: String
        let title: String
        let status: String
        let workspace: String
    }

    var onToggle: (() -> Void)?
    var onOpen: ((String) -> Void)?

    private var items: [Item] = []
    private var expanded = false
    private var badgeFrame = CGRect.zero
    private var listFrame = CGRect.zero
    private var hoveredIndex: Int?
    /// Skips rebuilding the rows when nothing in them changed, so a running
    /// session's spinner is not restarted on every layout.
    private var renderedSignature = ""
    private var tracking: NSTrackingArea?
    private let badgeLayer = CALayer()
    private let countLayer = CATextLayer()
    private let chevron = CAShapeLayer()
    /// Soft halo plus a light that travels the ball's edge while work is in progress.
    private let activityHost = CALayer()
    private let activityGlow = CAShapeLayer()
    /// Stays still so a wide pill does not tumble. The gradient inside it turns.
    private let sweepHost = CALayer()
    private let activitySweep = CAGradientLayer()
    private let activityMask = CAShapeLayer()
    private let listLayer = CALayer()

    private static let activityHue = NSColor(calibratedRed: 0.23, green: 0.48, blue: 1, alpha: 1)

    /// `1/5` is one session still working out of five. Once none are working, just `5`.
    private func progressLabel() -> String {
        let total = items.count
        guard total > 0 else { return "" }
        let running = items.reduce(0) { $0 + ($1.status == "running" ? 1 : 0) }
        if running == 0 { return "\(total)" }
        return "\(running)/\(total)"
    }

    private func rowIndex(at local: NSPoint) -> Int? {
        guard expanded, listFrame.contains(local) else { return nil }
        let index = Int((listFrame.maxY - local.y) / Self.rowHeight)
        guard index >= 0, index < items.count else { return nil }
        return index
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.masksToBounds = false
        badgeLayer.backgroundColor = NSColor.white.cgColor
        badgeLayer.shadowColor = NSColor.black.cgColor
        badgeLayer.shadowOpacity = 0.16
        badgeLayer.shadowRadius = 8
        badgeLayer.shadowOffset = CGSize(width: 0, height: 1)
        countLayer.alignmentMode = .center
        countLayer.truncationMode = .end
        countLayer.isWrapped = false
        countLayer.foregroundColor = NSColor(white: 0.32, alpha: 1).cgColor
        countLayer.font = NSFont.systemFont(ofSize: 14, weight: .medium)
        countLayer.fontSize = 14
        let hue = Self.activityHue
        activityGlow.fillColor = nil
        activityGlow.strokeColor = hue.withAlphaComponent(0.45).cgColor
        activityGlow.lineWidth = 4
        activityGlow.lineCap = .round
        activitySweep.type = .conic
        activitySweep.startPoint = CGPoint(x: 0.5, y: 0.5)
        activitySweep.endPoint = CGPoint(x: 0.5, y: 0)
        activitySweep.colors = [
            hue.withAlphaComponent(0).cgColor,
            hue.withAlphaComponent(0.08).cgColor,
            hue.withAlphaComponent(0.55).cgColor,
            hue.cgColor,
        ]
        activitySweep.locations = [0, 0.2, 0.72, 1]
        activityMask.fillColor = nil
        activityMask.strokeColor = NSColor.white.cgColor
        activityMask.lineWidth = 2.25
        activityMask.lineCap = .round
        sweepHost.mask = activityMask
        sweepHost.addSublayer(activitySweep)
        activityHost.isHidden = true
        activityHost.addSublayer(activityGlow)
        activityHost.addSublayer(sweepHost)
        badgeLayer.addSublayer(activityHost)
        badgeLayer.addSublayer(countLayer)
        chevron.strokeColor = NSColor(white: 0.32, alpha: 1).cgColor
        chevron.fillColor = nil
        chevron.lineWidth = 1.8
        chevron.lineCap = .round
        chevron.lineJoin = .round
        chevron.isHidden = true
        badgeLayer.addSublayer(chevron)
        listLayer.backgroundColor = NSColor.white.cgColor
        listLayer.shadowColor = NSColor.black.cgColor
        listLayer.shadowOpacity = 0.14
        listLayer.shadowRadius = 16
        listLayer.shadowOffset = CGSize(width: 0, height: 2)
        listLayer.isHidden = true
        layer?.addSublayer(listLayer)
        layer?.addSublayer(badgeLayer)
    }

    required init?(coder: NSCoder) { nil }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }

    func render(items: [Item], expanded: Bool, scale: CGFloat) {
        self.items = items
        self.expanded = expanded
        if let hoveredIndex, hoveredIndex >= items.count { self.hoveredIndex = nil }
        let bounds = self.bounds
        let signature = "\(Int(bounds.width))x\(Int(bounds.height))|\(expanded)|\(Int(scale * 10))|"
            + items.map { "\($0.id)\u{1}\($0.status)\u{1}\($0.title)\u{1}\($0.workspace)" }.joined(separator: "\u{2}")
        if signature == renderedSignature { return }
        renderedSignature = signature
        let chinese = Locale.preferredLanguages.first?.hasPrefix("zh") == true
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        var spinners: [CAShapeLayer] = []
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let badge = Self.badge
        // `1/5` is wider than the circle, so the ball grows into a pill.
        // A finished list is one number and stays a circle.
        let label = expanded ? "" : progressLabel()
        let fontSize: CGFloat = label.contains("/") ? 13 : 15
        let font = NSFont.monospacedDigitSystemFont(ofSize: fontSize, weight: .semibold)
        let textWidth = label.isEmpty ? badge : ceil((label as NSString).size(withAttributes: [.font: font]).width)
        let badgeW = max(badge, textWidth + 16)
        // The chrome view is the strip under the pet, so the ball sits at its top.
        badgeFrame = CGRect(x: bounds.midX - badgeW / 2, y: bounds.height - 6 - badge, width: badgeW, height: badge)
        badgeLayer.frame = badgeFrame
        badgeLayer.cornerRadius = badge / 2
        countLayer.contentsScale = scale
        countLayer.font = font
        countLayer.fontSize = fontSize
        countLayer.frame = CGRect(x: 0, y: (badge - 18) / 2, width: badgeW, height: 18)
        countLayer.string = label
        chevron.isHidden = !expanded
        chevron.frame = badgeLayer.bounds
        let mark = CGMutablePath()
        let mid = badgeW / 2
        mark.move(to: CGPoint(x: mid - 6, y: 15))
        mark.addLine(to: CGPoint(x: mid, y: 21))
        mark.addLine(to: CGPoint(x: mid + 6, y: 15))
        chevron.path = mark

        listLayer.sublayers?.forEach { $0.removeFromSuperlayer() }
        listLayer.isHidden = !expanded || items.isEmpty
        listFrame = .zero
        if expanded && !items.isEmpty {
            let listW = min(Self.listWidth, bounds.width - 16)
            let listH = Self.rowHeight * CGFloat(items.count)
            listFrame = CGRect(x: bounds.midX - listW / 2, y: badgeFrame.minY - 8 - listH, width: listW, height: listH)
            listLayer.frame = listFrame
            listLayer.cornerRadius = items.count == 1 ? min(24, listH / 2) : 18
            let textX: CGFloat = 36
            for (index, item) in items.enumerated() {
                let row = CALayer()
                let inset: CGFloat = 4
                row.frame = CGRect(
                    x: inset,
                    y: listH - Self.rowHeight * CGFloat(index + 1) + inset / 2,
                    width: listW - inset * 2,
                    height: Self.rowHeight - inset
                )
                row.cornerRadius = 10
                row.backgroundColor = index == hoveredIndex
                    ? NSColor(white: 0.93, alpha: 1).cgColor
                    : NSColor.clear.cgColor
                let running = item.status == "running"
                let slot = CGRect(x: 10, y: (row.bounds.height - 14) / 2, width: 14, height: 14)
                if running {
                    spinners.append(Self.spinner(in: slot, scale: scale, onto: row))
                } else {
                    let dot = CALayer()
                    let dotSize: CGFloat = 8
                    dot.frame = CGRect(
                        x: slot.midX - dotSize / 2,
                        y: slot.midY - dotSize / 2,
                        width: dotSize,
                        height: dotSize
                    )
                    dot.cornerRadius = dotSize / 2
                    dot.backgroundColor = NSColor.systemGreen.cgColor
                    row.addSublayer(dot)
                }
                let title = CATextLayer()
                title.contentsScale = scale
                title.frame = CGRect(x: textX, y: 22, width: row.bounds.width - textX - 12, height: 18)
                title.font = NSFont.systemFont(ofSize: 14, weight: .semibold)
                title.fontSize = 14
                title.foregroundColor = NSColor(white: 0.1, alpha: 1).cgColor
                title.truncationMode = .end
                title.string = item.title.isEmpty ? (chinese ? "未命名会话" : "Untitled") : item.title
                let status = CATextLayer()
                status.contentsScale = scale
                status.frame = CGRect(x: textX, y: 5, width: row.bounds.width - textX - 12, height: 16)
                status.font = NSFont.systemFont(ofSize: 12, weight: .regular)
                status.fontSize = 12
                status.foregroundColor = NSColor(white: 0.5, alpha: 1).cgColor
                status.truncationMode = .end
                let state = running ? (chinese ? "正在思考" : "Thinking") : (chinese ? "已完成" : "Done")
                let place = petWorkspaceLabel(item.workspace)
                status.string = place.isEmpty ? state : "\(state) · \(place)"
                row.addSublayer(title)
                row.addSublayer(status)
                listLayer.addSublayer(row)
            }
        }
        CATransaction.commit()
        if !reduceMotion {
            for spinner in spinners {
                let spin = CABasicAnimation(keyPath: "transform.rotation.z")
                spin.fromValue = 0
                spin.toValue = CGFloat.pi * 2
                spin.duration = 1.15
                spin.repeatCount = .infinity
                spin.timingFunction = CAMediaTimingFunction(name: .linear)
                spinner.add(spin, forKey: "spin")
            }
        }
        syncActivityRing(reduceMotion: reduceMotion)
        installTracking()
    }

    /// A soft halo, and a light that travels the ball's edge, while any session is working.
    /// A finished list leaves the ball still. Reduced motion keeps the halo, without the sweep.
    private func syncActivityRing(reduceMotion: Bool) {
        let busy = items.contains { $0.status == "running" }
        guard busy else {
            activityHost.isHidden = true
            activityGlow.removeAnimation(forKey: "breathe")
            activitySweep.removeAnimation(forKey: "orbit")
            badgeLayer.removeAnimation(forKey: "lift")
            badgeLayer.shadowColor = NSColor.black.cgColor
            badgeLayer.shadowOpacity = 0.16
            badgeLayer.shadowRadius = 8
            return
        }
        activityHost.isHidden = false
        activityHost.frame = badgeLayer.bounds
        let bounds = activityHost.bounds
        activityGlow.frame = bounds
        sweepHost.frame = bounds
        activityMask.frame = bounds
        // Larger than the ball, so turning the gradient never uncovers the ring.
        let side = hypot(bounds.width, bounds.height)
        activitySweep.bounds = CGRect(x: 0, y: 0, width: side, height: side)
        activitySweep.position = CGPoint(x: bounds.midX, y: bounds.midY)
        let glowRect = bounds.insetBy(dx: 1.25, dy: 1.25)
        let ringRect = bounds.insetBy(dx: 2.75, dy: 2.75)
        activityGlow.path = CGPath(
            roundedRect: glowRect,
            cornerWidth: glowRect.height / 2,
            cornerHeight: glowRect.height / 2,
            transform: nil
        )
        activityMask.path = CGPath(
            roundedRect: ringRect,
            cornerWidth: ringRect.height / 2,
            cornerHeight: ringRect.height / 2,
            transform: nil
        )
        badgeLayer.shadowColor = Self.activityHue.cgColor
        badgeLayer.shadowRadius = 10
        if reduceMotion {
            activitySweep.isHidden = true
            activitySweep.removeAnimation(forKey: "orbit")
            activityGlow.removeAnimation(forKey: "breathe")
            activityGlow.opacity = 0.4
            badgeLayer.removeAnimation(forKey: "lift")
            badgeLayer.shadowOpacity = 0.28
            return
        }
        activitySweep.isHidden = false
        if activitySweep.animation(forKey: "orbit") == nil {
            let orbit = CABasicAnimation(keyPath: "transform.rotation.z")
            orbit.fromValue = 0
            orbit.toValue = CGFloat.pi * 2
            orbit.duration = 1.8
            orbit.repeatCount = .infinity
            orbit.timingFunction = CAMediaTimingFunction(name: .linear)
            activitySweep.add(orbit, forKey: "orbit")
        }
        if activityGlow.animation(forKey: "breathe") == nil {
            let breathe = CABasicAnimation(keyPath: "opacity")
            breathe.fromValue = 0.2
            breathe.toValue = 0.7
            breathe.duration = 1.4
            breathe.autoreverses = true
            breathe.repeatCount = .infinity
            breathe.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            activityGlow.add(breathe, forKey: "breathe")
        }
        if badgeLayer.animation(forKey: "lift") == nil {
            let lift = CABasicAnimation(keyPath: "shadowOpacity")
            lift.fromValue = 0.16
            lift.toValue = 0.45
            lift.duration = 1.4
            lift.autoreverses = true
            lift.repeatCount = .infinity
            lift.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            badgeLayer.add(lift, forKey: "lift")
        }
    }

    /// A faint track and a glowing arc. The arc turns while the agent is working.
    private static func spinner(in slot: CGRect, scale: CGFloat, onto row: CALayer) -> CAShapeLayer {
        let center = CGPoint(x: slot.width / 2, y: slot.height / 2)
        let track = CAShapeLayer()
        track.frame = slot
        track.contentsScale = scale
        track.path = CGPath(ellipseIn: CGRect(x: center.x - 5.5, y: center.y - 5.5, width: 11, height: 11), transform: nil)
        track.fillColor = nil
        track.strokeColor = NSColor(white: 0.86, alpha: 1).cgColor
        track.lineWidth = 1.75
        row.addSublayer(track)

        let spinner = CAShapeLayer()
        spinner.frame = slot
        spinner.contentsScale = scale
        let path = CGMutablePath()
        path.addArc(center: center, radius: 5.5, startAngle: -.pi / 2, endAngle: .pi, clockwise: false)
        spinner.path = path
        spinner.fillColor = nil
        spinner.strokeColor = activityHue.cgColor
        spinner.lineWidth = 1.75
        spinner.lineCap = .round
        spinner.shadowColor = activityHue.cgColor
        spinner.shadowRadius = 2
        spinner.shadowOpacity = 0.85
        spinner.shadowOffset = .zero
        row.addSublayer(spinner)
        return spinner
    }

    /// The list is gone, so drop the hover tracking it installed.
    func dismiss() {
        activityHost.isHidden = true
        activityGlow.removeAnimation(forKey: "breathe")
        activitySweep.removeAnimation(forKey: "orbit")
        badgeLayer.removeAnimation(forKey: "lift")
        if tracking == nil && hoveredIndex == nil && renderedSignature.isEmpty { return }
        let restoreCursor = hoveredIndex != nil
        renderedSignature = ""
        hoveredIndex = nil
        if let tracking { removeTrackingArea(tracking) }
        tracking = nil
        if restoreCursor { NSCursor.arrow.set() }
    }

    private func installTracking() {
        let wasTracking = tracking != nil
        if let tracking { removeTrackingArea(tracking) }
        self.tracking = nil
        guard expanded, listFrame.width > 0, listFrame.height > 0 else {
            hoveredIndex = nil
            if wasTracking { NSCursor.arrow.set() }
            return
        }
        let area = NSTrackingArea(
            rect: listFrame,
            options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
        tracking = area
    }

    private func applyHover() {
        guard let rows = listLayer.sublayers else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for (index, row) in rows.enumerated() {
            row.backgroundColor = index == hoveredIndex
                ? NSColor(white: 0.93, alpha: 1).cgColor
                : NSColor.clear.cgColor
        }
        CATransaction.commit()
        if hoveredIndex == nil { NSCursor.arrow.set() }
        else { NSCursor.pointingHand.set() }
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        if badgeFrame.contains(local) { return self }
        if expanded && listFrame.contains(local) { return self }
        return nil
    }

    override func mouseMoved(with event: NSEvent) {
        let index = rowIndex(at: convert(event.locationInWindow, from: nil))
        guard index != hoveredIndex else { return }
        hoveredIndex = index
        applyHover()
    }

    override func mouseExited(with event: NSEvent) {
        guard hoveredIndex != nil else { return }
        hoveredIndex = nil
        applyHover()
    }

    override func mouseDown(with event: NSEvent) {
        let local = convert(event.locationInWindow, from: nil)
        if badgeFrame.contains(local) {
            onToggle?()
            return
        }
        guard let index = rowIndex(at: local) else { return }
        onOpen?(items[index].id)
    }
}

/// Borderless, but it still takes the keyboard while the question is open.
final class AskPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// The question field. Escape closes the dialog without starting a session.
final class AskField: NSTextField {
    var onCancel: (() -> Void)?

    override func cancelOperation(_ sender: Any?) {
        onCancel?()
    }
}

/// Resigning the question card closes it, except while its workspace menu is open.
final class AskWindowDelegate: NSObject, NSWindowDelegate {
    var onResign: (() -> Void)?

    func windowDidResignKey(_ notification: Notification) {
        onResign?()
    }
}

/// A blue circle with an up arrow. Faded while the question is empty.
final class SendButton: NSButton {
    override init(frame: NSRect) {
        super.init(frame: frame)
        isBordered = false
        wantsLayer = true
        layer?.backgroundColor = NSColor.systemBlue.cgColor
        layer?.cornerRadius = frame.height / 2
        image = NSImage(systemSymbolName: "arrow.up", accessibilityDescription: "提交")?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 12, weight: .bold))
        imagePosition = .imageOnly
        contentTintColor = .white
    }

    required init?(coder: NSCoder) { nil }

    override func layout() {
        super.layout()
        layer?.cornerRadius = bounds.height / 2
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
    override func rightMouseDown(with event: NSEvent) { controller?.showMenu(with: event) }
}

final class PetController: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    private var panel: NSPanel!
    private var player: SpritePlayer!
    private var chrome: SessionChrome!
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
    private var shortcutValue = "Command+Option+N"
    private var hotKey: EventHotKeyRef?
    private var hotKeyHandler: EventHandlerRef?

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
            NSLog("dsh-codex-pets: no usable pet manifest in \(petDir), exiting")
            NSApp.terminate(nil)
            return
        }
        guard let player = SpritePlayer(
            manifest: manifest,
            reducedMotion: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        ) else {
            NSLog("dsh-codex-pets: cannot read the atlas at \(manifest.atlasURL.path), exiting")
            NSApp.terminate(nil)
            return
        }
        self.player = player
        createPanel()
        setShortcut(shortcutValue)
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
            case "--shortcut": shortcutValue = iterator.next() ?? ""
            case "--perform-now": performNow = true
            case "--drag-bench": dragBench = true
            case "--describe": describe = true
            // The host still passes the web runtime; the helper no longer
            // needs it.
            case "--runtime": _ = iterator.next()
            default: break
            }
        }
        size = min(Self.maxEdge, max(Self.minEdge, size))
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
        panel.acceptsMouseMovedEvents = true

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
        chrome = SessionChrome(frame: .zero)
        chrome.onToggle = { [weak self] in
            guard let self else { return }
            self.sessionsExpanded.toggle()
            if self.glideTimer == nil { self.relayoutSettled() }
        }
        chrome.onOpen = { [weak self] id in
            guard let self else { return }
            self.sessionsExpanded = false
            if self.glideTimer == nil { self.relayoutSettled() }
            FileHandle.standardOutput.write(Data("open \(id)\n".utf8))
        }
        view.addSubview(chrome)
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
        let slot = petSlot(in: NSRect(origin: .zero, size: frame.size), edge: shownEdge)
        let dx = (mouse.x - frame.minX) - slot.midX
        let eyeFromTop = (frame.height - slot.maxY) + slot.height * 0.42
        let dy = (frame.height - (mouse.y - frame.minY)) - eyeFromTop
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
            FileHandle.standardOutput.write(Data("activate\n".utf8))
            player.react()
        }
        writeDragLog(byServer: byServer)
    }

    /// The pet has no title bar, so its right-click menu is the way to a new
    /// session, its settings, and off the screen.
    func showMenu(with event: NSEvent) {
        guard let view = panel.contentView else { return }
        let chinese = Locale.preferredLanguages.first?.hasPrefix("zh") ?? false
        let menu = NSMenu()
        let ask = NSMenuItem(title: chinese ? "新会话" : "New Session", action: nil, keyEquivalent: "")
        ask.image = NSImage(systemSymbolName: "plus.bubble", accessibilityDescription: nil)
        ask.submenu = workspaceMenu(chinese: chinese)
        menu.addItem(ask)
        let settings = NSMenuItem(
            title: chinese ? "设置" : "Settings",
            action: #selector(openSettingsPage),
            keyEquivalent: ""
        )
        settings.target = self
        settings.image = NSImage(systemSymbolName: "gearshape", accessibilityDescription: nil)
        menu.addItem(settings)
        let hide = NSMenuItem(
            title: chinese ? "隐藏宠物" : "Hide Pet",
            action: #selector(hidePet),
            keyEquivalent: ""
        )
        hide.target = self
        hide.image = NSImage(systemSymbolName: "eye.slash", accessibilityDescription: nil)
        menu.addItem(hide)
        NSMenu.popUpContextMenu(menu, with: event, for: view)
    }

    /// Hovering「新会话」opens this. One row per workspace the host last sent.
    private func workspaceMenu(chinese: Bool) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        if workspaceItems.isEmpty {
            let empty = NSMenuItem(title: chinese ? "没有工作区" : "No workspaces", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
            return menu
        }
        for item in workspaceItems {
            let row = NSMenuItem(
                title: workspaceLabel(item.title.isEmpty ? item.id : item.title),
                action: #selector(askInWorkspace(_:)),
                keyEquivalent: ""
            )
            row.target = self
            row.representedObject = item.id
            menu.addItem(row)
        }
        return menu
    }

    /// DSH stores the first workspace as the directory name `default-workspace`
    /// and shows that one row as the localized default.
    private func workspaceLabel(_ title: String) -> String {
        petWorkspaceLabel(title)
    }

    private func workspaceChoices() -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        for item in workspaceItems {
            let title = workspaceLabel(item.title.isEmpty ? item.id : item.title)
            let row = NSMenuItem(title: title, action: #selector(pickWorkspace(_:)), keyEquivalent: "")
            row.target = self
            row.representedObject = item.id
            row.state = item.id == askWorkspaceId ? .on : .off
            menu.addItem(row)
        }
        return menu
    }

    @objc private func askInWorkspace(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, !id.isEmpty else { return }
        showAskDialog(workspaceId: id, title: sender.title)
    }

    fileprivate func openDefaultAskDialog() {
        guard let item = workspaceItems.first(where: { $0.title == "default-workspace" })
                ?? workspaceItems.first else { return }
        showAskDialog(
            workspaceId: item.id,
            title: workspaceLabel(item.title.isEmpty ? item.id : item.title)
        )
    }

    private func setShortcut(_ value: String) {
        if let hotKey {
            UnregisterEventHotKey(hotKey)
            self.hotKey = nil
        }
        guard let shortcut = parseGlobalShortcut(value) else { return }
        if hotKeyHandler == nil {
            var event = EventTypeSpec(
                eventClass: OSType(kEventClassKeyboard),
                eventKind: UInt32(kEventHotKeyPressed)
            )
            InstallEventHandler(
                GetApplicationEventTarget(),
                petShortcutHandler,
                1,
                &event,
                nil as UnsafeMutableRawPointer?,
                &hotKeyHandler
            )
        }
        var modifiers: UInt32 = 0
        if shortcut.command { modifiers |= UInt32(cmdKey) }
        if shortcut.option { modifiers |= UInt32(optionKey) }
        if shortcut.control { modifiers |= UInt32(controlKey) }
        if shortcut.shift { modifiers |= UInt32(shiftKey) }
        let identifier = EventHotKeyID(signature: 0x44534850, id: 1) // DSHP
        RegisterEventHotKey(
            shortcut.keyCode,
            modifiers,
            identifier,
            GetApplicationEventTarget(),
            0,
            &hotKey
        )
    }

    /// A borderless question card. Return or the blue arrow submits; clicking
    /// the workspace name switches it without leaving the card.
    private func showAskDialog(workspaceId: String, title: String) {
        askWorkspaceId = workspaceId
        let window = ensureAskPanel()
        setChipTitle(title)
        askField?.stringValue = ""
        updateSendButton()
        let visible = (panel.screen ?? NSScreen.main)?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 10_000, height: 10_000)
        let origin = askDialogOrigin(pet: petFrameOnScreen(), dialog: window.frame.size, visible: visible)
        window.setFrameOrigin(origin)
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        if let field = askField { window.makeFirstResponder(field) }
    }

    private func ensureAskPanel() -> AskPanel {
        if let askPanel { return askPanel }
        let chinese = Locale.preferredLanguages.first?.hasPrefix("zh") ?? false
        let window = AskPanel(
            contentRect: NSRect(x: 0, y: 0, width: 360, height: 72),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.level = panel.level
        window.isFloatingPanel = true
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.hidesOnDeactivate = false
        window.isReleasedWhenClosed = false
        window.becomesKeyOnlyIfNeeded = false
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        askWindowDelegate.onResign = { [weak self] in
            guard let self, !self.workspaceMenuOpen else { return }
            self.cancelAsk()
        }
        window.delegate = askWindowDelegate
        guard let content = window.contentView else { return window }
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        content.layer?.cornerRadius = 16
        content.layer?.masksToBounds = true
        content.layer?.borderWidth = 1
        content.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.55).cgColor

        let field = AskField(frame: NSRect(x: 16, y: 34, width: 292, height: 24))
        field.placeholderString = chinese ? "输入问题" : "Ask something"
        field.font = .systemFont(ofSize: 14)
        field.isBordered = false
        field.isBezeled = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.cell?.isScrollable = true
        field.cell?.wraps = false
        field.target = self
        field.delegate = self
        field.action = #selector(submitAsk)
        field.onCancel = { [weak self] in self?.cancelAsk() }

        let chip = NSButton(frame: NSRect(x: 14, y: 10, width: 80, height: 20))
        chip.isBordered = false
        chip.imagePosition = .imageTrailing
        chip.image = NSImage(systemSymbolName: "chevron.down", accessibilityDescription: nil)?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 9, weight: .semibold))
        chip.imageScaling = .scaleNone
        chip.target = self
        chip.action = #selector(switchWorkspace(_:))
        chip.lineBreakMode = .byTruncatingTail
        chip.alignment = .left
        chip.contentTintColor = .secondaryLabelColor

        let send = SendButton(frame: NSRect(x: 316, y: 22, width: 28, height: 28))
        send.target = self
        send.action = #selector(submitAsk)

        content.addSubview(field)
        content.addSubview(chip)
        content.addSubview(send)
        askField = field
        askChip = chip
        askSend = send
        askPanel = window
        return window
    }

    private func setChipTitle(_ title: String) {
        let text = NSAttributedString(string: title, attributes: [
            .font: NSFont.systemFont(ofSize: 13),
            .foregroundColor: NSColor.secondaryLabelColor,
        ])
        askChip?.attributedTitle = text
        askChip?.sizeToFit()
        guard let chip = askChip else { return }
        var frame = chip.frame
        frame.size.width = min(max(frame.width, 24), 280)
        frame.size.height = 20
        frame.origin = NSPoint(x: 14, y: 10)
        chip.frame = frame
    }

    private func updateSendButton() {
        let text = askField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        askSend?.alphaValue = text.isEmpty ? 0.35 : 1
    }

    func controlTextDidChange(_ obj: Notification) {
        guard (obj.object as? NSTextField) === askField else { return }
        updateSendButton()
    }

    @objc private func switchWorkspace(_ sender: NSButton) {
        guard !workspaceItems.isEmpty else { return }
        pickedWorkspace = false
        workspaceMenuOpen = true
        let menu = workspaceChoices()
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height + 6), in: sender)
        let stay = pickedWorkspace || askPanel?.frame.contains(NSEvent.mouseLocation) == true
        if stay {
            askPanel?.makeKey()
            if let field = askField { askPanel?.makeFirstResponder(field) }
        }
        workspaceMenuOpen = false
        if !stay { cancelAsk() }
    }

    @objc private func pickWorkspace(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, !id.isEmpty else { return }
        pickedWorkspace = true
        askWorkspaceId = id
        setChipTitle(sender.title)
    }

    @objc private func submitAsk() {
        guard let id = askWorkspaceId,
              let text = askField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty else { return }
        let object = ["workspaceId": id, "text": text]
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        cancelAsk()
        var line = Data("ask ".utf8)
        line.append(data)
        line.append(0x0A)
        FileHandle.standardOutput.write(line)
    }

    @objc private func cancelAsk() {
        guard !closingAsk, askPanel?.isVisible == true else { return }
        closingAsk = true
        askWorkspaceId = nil
        askField?.stringValue = ""
        askPanel?.orderOut(nil)
        closingAsk = false
    }

    /// Bring DSH forward and let the page open Settings at this plugin's page.
    /// The settings line is not waiting on activation: that completion does not
    /// always run when DSH is already open, and then the page never hears it.
    @objc private func openSettingsPage() {
        activateDSH()
        FileHandle.standardOutput.write(Data("settings\n".utf8))
    }

    @objc private func hidePet() {
        // The host writes `visible: false` and stops the helper; asking for
        // it here keeps the settings switch in step.
        FileHandle.standardOutput.write(Data("hide\n".utf8))
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

    private func activateDSH(done: (() -> Void)? = nil) {
        let finish = {
            if let done { DispatchQueue.main.async(execute: done) }
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        configuration.addsToRecentItems = false
        let url = URL(fileURLWithPath: "/Applications/DeepSeek Harness.app")
        guard FileManager.default.fileExists(atPath: url.path) else {
            finish()
            return
        }
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, _ in
            app?.unhide()
            app?.activate(options: [.activateAllWindows])
            finish()
        }
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
        let handle = FileHandle.standardInput
        let fd = handle.fileDescriptor
        let flags = fcntl(fd, F_GETFL)
        // A blocking read in this handler waits until the host closes the
        // pipe, so a short line never comes back and the ball stays off.
        // Non-blocking: take whatever is already there, and keep listening.
        _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
        handle.readabilityHandler = { [weak self] handle in
            var buffer = [UInt8](repeating: 0, count: 65_536)
            let count = read(handle.fileDescriptor, &buffer, buffer.count)
            if count == 0 {
                handle.readabilityHandler = nil
                return
            }
            guard count > 0 else { return }
            pending.append(buffer, count: count)
            while let newline = pending.firstIndex(of: 0x0A) {
                let line = String(decoding: pending[pending.startIndex..<newline], as: UTF8.self)
                pending.removeSubrange(pending.startIndex...newline)
                DispatchQueue.main.async { self?.handleCommand(line) }
            }
        }
    }

    private static let maxEdge: CGFloat = 260
    private static let minEdge: CGFloat = 80
    /// How long the slider has to rest before the window is fitted to the pet.
    private static let settleDelay: TimeInterval = 0.25
    private var settleTimer: Timer?
    /// The size the pet is drawn at this frame, on its way to `size`.
    private var shownEdge: CGFloat = 0
    /// What the ball is listing. Empty means the ball is not drawn.
    private var sessionItems: [SessionChrome.Item] = []
    /// Workspaces the new-session menu can start in, in the host's order.
    private var workspaceItems: [(id: String, title: String)] = []
    private var askPanel: AskPanel?
    private var askField: AskField?
    private var askChip: NSButton?
    private var askSend: SendButton?
    private var askWorkspaceId: String?
    /// The workspace menu is a separate window, so opening it resigns the dialog.
    private var workspaceMenuOpen = false
    private var pickedWorkspace = false
    private var closingAsk = false
    private let askWindowDelegate = AskWindowDelegate()
    private var sessionsExpanded = false
    /// The settings switch that draws the ball under the pet.
    private var sessionChromeOn = false
    /// The settings switch that puts the pet in running while work is on.
    private var sessionMotionOn = false
    /// Session ids that were running last time the host sent a list.
    private var previouslyRunning: Set<String> = []
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

        if chromeHeight() == 0 {
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
        } else {
            let room = windowSize(forPetEdge: Self.maxEdge)
            if panel.frame.width < room.width - 0.5 || panel.frame.height < room.height - 0.5 {
                shownEdge = size
                placeWindow(drawnEdge: shownEdge, reservedEdge: Self.maxEdge)
            }
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
        let slot = chromeHeight() == 0 ? view.bounds : petSlot(in: view.bounds, edge: shownEdge)
        player.layout(in: slot, edge: shownEdge, scale: panel.backingScaleFactor)
        guard shownEdge == size else { return }
        glideTimer?.invalidate()
        glideTimer = nil
        settleTimer = Timer.scheduledTimer(withTimeInterval: Self.settleDelay, repeats: false) { [weak self] _ in
            self?.relayoutSettled()
        }
    }

    /// Shrink the window around the pet once the size has stopped changing.
    ///
    /// With the session ball on, the window is the pet plus the strip under
    /// it, and the pet stays where it was on screen.
    private func relayoutSettled() {
        settleTimer = nil
        guard panel?.contentView != nil else { return }
        placeWindow(drawnEdge: size, reservedEdge: size)
        saveOrigin()
    }

    private func fitWindowToPet() { relayoutSettled() }

    // -- session ball ------------------------------------------------------

    /// How tall the strip under the pet is. Zero when there is nothing to list.
    private func chromeHeight() -> CGFloat {
        guard sessionChromeOn, !sessionItems.isEmpty else { return 0 }
        let topGap: CGFloat = 6
        let bottom: CGFloat = 10
        if !sessionsExpanded { return topGap + SessionChrome.badge + bottom }
        return topGap + SessionChrome.badge + 8 + SessionChrome.rowHeight * CGFloat(sessionItems.count) + bottom
    }

    /// The window's size for a pet of `edge`, including the ball when it is on.
    private func windowSize(forPetEdge edge: CGFloat) -> NSSize {
        let chrome = chromeHeight()
        if chrome == 0 { return NSSize(width: edge, height: edge) }
        return NSSize(width: max(edge, SessionChrome.listWidth + 16), height: edge + chrome)
    }

    /**
     * Where the pet is drawn.
     *
     * With the ball off it is centred, which is what the resize glide uses.
     * With the ball on it is pinned to the top, and the ball hangs below.
     */
    private func petSlot(in bounds: CGRect, edge: CGFloat) -> CGRect {
        if chromeHeight() == 0 {
            return CGRect(x: bounds.midX - edge / 2, y: bounds.midY - edge / 2, width: edge, height: edge)
        }
        return CGRect(x: bounds.midX - edge / 2, y: bounds.maxY - edge, width: edge, height: edge)
    }

    /// The pet's centre in screen points, from where it is drawn right now.
    private func petCenterOnScreen() -> NSPoint {
        let slot = petFrameOnScreen()
        return NSPoint(x: slot.midX, y: slot.midY)
    }

    /// The drawn pet, not the window. The session ball hangs below and must
    /// not push the question card away from the sprite.
    private func petFrameOnScreen() -> NSRect {
        let frame = panel.frame
        let edge = shownEdge > 0 ? shownEdge : size
        let slot = petSlot(in: NSRect(origin: .zero, size: frame.size), edge: edge)
        return NSRect(x: frame.minX + slot.minX, y: frame.minY + slot.minY, width: slot.width, height: slot.height)
    }

    /**
     * Move the window so the pet stays put.
     *
     * `reservedEdge` is how much vertical room the pet is given (the largest
     * size while a resize is gliding, the real size once it has settled).
     * `drawnEdge` is the size it is drawn at inside that room.
     */
    private func placeWindow(drawnEdge: CGFloat, reservedEdge: CGFloat) {
        guard let view = panel.contentView else { return }
        let center = petCenterOnScreen()
        let window = windowSize(forPetEdge: reservedEdge)
        let chrome = chromeHeight()
        let slotY = chrome == 0 ? (window.height - drawnEdge) / 2 : window.height - drawnEdge
        let centerY = slotY + drawnEdge / 2
        var origin = NSPoint(x: center.x - window.width / 2, y: center.y - centerY)
        if let visible = (panel.screen ?? NSScreen.main)?.visibleFrame {
            origin.x = min(max(origin.x, visible.minX), max(visible.minX, visible.maxX - window.width))
            origin.y = min(max(origin.y, visible.minY), max(visible.minY, visible.maxY - window.height))
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        panel.setFrame(NSRect(origin: origin, size: window), display: false)
        shownEdge = drawnEdge
        let slot = petSlot(in: view.bounds, edge: drawnEdge)
        player.layout(in: slot, edge: drawnEdge, scale: panel.backingScaleFactor)
        chromeView(in: view)
        CATransaction.commit()
    }

    private func chromeView(in view: NSView) {
        let height = chromeHeight()
        chrome.frame = NSRect(x: 0, y: 0, width: view.bounds.width, height: height)
        chrome.isHidden = height == 0
        if height > 0 { chrome.render(items: sessionItems, expanded: sessionsExpanded, scale: panel.backingScaleFactor) }
        else { chrome.dismiss() }
    }

    /// One line from the host: `size N`, `motion on|off`, `chrome on|off`,
    /// `sessions` plus a JSON array, or `workspaces` plus a JSON array.
    private func handleCommand(_ line: String) {
        if line == "activate" {
            activateDSH()
            return
        }
        if line.hasPrefix("shortcut ") {
            let raw = String(line.dropFirst("shortcut ".count))
            if let value = shortcutFromWire(raw) {
                shortcutValue = value
                setShortcut(value)
            }
            return
        }
        if line.hasPrefix("size ") {
            if let value = Double(line.dropFirst(5).trimmingCharacters(in: .whitespaces)) {
                resize(to: CGFloat(value))
            }
            return
        }
        if line == "motion on" || line == "motion off" {
            let on = line.hasSuffix(" on")
            sessionMotionOn = on
            if !on {
                previouslyRunning = []
                player.setWorkRunning(false)
            } else {
                applySessionMotion(sessionItems)
            }
            return
        }
        if line == "chrome on" || line == "chrome off" {
            let on = line.hasSuffix(" on")
            guard sessionChromeOn != on else { return }
            sessionChromeOn = on
            if !on { sessionsExpanded = false }
            if glideTimer == nil { relayoutSettled() }
            return
        }
        if line.hasPrefix("workspaces ") {
            let raw = String(line.dropFirst("workspaces ".count))
            guard let data = raw.data(using: .utf8),
                  let rows = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return }
            var next: [(id: String, title: String)] = []
            for row in rows {
                guard let id = row["id"] as? String, !id.isEmpty, id.count <= 200,
                      !id.contains("\n"), !id.contains(" ") else { continue }
                let title = ((row["title"] as? String) ?? "").replacingOccurrences(of: "\n", with: " ")
                next.append((id: id, title: title))
            }
            workspaceItems = next
            return
        }
        guard line.hasPrefix("sessions ") else { return }
        let raw = String(line.dropFirst("sessions ".count))
        guard let data = raw.data(using: .utf8),
              let rows = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return }
        var next: [SessionChrome.Item] = []
        for row in rows {
            guard let id = row["id"] as? String, !id.isEmpty, id.count <= 200,
                  !id.contains("\n"), !id.contains(" ") else { continue }
            next.append(SessionChrome.Item(
                id: id,
                title: (row["title"] as? String) ?? "",
                status: (row["status"] as? String) ?? "idle",
                workspace: (row["workspace"] as? String) ?? ""
            ))
        }
        applySessionMotion(next)
        sessionItems = next
        if next.isEmpty { sessionsExpanded = false }
        if glideTimer == nil { relayoutSettled() }
    }

    /// Put the pet in running while any listed session is working, and jump
    /// three times when one that was working has finished.
    private func applySessionMotion(_ next: [SessionChrome.Item]) {
        guard sessionMotionOn else {
            previouslyRunning = []
            player.setWorkRunning(false)
            return
        }
        let nowRunning = Set(next.filter { $0.status == "running" }.map(\.id))
        let finished = previouslyRunning.subtracting(nowRunning)
        previouslyRunning = nowRunning
        if !finished.isEmpty { player.celebrateJumps(3) }
        player.setWorkRunning(!nowRunning.isEmpty)
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

private weak var shortcutController: PetController?

private func petShortcutHandler(
    _ nextHandler: EventHandlerCallRef?,
    _ event: EventRef?,
    _ userData: UnsafeMutableRawPointer?
) -> OSStatus {
    DispatchQueue.main.async {
        shortcutController?.openDefaultAskDialog()
    }
    return noErr
}

signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }

let application = NSApplication.shared
let controller = PetController()
shortcutController = controller
application.delegate = controller
application.run()
