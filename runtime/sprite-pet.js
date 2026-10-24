/**
 * Sprite pet engine.
 *
 * This is the dsh-pet counterpart of the Codex pet player. A sprite pet is
 * pure data -- a manifest plus a sprite atlas -- and every bit of playback
 * behaviour lives here, so adding a pet never means writing another page.
 *
 * The manifest looks like this:
 *
 *   {
 *     "id": "hoots",
 *     "name": "Hoots",
 *     "size": 200,
 *     "type": "sprite",
 *     "spriteVersionNumber": 2,
 *     "spritesheetPath": "spritesheet.webp",
 *     "cell":   { "width": 192, "height": 208 },
 *     "grid":   { "columns": 8, "rows": 11 },
 *     "animations": {
 *       "idle": { "row": 0, "durations": [280, 110, 110, 140, 140, 320] },
 *       ...
 *     },
 *     "look":   { "rows": [9, 10], "count": 16, "stepDegrees": 22.5 },
 *     "idleRoutine": { "every": [3, 6], "animations": ["waiting", "waving"] },
 *     "perform": { "sequence": ["jumping", "waving"], "splash": "sparkle" }
 *   }
 *
 * Rows are addressed the same way the Codex atlas is: row 0 is the top row,
 * column 0 the leftmost cell. The engine never assumes what a row means --
 * the manifest's animation names do.
 *
 * `idleRoutine` is what keeps the pet alive on its own: the official
 * atlases barely move in their idle row, so the engine takes a short turn
 * at another row every `every` seconds.
 *
 * The atlas is loaded relative to the document's base URL, which the native
 * helper points at the pet's own directory.
 */
