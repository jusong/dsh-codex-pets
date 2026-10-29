/**
 * Plays a pet: which atlas cell to show at any moment.
 *
 * This is the behaviour of a Codex pet, and nothing in it touches a screen:
 * `tick(deltaMs)` moves the clock, and `onFrame(row, column)` says which
 * cell to draw. The renderer draws it; the tests drive it with a fake clock.
 *
 * The contract a Codex `pet.json` leaves out (rows, frame timings, what a
 * pet does when idle) lives in `lib/codex-pet.js`; the host hands the
 * normalized manifest over, and `readManifest` below fills in whatever is
 * still missing the same way.
 */

/** One row of the atlas, with a duration per frame. The last frame usually lingers. */
export class Animation {
  constructor(name, row, durations) {
    this.name = name
    this.row = row
    this.durations = durations.length === 0 ? [120] : durations
    const sum = this.durations.reduce((a, b) => a + b, 0)
    this.total = sum > 0 ? sum : 1
  }

  frame(elapsed) {
    let end = 0
    for (let index = 0; index < this.durations.length; index += 1) {
      end += this.durations[index]
      if (elapsed < end) return index
    }
    return this.durations.length - 1
  }
}

export const CONTRACT = {
  animations: [
    ['idle', [280, 110, 110, 140, 140, 320]],
    ['running-right', [120, 120, 120, 120, 120, 120, 120, 220]],
    ['running-left', [120, 120, 120, 120, 120, 120, 120, 220]],
    ['waving', [140, 140, 140, 280]],
    ['jumping', [140, 140, 140, 140, 280]],
    ['failed', [140, 140, 140, 140, 140, 140, 140, 240]],
    ['waiting', [150, 150, 150, 150, 150, 260]],
    ['running', [120, 120, 120, 120, 120, 220]],
    ['review', [150, 150, 150, 150, 150, 280]],
  ],
  lookRows: [9, 10],
  idleActions: ['waiting', 'waving', 'running'],
  performSteps: [['jumping', 1], ['waving', 1]],
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/** Everything the player reads from a pet, with the contract's defaults filled in. */
export function readManifest(object) {
  const raw = isObject(object) ? object : {}
  const cell = isObject(raw.cell) ? raw.cell : {}
  const grid = isObject(raw.grid) ? raw.grid : {}
  const manifest = {
    sheet: typeof raw.spritesheetPath === 'string' ? raw.spritesheetPath : '',
    cellWidth: Math.max(1, Math.trunc(num(cell.width) ?? 192)),
    cellHeight: Math.max(1, Math.trunc(num(cell.height) ?? 208)),
    columns: Math.max(1, Math.trunc(num(grid.columns) ?? 8)),
    rows: Math.max(1, Math.trunc(num(grid.rows) ?? 9)),
    animations: new Map(),
  }

  CONTRACT.animations.forEach(([name, durations], row) => {
    manifest.animations.set(name, new Animation(name, row, durations))
  })
  if (isObject(raw.animations)) {
    for (const [name, spec] of Object.entries(raw.animations)) {
      if (!isObject(spec)) continue
      const durations = Array.isArray(spec.durations) ? spec.durations.filter((d) => num(d) !== null) : []
      const previous = manifest.animations.get(name)
      const row = Math.trunc(num(spec.row) ?? previous?.row ?? 0)
      manifest.animations.set(name, new Animation(name, row, durations.length > 0 ? durations : (previous?.durations ?? [])))
    }
  }
  manifest.idle = typeof raw.idle === 'string' ? raw.idle : 'idle'

  const look = isObject(raw.look) ? raw.look : null
  manifest.lookRows = Array.isArray(look?.rows)
    ? look.rows.filter((r) => num(r) !== null).map(Math.trunc)
    : (manifest.rows >= 11 ? CONTRACT.lookRows : [])
  manifest.lookCount = Math.max(1, Math.trunc(num(look?.count) ?? 16))
  manifest.lookStep = num(look?.stepDegrees) ?? 22.5

  const routine = isObject(raw.idleRoutine) ? raw.idleRoutine : {}
  const actions = Array.isArray(routine.animations) ? routine.animations.filter((a) => typeof a === 'string') : []
  manifest.idleActions = actions.length > 0 ? actions : CONTRACT.idleActions
  let low = 5000
  let high = 5000
  if (Array.isArray(routine.every) && routine.every.length === 2 && num(routine.every[0]) !== null && num(routine.every[1]) !== null && routine.every[0] > 0) {
    low = routine.every[0] * 1000
    high = Math.max(low, routine.every[1] * 1000)
  } else if (num(routine.every) !== null && routine.every > 0) {
    low = routine.every * 1000
    high = low
  }
  manifest.idleMin = low
  manifest.idleMax = high

  const perform = isObject(raw.perform) ? raw.perform : {}
  const showDefined = isObject(raw.perform)
  const steps = []
  for (const step of Array.isArray(perform.sequence) ? perform.sequence : []) {
    if (typeof step === 'string') steps.push([step, 1])
    else if (isObject(step) && typeof step.animation === 'string') steps.push([step.animation, Math.max(1, Math.trunc(num(step.repeat) ?? 1))])
  }
  manifest.performSteps = showDefined ? steps : CONTRACT.performSteps
  if (typeof perform.splash === 'string') manifest.splash = perform.splash === 'sparkle' ? 'sparkle' : 'water'
  else if (perform.splash === true) manifest.splash = 'water'
  else manifest.splash = showDefined ? null : 'sparkle'

  const drag = isObject(raw.drag) ? raw.drag : {}
  manifest.dragRight = typeof drag.right === 'string' ? drag.right : 'running-right'
  manifest.dragLeft = typeof drag.left === 'string' ? drag.left : 'running-left'
  manifest.reactName = isObject(raw.react) && typeof raw.react.click === 'string' ? raw.react.click : 'jumping'
  return manifest
}

class Playing {
  constructor(animation, loop) {
    this.animation = animation
    this.loop = loop
    this.elapsed = 0
    this.frame = 0
  }

  /** Move the clock on; true when a one-shot animation is over. */
  advance(delta) {
    this.elapsed += delta
    this.frame = this.animation.frame(this.elapsed)
    if (this.elapsed < this.animation.total) return false
    if (this.loop) {
      this.elapsed %= this.animation.total
      return false
    }
    return true
  }
}

/** What the ground shadow does while the pet is in this animation. */
export function shadowFor(name) {
  switch (name) {
    case 'jumping': return { scale: 0.72, opacity: 0.55 }
    case 'waving': return { scale: 0.92, opacity: 1 }
    case 'failed': return { scale: 1.06, opacity: 0.28 }
    default: return { scale: 1, opacity: 1 }
  }
}

export class SpritePlayer {
  /**
   * @param manifest result of `readManifest`
   * @param options.onFrame (row, column) => void, called when the shown cell changes
   * @param options.onShadow ({ scale, opacity }) => void
   * @param options.onSplash (kind) => void
   */
  constructor(manifest, { reducedMotion = false, random = Math.random, onFrame, onShadow, onSplash } = {}) {
    this.manifest = manifest
    this.reducedMotion = reducedMotion
    this.random = random
    this.onFrame = onFrame ?? (() => {})
    this.onShadow = onShadow ?? (() => {})
    this.onSplash = onSplash ?? (() => {})

    this.animation = null
    this.sequence = null
    this.dragAnimation = null
    /** Pressed, but not yet running. The picture on screen stays put. */
    this.dragHold = false
    this.lookFrame = null
    this.reacting = false
    /** Keep the pet in its running row while a listed session is working. */
    this.workRunning = false
    this.idleElapsed = 0
    this.idleCursor = 0
    this.shownCell = null
    this.idleWait = this.pickIdleWait()
    this.play(manifest.idle, true)
  }

  get idleRow() {
    return this.manifest.animations.get(this.manifest.idle)?.row ?? 0
  }

  get workAnimationName() {
    const { animations, dragRight, idle } = this.manifest
    if (animations.has(dragRight)) return dragRight
    if (animations.has('running')) return 'running'
    return idle
  }

  get jumpAnimationName() {
    return this.manifest.animations.has('jumping') ? 'jumping' : this.manifest.reactName
  }

  get dragging() {
    return this.dragHold || this.dragAnimation !== null
  }

  get performing() {
    return this.sequence !== null
  }

  tick(delta) {
    if (this.reducedMotion) {
      this.show(this.idleRow, 0)
      return
    }
    // The press has not picked a direction yet. Advancing the idle clock
    // here would replace the picture the user just grabbed.
    if (this.dragHold && this.dragAnimation === null) return
    if (this.sequence !== null) {
      this.stepSequence(delta)
      return
    }
    if (this.dragAnimation !== null) {
      this.dragAnimation.advance(delta)
      this.draw()
      return
    }
    const active = this.animation
    if (active === null) {
      this.draw()
      return
    }
    if (active.advance(delta)) {
      this.animation = null
      this.reacting = false
      this.resumeAfterOneShot()
      return
    }
    // The idle rows barely move on their own, so every few seconds the pet
    // takes a short turn at another row. Not while a session keeps it running.
    if (!this.workRunning && active.animation.name === this.manifest.idle) {
      this.idleElapsed += delta
      if (this.idleElapsed >= this.idleWait) {
        this.idleElapsed = 0
        this.idleWait = this.pickIdleWait()
        this.playIdleAction()
      }
    }
    this.draw()
  }

  resumeAfterOneShot() {
    if (this.workRunning) this.play(this.workAnimationName, true)
    else this.play(this.manifest.idle, true)
  }

  pickIdleWait() {
    const { idleMin, idleMax } = this.manifest
    if (idleMax <= idleMin) return idleMin
    return idleMin + this.random() * (idleMax - idleMin)
  }

  playIdleAction() {
    const options = this.manifest.idleActions
    for (let offset = 0; offset < options.length; offset += 1) {
      const name = options[(this.idleCursor + offset) % options.length]
      if (name === this.manifest.idle || !this.manifest.animations.has(name)) continue
      this.idleCursor = (this.idleCursor + offset + 1) % options.length
      this.play(name, false)
      return
    }
  }

  /** Play one named animation; an unknown name falls back to idle, so a typo can never freeze the pet. */
  play(name, loop) {
    const spec = this.manifest.animations.get(name)
    if (spec === undefined) {
      if (name !== this.manifest.idle) this.play(this.manifest.idle, true)
      return
    }
    this.animation = new Playing(spec, loop)
    this.idleElapsed = 0
    this.applyState(name)
    this.draw()
  }

  // -- behaviour ----------------------------------------------------------

  /** The scheduled show. Returns its length in milliseconds. */
  perform() {
    const plan = []
    for (const [name, repeats] of this.manifest.performSteps) {
      const spec = this.manifest.animations.get(name)
      if (spec === undefined) continue
      for (let i = 0; i < repeats; i += 1) plan.push(spec)
    }
    if (plan.length === 0) {
      this.play(this.manifest.idle, true)
      return 0
    }
    this.sequence = { plan, index: 0 }
    this.playStep()
    return plan.reduce((sum, item) => sum + item.total, 0)
  }

  playStep() {
    if (this.sequence === null) return
    const step = this.sequence.plan[this.sequence.index]
    this.animation = new Playing(step, false)
    this.applyState(step.name)
    this.draw()
  }

  stepSequence(delta) {
    const active = this.animation
    if (this.sequence === null || active === null) return
    if (active.advance(delta)) {
      this.sequence.index += 1
      if (this.sequence.index >= this.sequence.plan.length) {
        this.sequence = null
        this.resumeAfterOneShot()
        if (this.manifest.splash !== null) this.splash(this.manifest.splash)
        return
      }
      this.playStep()
      return
    }
    this.draw()
  }

  /** Answer a click with the reaction animation; the reaction outranks the gaze. */
  react() {
    this.stopAll()
    this.lookFrame = null
    if (!this.manifest.animations.has(this.manifest.reactName)) {
      this.resumeAfterOneShot()
      return
    }
    this.reacting = true
    this.play(this.manifest.reactName, false)
  }

  /** Drop the show, the reaction and the gaze, and stand still. */
  interrupt() {
    this.stopAll()
    this.lookFrame = null
    this.resumeAfterOneShot()
  }

  /**
   * A drag just started. Stop a show, but do not redraw: the press should
   * leave the current picture in place until a direction arrives.
   */
  holdForDrag() {
    this.sequence = null
    this.reacting = false
    this.dragHold = true
  }

  /** Stay in the drag-right gait while sessions are working. */
  setWorkRunning(on) {
    this.workRunning = on
    if (on) this.lookFrame = null
    if (this.dragHold || this.dragAnimation !== null || this.sequence !== null) return
    if (on) {
      if (this.animation?.animation.name !== this.workAnimationName) this.play(this.workAnimationName, true)
      else this.draw()
    } else if (this.animation?.animation.name === this.workAnimationName) {
      this.play(this.manifest.idle, true)
    }
  }

  /** Jump a few times when a listed session finishes, then resume work or idle. */
  celebrateJumps(count = 3) {
    if (this.reducedMotion) return
    const spec = this.manifest.animations.get(this.jumpAnimationName)
    if (spec === undefined || count <= 0) return
    this.lookFrame = null
    this.reacting = false
    this.dragAnimation = null
    this.sequence = { plan: Array.from({ length: count }, () => spec), index: 0 }
    this.playStep()
  }

  stopAll() {
    this.sequence = null
    this.dragAnimation = null
    this.reacting = false
  }

  /** Run left or right while dragged; null stands still. */
  setDragDirection(right) {
    if (right === null) {
      if (this.dragAnimation === null) return
      this.dragAnimation = null
      this.applyState(this.animation?.animation.name ?? (this.workRunning ? this.workAnimationName : this.manifest.idle))
      this.draw()
      return
    }
    const name = right ? this.manifest.dragRight : this.manifest.dragLeft
    const spec = this.manifest.animations.get(name)
    if (spec === undefined || this.dragAnimation?.animation.name === name) return
    this.dragAnimation = new Playing(spec, true)
    this.applyState(name)
    this.draw()
  }

  endDrag() {
    this.dragHold = false
    this.dragAnimation = null
    this.resumeAfterOneShot()
  }

  /** Look in a direction: 0 degrees is straight up, growing clockwise. */
  look(degrees) {
    // A working pet is already mid-stride; staring would replace the gait.
    // A drag just started from whatever pose is on screen; a late gaze
    // message must not swap that pose for one frame.
    if (this.workRunning || this.dragHold || this.dragAnimation !== null) return
    const { lookRows, lookCount, lookStep, columns } = this.manifest
    if (lookRows.length === 0) return
    const bucket = Math.floor(degrees / lookStep + 0.5)
    const index = ((bucket % lookCount) + lookCount) % lookCount
    const rowIndex = Math.floor(index / columns)
    const row = rowIndex < lookRows.length ? lookRows[rowIndex] : lookRows[0]
    const next = { row, column: index % columns }
    if (this.lookFrame !== null && this.lookFrame.row === next.row && this.lookFrame.column === next.column) return
    this.lookFrame = next
    this.draw()
  }

  lookOut() {
    if (this.dragHold || this.dragAnimation !== null) return
    if (this.lookFrame === null) return
    this.lookFrame = null
    this.draw()
  }

  // -- drawing ------------------------------------------------------------

  /**
   * A show beats a drag, a drag beats a reaction, work-running beats the
   * gaze (the body is moving), a reaction beats the gaze, and the gaze beats
   * a quiet idle animation.
   */
  draw() {
    const active = this.animation
    if (this.sequence !== null && active !== null) return this.show(active.animation.row, active.frame)
    if (this.dragAnimation !== null) return this.show(this.dragAnimation.animation.row, this.dragAnimation.frame)
    if (this.reacting && active !== null) return this.show(active.animation.row, active.frame)
    if (this.workRunning && active !== null) return this.show(active.animation.row, active.frame)
    if (this.lookFrame !== null) return this.show(this.lookFrame.row, this.lookFrame.column)
    if (active !== null) return this.show(active.animation.row, active.frame)
    return this.show(this.idleRow, 0)
  }

  show(row, column) {
    if (this.shownCell !== null && this.shownCell.row === row && this.shownCell.column === column) return
    if (row < 0 || row >= this.manifest.rows || column < 0 || column >= this.manifest.columns) return
    this.shownCell = { row, column }
    this.onFrame(row, column)
  }

  applyState(name) {
    this.onShadow({ ...shadowFor(name), animated: !this.reducedMotion })
  }

  splash(kind) {
    if (!this.reducedMotion) this.onSplash(kind)
  }
}