(() => {
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value))

  /**
   * A row of frames with individual durations, the same shape the Codex
   * animation tables use: the last frame of a row usually lingers.
   */
  class Timeline {
    constructor(durations) {
      this.frames = []
      let at = 0
      durations.forEach((duration, index) => {
        this.frames.push({ index, start: at, end: at + duration })
        at += duration
      })
      this.total = at || 1
    }

    frameAt(elapsed) {
      for (const frame of this.frames) {
        if (elapsed < frame.end) return frame.index
      }
      return this.frames.length - 1
    }
  }

  class SpritePet {
    constructor(manifest, options = {}) {
      this.manifest = manifest
      this.canvas = options.canvas
      this.ctx = this.canvas ? this.canvas.getContext('2d') : null
      if (this.ctx) this.ctx.imageSmoothingEnabled = false

      const cell = manifest.cell || { width: 192, height: 208 }
      this.cell = cell
      this.grid = manifest.grid || { columns: 8, rows: 11 }
      this.animations = manifest.animations || {}
      this.look = manifest.look || null
      this.idleName = manifest.idle || 'idle'
      this.performSpec = manifest.perform || { sequence: [], splash: false }
      // Which animations play while the pet is dragged. Ported pets use
      // their own names ("running-right"), so this is configurable.
      this.dragNames = manifest.drag || { right: 'swim-right', left: 'swim-left' }
      // What the pet does when it is clicked. A click is a "hello", so the
      // pet answers with something bigger than the idle row.
      this.reactName = manifest.react?.click || 'jumping'
      this.reacting = false

      // While idle the pet keeps itself busy. The official atlases barely
      // move in their idle row -- only the face changes -- so a pet that
      // plays nothing but `idle` looks switched off. Every few seconds it
      // takes a short turn at another row. The manifest may name the rows
      // and the interval.
      const routine = manifest.idleRoutine || {}
      this.idleActions = Array.isArray(routine.animations) && routine.animations.length > 0
        ? routine.animations
        : ['waving', 'waiting', 'review']
      // `every` is either a fixed number of seconds or a [min, max] range.
      // A range keeps the pet from fidgeting on the same beat every time,
      // which is what makes the motion read as alive rather than looped.
      let min = 5000
      let max = 5000
      if (Array.isArray(routine.every) && routine.every.length === 2) {
        const low = Number(routine.every[0])
        const high = Number(routine.every[1])
        if (Number.isFinite(low) && Number.isFinite(high) && low > 0) {
          min = low * 1000
          max = Math.max(min, high * 1000)
        }
      } else {
        const seconds = Number(routine.every)
        if (Number.isFinite(seconds) && seconds > 0) {
          min = seconds * 1000
          max = min
        }
      }
      this.idleRoutineMin = min
      this.idleRoutineMax = max
      this.idleWait = this.pickIdleWait()
      this.idleElapsed = 0
      this.idleCursor = 0

      this.timelines = new Map()
      for (const [name, spec] of Object.entries(this.animations)) {
        this.timelines.set(name, new Timeline(spec.durations || [120]))
      }

      this.image = null
      this.animation = null      // { name, row, timeline, startedAt, loop }
      this.sequence = null       // { steps, index, startedAt }
      this.dragAnimation = null
      this.lookFrame = null
      this.pointer = null
      this.dragging = false
      this.dragOrigin = null
      // The gaze the pointer asked for, and whether a frame has been asked
      // for yet to apply it.
      this.pendingLook = null
      this.lookScheduled = false
      this.raf = 0
      this.lastTime = 0

      this.reducedMotion = window.matchMedia
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false
    }

    // -- loading ---------------------------------------------------------

    load() {
      return new Promise((resolve, reject) => {
        const image = new Image()
        image.onload = () => {
          this.image = image
          this.watchSize()
          this.resize()
          this.play(this.idleName, { loop: true })
          this.start()
          resolve(this)
        }
        image.onerror = () => reject(new Error(`dsh-pet: cannot load atlas ${this.manifest.spritesheetPath}`))
        image.src = this.manifest.spritesheetPath
      })
    }

    // -- animation -------------------------------------------------------

    start() {
      if (this.raf) return
      this.lastTime = performance.now()
      const tick = (now) => {
        this.raf = requestAnimationFrame(tick)
        this.step(now)
      }
      this.raf = requestAnimationFrame(tick)
    }

    stop() {
      if (this.raf) cancelAnimationFrame(this.raf)
      this.raf = 0
    }

    step(now) {
      const delta = now - this.lastTime
      this.lastTime = now

      // A late layout pass can resize the canvas out from under us; pick it
      // up before drawing rather than after.
      if (!this.sizeIsSane()) {
        this.resize()
        return
      }
      if (this.canvas.width !== Math.round(this.canvas.getBoundingClientRect().width * (window.devicePixelRatio || 1))) {
        this.resize()
        return
      }

      if (this.reducedMotion) {
        this.drawFrame(this.idleRow(), 0)
        return
      }

      if (this.sequence) {
        this.stepSequence(delta)
        return
      }

      const active = this.dragAnimation || this.animation
      if (!active) {
        this.draw()
        return
      }

      active.elapsed = (active.elapsed || 0) + delta
      const index = active.timeline.frameAt(active.elapsed)
      if (index !== active.frame) {
        active.frame = index
        this.draw()
      }
      if (active.elapsed >= active.timeline.total) {
        if (active.loop) {
          active.elapsed %= active.timeline.total
        } else {
          // A one-shot action is over: fall back to the idle loop.
          this.animation = null
          this.reacting = false
          this.play(this.idleName, { loop: true })
          return
        }
      }

      // Idle alone is too still: the official atlases barely move in their
      // idle row (only the face changes), so a pet that plays nothing but
      // `idle` reads as switched off. The routine keeps it busy on its own.
      if (active === this.animation && active.name === this.idleName) {
        this.idleElapsed += delta
        if (this.idleElapsed >= this.idleWait) {
          this.idleElapsed = 0
          this.idleWait = this.pickIdleWait()
          this.playIdleAction()
        }
      }
    }

    /**
     * How long until the next idle action. A pet that fidgets on an exact
     * beat reads as a loop, so the interval is drawn from a range.
     */
    pickIdleWait() {
      if (this.idleRoutineMax <= this.idleRoutineMin) return this.idleRoutineMin
      return this.idleRoutineMin + Math.random() * (this.idleRoutineMax - this.idleRoutineMin)
    }

    /**
     * Play one short action while the pet is idle.
     *
     * The official Codex atlases keep their idle row almost motionless, so
     * the pet would sit there looking frozen. Every few seconds it takes a
     * short turn at another row instead, which is what makes it read as
     * alive. The manifest says which rows it may use and how often.
     */
    playIdleAction() {
      const options = this.idleActions
      for (let i = 0; i < options.length; i += 1) {
        const name = options[(this.idleCursor + i) % options.length]
        if (name === this.idleName) continue
        if (!this.animations[name]) continue
        this.idleCursor = (this.idleCursor + i + 1) % options.length
        this.play(name, { loop: false })
        return true
      }
      return false
    }

    /**
     * Play one named animation. Unknown names fall back to idle so a typo in
     * a manifest can never leave the pet frozen.
     */
    play(name, { loop = false } = {}) {
      const spec = this.animations[name]
      if (!spec) {
        if (name !== this.idleName) return this.play(this.idleName, { loop: true })
        return
      }
      const timeline = this.timelines.get(name) || new Timeline([120])
      this.animation = {
        name,
        row: spec.row,
        timeline,
        elapsed: 0,
        frame: 0,
        loop,
      }
      // Starting anything restarts the idle routine's clock.
      this.idleElapsed = 0
      this.setAnimationState(name)
      this.draw()
    }

    idleRow() {
      const spec = this.animations[this.idleName]
      return spec ? spec.row : 0
    }

    // -- perform ---------------------------------------------------------

    /**
     * The show the native helper schedules every 18-30 seconds. Returns the
     * duration in milliseconds so the shell knows when the next one may
     * start.
     */
    perform() {
      const steps = this.performSpec.sequence || []
      if (steps.length === 0) {
        this.play(this.idleName, { loop: true })
        return 0
      }
      const plan = []
      for (const step of steps) {
        const name = typeof step === 'string' ? step : step.animation
        const spec = this.animations[name]
        if (!spec) continue
        const timeline = this.timelines.get(name)
        const repeats = (typeof step === 'object' && step.repeat) || 1
        for (let i = 0; i < repeats; i += 1) {
          plan.push({ name, row: spec.row, duration: timeline.total })
        }
      }
      if (plan.length === 0) {
        this.play(this.idleName, { loop: true })
        return 0
      }
      this.sequence = { plan, index: 0, elapsed: 0 }
      this.playStep()
      const total = plan.reduce((sum, step) => sum + step.duration, 0)
      return total
    }

    playStep() {
      const step = this.sequence.plan[this.sequence.index]
      this.animation = {
        name: step.name,
        row: step.row,
        timeline: this.timelines.get(step.name),
        elapsed: 0,
        frame: 0,
        loop: false,
      }
      this.setAnimationState(step.name)
      this.draw()
    }

    stepSequence(delta) {
      const step = this.sequence.plan[this.sequence.index]
      this.animation.elapsed = (this.animation.elapsed || 0) + delta
      if (this.animation.elapsed >= step.duration) {
        this.sequence.index += 1
        if (this.sequence.index >= this.sequence.plan.length) {
          this.sequence = null
          this.play(this.idleName, { loop: true })
          if (this.performSpec.splash) this.splash()
          return
        }
        this.playStep()
        return
      }
      const index = this.animation.timeline.frameAt(this.animation.elapsed)
      if (index !== this.animation.frame) {
        this.animation.frame = index
        this.draw()
      }
    }

    splash() {
      window.dispatchEvent(new CustomEvent('dsh-pet-splash', {
        detail: { kind: this.performSpec.splash === true ? 'water' : this.performSpec.splash },
      }))
    }

    /**
     * Stop everything and go back to idle. Must be safe to call repeatedly:
     * the runtime calls it on every pointer down.
     */
    interrupt() {
      this.stopAll()
      this.play(this.idleName, { loop: true })
    }

    /**
     * Answer a click.
     *
     * The pet is clicked, so it answers with the manifest's reaction
     * animation -- a jump, by default. The reaction takes precedence over
     * the gaze, so the pet jumps instead of staring at the cursor, and the
     * gaze is dropped so the jump is not covered by a static frame.
     */
    react() {
      this.stopAll()
      this.lookOut()
      const name = this.reactName
      if (!name || !this.animations[name]) {
        this.play(this.idleName, { loop: true })
        return
      }
      this.reacting = true
      this.play(name, { loop: false })
    }

    /** Drop everything the pet is doing, without picking a new animation. */
    stopAll() {
      this.sequence = null
      this.dragAnimation = null
      this.dragging = false
      this.dragOrigin = null
      this.reacting = false
    }

    setAnimationState(name) {
      if (document.body) document.body.dataset.animation = name
    }

    // -- pointer ---------------------------------------------------------

    /**
     * Track the cursor so the pet can look at it. This is the one piece of
     * behaviour that makes a sprite pet feel like a character rather than a
     * looping GIF.
     */
    attachPointer(target = document) {
      target.addEventListener('pointerdown', (event) => {
        this.dragging = true
        this.dragOrigin = { x: event.clientX, y: event.clientY }
        // A click is a reaction, not a stare -- the gaze is dropped so the
        // pet's answer is not hidden behind a static frame.
      })
      target.addEventListener('pointermove', (event) => {
        // The gaze is applied once per frame, not once per event.
        //
        // A trackpad produces pointer events far faster than the screen
        // refreshes, and every one of them used to cost a forced layout
        // (getBoundingClientRect) and a redraw of the canvas -- work the
        // screen cannot show anyway. Folding the events into one per
        // frame keeps the gaze just as responsive and does a fraction of
        // the drawing.
        this.pendingLook = { x: event.clientX, y: event.clientY }
        if (!this.lookScheduled) {
          this.lookScheduled = true
          requestAnimationFrame(() => {
            this.lookScheduled = false
            const at = this.pendingLook
            this.pendingLook = null
            if (at) this.updateLook(at.x, at.y)
          })
        }
        if (this.dragging) this.updateDrag(event.clientX)
      })
      const end = () => {
        this.dragging = false
        this.dragOrigin = null
        this.dragAnimation = null
        this.play(this.idleName, { loop: true })
      }
      target.addEventListener('pointerup', end)
      target.addEventListener('pointercancel', end)
      target.addEventListener('pointerleave', () => {
        this.lookOut()
      })
      // Leaving the window altogether is reported as a `pointerout` with no
      // new target. A WebView that only gets events while the pointer is
      // over it usually never delivers either of these, which is why the
      // native helper also tells the page when the cursor leaves -- see
      // `lookOut()`.
      target.addEventListener('pointerout', (event) => {
        if (event.relatedTarget === null) this.lookOut()
      })
    }

    /**
     * Look at a point in the page's coordinates.
     *
     * The native helper sends the cursor position here, because a pet
     * floating over the desktop is not the frontmost app and macOS only
     * hands mouse-moved events to the frontmost one. The page's own
     * pointer events still work when they arrive -- this is the other
     * way in, and the one that always works.
     */
    lookAt(clientX, clientY) {
      this.updateLook(clientX, clientY)
    }

    /**
     * Stop looking at the cursor and go back to the animation.
     *
     * The gaze rows are static frames, so a pet that is looking at the cursor
     * stops animating -- and if the "cursor left" event never arrives, it
     * stays frozen in that pose forever. A WebView only receives pointer
     * events while the pointer is over it, so the native helper has to say
     * when the cursor is gone; this is the page-side half of that.
     */
    lookOut() {
      // A gaze that was asked for but not applied yet must not come back
      // after the cursor has already left.
      this.pendingLook = null
      if (!this.lookFrame) return
      this.lookFrame = null
      this.draw()
    }

    updateDrag(clientX) {
      if (!this.dragOrigin) return
      const dx = clientX - this.dragOrigin.x
      const name = dx > 3 ? this.dragNames.right : dx < -3 ? this.dragNames.left : null
      if (!name || !this.animations[name]) return
      if (this.dragAnimation && this.dragAnimation.name === name) return
      const spec = this.animations[name]
      this.dragAnimation = {
        name,
        row: spec.row,
        timeline: this.timelines.get(name),
        elapsed: 0,
        frame: 0,
        loop: true,
      }
      this.setAnimationState(name)
    }

    updateLook(clientX, clientY) {
      if (!this.look) return
      const rect = this.canvas ? this.canvas.getBoundingClientRect() : null
      if (!rect || rect.width === 0) return
      const centreX = rect.left + rect.width / 2
      const centreY = rect.top + rect.height * 0.42
      const dx = clientX - centreX
      const dy = clientY - centreY
      if (Math.hypot(dx, dy) > rect.width * 1.4) {
        this.lookFrame = null
        this.draw()
        return
      }
      // 0 degrees points straight up; the angle grows clockwise.
      const degrees = (Math.atan2(dx, -dy) * 180) / Math.PI
      const step = this.look.stepDegrees || 22.5
      const count = this.look.count || 16
      const index = ((Math.round(degrees / step) % count) + count) % count
      const rows = this.look.rows || []
      const columns = this.grid.columns || 8
      const row = rows[Math.floor(index / columns)] ?? rows[0]
      const column = index % columns
      const previous = this.lookFrame
      this.lookFrame = { row, column }
      // The gaze rows are static frames, so the canvas only has to be
      // redrawn when the direction actually changed.
      if (!previous || previous.row !== row || previous.column !== column) {
        this.draw()
      }
    }

    // -- drawing ---------------------------------------------------------

    resize() {
      if (!this.canvas || !this.ctx) return
      const rect = this.canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const width = Math.max(1, Math.round(rect.width * dpr))
      const height = Math.max(1, Math.round(rect.height * dpr))
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width
        this.canvas.height = height
        this.sized = true
      }
      this.draw()
    }

    /**
     * The canvas can still be unlaid out when the atlas finishes loading,
     * which would size it down to a single pixel and leave the pet
     * invisible. Watch the element instead of the window, and re-check the
     * size on every frame so a late layout pass is always picked up.
     */
    watchSize() {
      if (!this.canvas || typeof ResizeObserver === 'undefined') return
      this.observer = new ResizeObserver(() => this.resize())
      this.observer.observe(this.canvas)
    }

    sizeIsSane() {
      if (!this.canvas) return false
      const rect = this.canvas.getBoundingClientRect()
      return rect.width > 1 && rect.height > 1
    }

    draw() {
      if (!this.ctx) return
      // Priority: a scheduled show beats a drag, a drag beats the idle
      // loop, and the idle loop beats a bare "look at the cursor" frame.
      if (this.sequence && this.animation) {
        this.drawFrame(this.animation.row, this.animation.frame || 0)
        return
      }
      if (this.dragAnimation) {
        this.drawFrame(this.dragAnimation.row, this.dragAnimation.frame || 0)
        return
      }
      // A reaction outranks the gaze: the pet is jumping, not staring.
      if (this.reacting && this.animation) {
        this.drawFrame(this.animation.row, this.animation.frame || 0)
        return
      }
      if (this.lookFrame) {
        this.drawFrame(this.lookFrame.row, this.lookFrame.column)
        return
      }
      if (this.animation) {
        this.drawFrame(this.animation.row, this.animation.frame || 0)
        return
      }
      this.drawFrame(this.idleRow(), 0)
    }

    drawFrame(row, column) {
      if (!this.ctx) return
      const { ctx, canvas, cell } = this
      if (canvas.width <= 1 || canvas.height <= 1) return
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      if (!this.image) return
      const scale = Math.min(canvas.width / cell.width, canvas.height / cell.height)
      const width = cell.width * scale
      const height = cell.height * scale
      const x = (canvas.width - width) / 2
      const y = (canvas.height - height) / 2
      ctx.drawImage(
        this.image,
        column * cell.width,
        row * cell.height,
        cell.width,
        cell.height,
        x,
        y,
        width,
        height,
      )
    }
  }

  /**
   * Mount a sprite pet from an inline manifest. The native helper injects
   * the manifest into the page before this runs.
   */
  function mount(manifest, options = {}) {
    if (!manifest || !manifest.spritesheetPath) {
      console.error('dsh-pet: manifest has no spritesheetPath')
      return null
    }
    const pet = new SpritePet(manifest, options)
    pet.load().then(() => {
      pet.attachPointer(document)
      if (window.DSHPet) {
        window.DSHPet.register({
          perform: () => pet.perform(),
          interrupt: () => pet.interrupt(),
          lookOut: () => pet.lookOut(),
          lookAt: (x, y) => pet.lookAt(x, y),
          react: () => pet.react(),
        })
      }
      window.dispatchEvent(new CustomEvent('dsh-pet-ready', { detail: { pet } }))
    }).catch((error) => {
      console.error('dsh-pet: sprite pet failed to start', error)
    })
    window.addEventListener('resize', () => pet.resize())
    if (typeof ResizeObserver === 'undefined') {
      // Older engines: poll the size instead of observing it.
      window.setInterval(() => pet.resize(), 250)
    }
    return pet
  }

  window.DSHSpritePet = { SpritePet, mount }
})()
