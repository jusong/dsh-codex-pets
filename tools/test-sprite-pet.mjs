/**
 * Unit checks for the sprite pet engine.
 *
 * The engine is written for a browser, so the DOM is stubbed just enough to
 * load it and drive the parts that are easy to get wrong: the frame
 * timeline, the cursor-angle to look-frame mapping, and the sequencing of a
 * scheduled show.
 *
 * Run with: node tools/test-sprite-pet.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const engine = readFileSync(join(here, '..', 'runtime', 'sprite-pet.js'), 'utf8')

// ---- minimal DOM ---------------------------------------------------------

const rect = { left: 0, top: 0, width: 200, height: 200 }
const canvas = {
  width: 0,
  height: 0,
  getContext: () => ({
    imageSmoothingEnabled: true,
    clearRect() {},
    drawImage() {},
  }),
  getBoundingClientRect: () => rect,
}

globalThis.window = {
  devicePixelRatio: 2,
  matchMedia: () => ({ matches: false }),
  addEventListener() {},
  dispatchEvent() {},
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout,
}
globalThis.document = {
  body: { dataset: {} },
  addEventListener() {},
  createElement: () => ({ style: { setProperty() {} }, classList: { add() {} } }),
}
globalThis.Image = class {
  set src(value) { this._src = value }
  get src() { return this._src }
}
globalThis.requestAnimationFrame = () => 0
globalThis.cancelAnimationFrame = () => {}
globalThis.CustomEvent = class {
  constructor(type, init) { this.type = type; this.detail = init?.detail }
}
globalThis.performance = { now: () => 0 }

// eslint-disable-next-line no-new-func
new Function(engine)()

const { SpritePet } = globalThis.window.DSHSpritePet

// ---- fixtures ------------------------------------------------------------

const manifest = {
  id: 'hoots',
  name: 'Hoots',
  size: 200,
  type: 'sprite',
  spriteVersionNumber: 2,
  spritesheetPath: 'spritesheet.webp',
  cell: { width: 192, height: 208 },
  grid: { columns: 8, rows: 11 },
  idle: 'idle',
  animations: {
    idle: { row: 0, durations: [280, 110, 110, 140, 140, 320] },
    'running-right': { row: 1, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
    'running-left': { row: 2, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
    waving: { row: 3, durations: [140, 140, 140, 280] },
    jumping: { row: 4, durations: [140, 140, 140, 140, 280] },
  },
  drag: { right: 'running-right', left: 'running-left' },
  look: { rows: [9, 10], count: 16, startDegrees: 0, stepDegrees: 22.5 },
  react: { click: 'jumping' },
  // The idle routine is exercised on its own below; here it stays out of
  // the way so the show assertions are not disturbed by it.
  idleRoutine: { every: 9999, animations: ['waving'] },
  perform: { sequence: ['jumping', 'jumping', 'waving'], splash: 'sparkle' },
}

const pet = new SpritePet(manifest, { canvas })
pet.image = { width: 1536, height: 2288 }

// ---- timeline ------------------------------------------------------------

const idle = pet.timelines.get('idle')
assert.equal(idle.total, 280 + 110 + 110 + 140 + 140 + 320, 'idle row duration')
assert.equal(idle.frameAt(0), 0, 'first frame')
assert.equal(idle.frameAt(279), 0, 'still frame 0 just before the first cut')
assert.equal(idle.frameAt(280), 1, 'cuts to frame 1')
assert.equal(idle.frameAt(389), 1, 'frame 1 lasts 110ms')
assert.equal(idle.frameAt(390), 2, 'cuts to frame 2')
assert.equal(idle.frameAt(1099), 5, 'last frame holds to the end')
assert.equal(idle.frameAt(5000), 5, 'clamps to the last frame')

// ---- look directions -----------------------------------------------------
//
// 0 degrees is straight up and the angle grows clockwise, so a cursor above
// the pet is frame 0 and a cursor to the right is frame 4.

const centreX = rect.left + rect.width / 2
const centreY = rect.top + rect.height * 0.42

function lookAt(dx, dy) {
  pet.lookFrame = null
  pet.updateLook(centreX + dx, centreY + dy)
  return pet.lookFrame
}

// The look rows follow the Codex contract: row 9 holds 000-157.5 degrees
// and row 10 holds 180-337.5, so "down" is the first cell of row 10 and
// "left" is its fifth.

assert.deepEqual(lookAt(0, -50), { row: 9, column: 0 }, 'up is the first look cell')
assert.deepEqual(lookAt(50, 0), { row: 9, column: 4 }, 'right is the fifth look cell')
assert.deepEqual(lookAt(0, 50), { row: 10, column: 0 }, 'down is the first cell of the second row')
assert.deepEqual(lookAt(-50, 0), { row: 10, column: 4 }, 'left is the fifth cell of the second row')

// A cursor far outside the panel should stop tracking.
pet.lookFrame = null
pet.updateLook(centreX + 5000, centreY)
assert.equal(pet.lookFrame, null, 'loses the cursor outside the panel')

// ---- leaving the gaze --------------------------------------------------
//
// The gaze rows are static frames, so a pet that is looking at the cursor
// stops animating. If the "cursor left" signal never arrives, the pet stays
// frozen in that pose forever -- which is exactly what the native helper
// has to tell the page.

const gazer = new SpritePet(manifest, { canvas })
gazer.image = { width: 1536, height: 2288 }
gazer.play('idle', { loop: true })
gazer.updateLook(centreX, centreY - 50)
assert.ok(gazer.lookFrame, 'the pet looks at a cursor above it')

let draws = 0
gazer.draw = () => { draws += 1 }
gazer.lookOut()
assert.equal(gazer.lookFrame, null, 'lookOut clears the gaze')
assert.equal(draws, 1, 'lookOut redraws, so the animation shows again')

gazer.lookOut()
assert.equal(draws, 1, 'lookOut does nothing when there is no gaze')

// ---- drag direction ------------------------------------------------------

pet.dragOrigin = { x: 100, y: 100 }
pet.updateDrag(140)
assert.equal(pet.dragAnimation?.name, 'running-right', 'dragging right runs right')
pet.dragOrigin = { x: 100, y: 100 }
pet.updateDrag(40)
assert.equal(pet.dragAnimation?.name, 'running-left', 'dragging left runs left')
pet.dragOrigin = { x: 100, y: 100 }
pet.updateDrag(101)
assert.equal(pet.dragAnimation?.name, 'running-left', 'a tiny move keeps the previous direction')

// ---- perform sequencing --------------------------------------------------

const duration = pet.perform()
assert.equal(duration, 840 + 840 + 700, 'perform returns the summed row durations')
assert.equal(pet.sequence.plan.length, 3, 'the show has three steps')
assert.equal(pet.sequence.plan[0].name, 'jumping', 'the show starts with a jump')
assert.equal(pet.sequence.plan[2].name, 'waving', 'the show ends with a wave')
assert.equal(pet.sequence.plan[0].duration, 840, 'jump row duration')
assert.equal(pet.sequence.plan[2].duration, 700, 'wave row duration')

// Walking the sequence to its end must return the pet to idle.
let now = 0
for (let step = 0; step < 4000; step += 1) {
  now += 16
  pet.lastTime = now - 16
  pet.step(now)
}
assert.equal(pet.sequence, null, 'the show finished')
assert.equal(pet.animation?.name, 'idle', 'the pet is back to idle')
assert.equal(pet.animation?.loop, true, 'idle loops')

// ---- idle routine --------------------------------------------------------
//
// The official Codex atlases barely move in their idle row, so a pet that
// plays nothing but `idle` reads as frozen. The idle routine is what keeps
// it moving on its own.

const fidget = new SpritePet({
  ...manifest,
  idleRoutine: { every: 2, animations: ['waving', 'review'] },
}, { canvas })
fidget.image = { width: 1536, height: 2288 }
fidget.play('idle', { loop: true })

// A fixed interval is used as-is.
assert.equal(fidget.idleRoutineMin, 2000, 'a fixed interval is kept')
assert.equal(fidget.idleRoutineMax, 2000, 'a fixed interval has no spread')
assert.equal(fidget.idleWait, 2000, 'a fixed interval waits exactly that long')

const played = new Set()
let clock = 0
for (let step = 0; step < 600; step += 1) {
  clock += 16
  fidget.lastTime = clock - 16
  fidget.step(clock)
  if (fidget.animation) played.add(fidget.animation.name)
}
assert.ok(played.has('waving') || played.has('review'), 'the idle routine plays another row')
assert.ok(played.has('idle'), 'the pet keeps its idle loop between the actions')

// A range makes the fidgeting land on a different beat every time.
const scattered = new SpritePet({
  ...manifest,
  idleRoutine: { every: [1, 5], animations: ['waving'] },
}, { canvas })
scattered.image = { width: 1536, height: 2288 }
assert.equal(scattered.idleRoutineMin, 1000, 'a range keeps its lower bound')
assert.equal(scattered.idleRoutineMax, 5000, 'a range keeps its upper bound')
const waits = new Set()
for (let i = 0; i < 50; i += 1) waits.add(Math.round(scattered.pickIdleWait()))
assert.ok(Math.min(...waits) >= 1000 && Math.max(...waits) <= 5000, 'every wait lands inside the range')
assert.ok(waits.size > 1, 'a range produces more than one wait')

// A range with a missing or broken bound falls back to the default.
const brokenRange = new SpritePet({
  ...manifest,
  idleRoutine: { every: ['nope', 5], animations: ['waving'] },
}, { canvas })
assert.equal(brokenRange.idleRoutineMin, 5000, 'a broken range falls back to five seconds')
assert.equal(brokenRange.idleRoutineMax, 5000, 'a broken range has no spread')

// The routine must not fire before its interval has passed.
const patient = new SpritePet({
  ...manifest,
  idleRoutine: { every: 2, animations: ['waving'] },
}, { canvas })
patient.image = { width: 1536, height: 2288 }
patient.play('idle', { loop: true })
let early = 0
clock = 0
for (let step = 0; step < 100; step += 1) {
  clock += 16
  patient.lastTime = clock - 16
  patient.step(clock)
  if (patient.animation && patient.animation.name !== 'idle') early += 1
}
assert.equal(early, 0, 'the routine waits for its interval')

// A pet whose manifest names no usable row simply keeps idling.
const quiet = new SpritePet({
  ...manifest,
  idleRoutine: { every: 1, animations: ['does-not-exist'] },
}, { canvas })
quiet.image = { width: 1536, height: 2288 }
quiet.play('idle', { loop: true })
clock = 0
for (let step = 0; step < 200; step += 1) {
  clock += 16
  quiet.lastTime = clock - 16
  quiet.step(clock)
}
assert.equal(quiet.animation?.name, 'idle', 'an unknown routine row leaves the pet idling')

// ---- interrupt -----------------------------------------------------------

pet.perform()
pet.interrupt()
pet.interrupt()
assert.equal(pet.sequence, null, 'interrupt clears the show')
assert.equal(pet.dragAnimation, null, 'interrupt clears the drag')
assert.equal(pet.animation?.name, 'idle', 'interrupt returns to idle')

// ---- click reaction -----------------------------------------------------
//
// A click is a "hello", so the pet answers with its reaction animation --
// a jump by default. The reaction outranks the gaze, or the jump would be
// hidden behind a static look frame.

const jumper = new SpritePet(manifest, { canvas })
jumper.image = { width: 1536, height: 2288 }
jumper.play('idle', { loop: true })
jumper.lookFrame = { row: 9, column: 2 }
jumper.react()
assert.equal(jumper.animation?.name, 'jumping', 'a click makes the pet jump')
assert.equal(jumper.animation?.loop, false, 'the jump is played once')
assert.equal(jumper.reacting, true, 'the pet is reacting')
assert.equal(jumper.lookFrame, null, 'the jump drops the gaze')
assert.equal(jumper.sequence, null, 'a click cancels a running show')

// A reaction has to outrank the gaze, or the pet would stare instead.
const stared = new SpritePet(manifest, { canvas })
stared.image = { width: 1536, height: 2288 }
stared.play('idle', { loop: true })
stared.lookFrame = { row: 10, column: 5 }
stared.react()
stared.lookFrame = { row: 10, column: 5 }
const drawn = []
stared.drawFrame = (row) => { drawn.push(row) }
stared.draw()
assert.equal(drawn[drawn.length - 1], manifest.animations.jumping.row, 'the jump is drawn, not the gaze')

// Once the jump is over the pet goes back to its idle loop.
let jumpClock = 0
for (let step = 0; step < 200; step += 1) {
  jumpClock += 16
  jumper.lastTime = jumpClock - 16
  jumper.step(jumpClock)
}
assert.equal(jumper.reacting, false, 'the reaction is over')
assert.equal(jumper.animation?.name, 'idle', 'the pet is back to idle after the jump')

// A pet whose manifest names no usable reaction simply keeps idling.
const mute = new SpritePet({ ...manifest, react: { click: 'does-not-exist' } }, { canvas })
mute.image = { width: 1536, height: 2288 }
mute.play('idle', { loop: true })
mute.react()
assert.equal(mute.animation?.name, 'idle', 'an unknown reaction leaves the pet idling')
assert.equal(mute.reacting, false, 'an unknown reaction is not a reaction')

// ---- manifest validation -------------------------------------------------

const broken = new SpritePet({ ...manifest, animations: { ...manifest.animations, idle: { row: 0, durations: [] } } }, { canvas })
broken.play('does-not-exist')
assert.equal(broken.animation?.name, 'idle', 'an unknown animation falls back to idle')

// ---- the gaze is applied once per frame ----------------------------------
//
// A trackpad produces pointer events far faster than the screen refreshes.
// Every one of them used to cost a forced layout and a redraw of the
// canvas, so they are folded into one per frame. Dragging the pet is
// where this matters most: the cursor sits on the pet, the direction
// barely changes, and the old code redrew the canvas for every event.

const listeners = new Map()
globalThis.document.addEventListener = (type, handler) => {
  if (!listeners.has(type)) listeners.set(type, [])
  listeners.get(type).push(handler)
}
let frames = []
globalThis.requestAnimationFrame = (callback) => {
  frames.push(callback)
  return frames.length
}
function fire(type, event) {
  for (const handler of listeners.get(type) || []) handler(event)
}
function runFrame() {
  const queued = frames
  frames = []
  for (const callback of queued) callback(0)
}

const tracker = new SpritePet(manifest, { canvas })
tracker.image = { width: 1536, height: 2288 }
tracker.play('idle', { loop: true })
tracker.attachPointer(document)

let trackerDraws = 0
tracker.draw = () => { trackerDraws += 1 }

for (let index = 0; index < 50; index += 1) {
  fire('pointermove', { clientX: centreX + 40, clientY: centreY - 30 })
}
assert.equal(trackerDraws, 0, 'a pointer event does not draw on its own')
assert.equal(tracker.lookFrame, null, 'the gaze waits for the frame')

runFrame()
assert.ok(tracker.lookFrame, 'the frame applies the gaze')
assert.equal(trackerDraws, 1, 'fifty pointer events cost one redraw')

// The direction has not changed, so the next batch costs nothing.
for (let index = 0; index < 50; index += 1) {
  fire('pointermove', { clientX: centreX + 40, clientY: centreY - 30 })
}
runFrame()
assert.equal(trackerDraws, 1, 'a gaze that did not change does not redraw')

// A gaze that was asked for but not applied yet must not come back after
// the cursor has left.
fire('pointermove', { clientX: centreX - 200, clientY: centreY + 200 })
tracker.lookOut()
runFrame()
assert.equal(tracker.lookFrame, null, 'a pending gaze is dropped when the cursor leaves')

// ---- the drag sends no messages at all -----------------------------------
//
// The native helper reads the real cursor position itself and moves the
// window on its own clock, so it does not need the page to report that
// the cursor moved. Every message the page sends is a trip through the
// web view for something the helper already knows.

const runtime = readFileSync(join(here, '..', 'runtime', 'pet-runtime.js'), 'utf8')
const sent = []
globalThis.document.documentElement = { style: {}, setPointerCapture() {} }
globalThis.window.webkit = {
  messageHandlers: {
    pet: { postMessage: (body) => sent.push(body.type) },
  },
}
// eslint-disable-next-line no-new-func
new Function(runtime)()

fire('pointerdown', { button: 0, pointerId: 1, preventDefault() {} })
assert.deepEqual(sent, ['down'], 'a press is reported once')

for (let index = 0; index < 50; index += 1) {
  fire('pointermove', { clientX: centreX + index, clientY: centreY, preventDefault() {} })
}
runFrame()
assert.deepEqual(sent, ['down'], 'fifty pointer events send nothing')

fire('pointerup', { preventDefault() {} })
assert.deepEqual(sent, ['down', 'up'], 'the release is reported')

// The helper can also point the pet at the cursor, which is the only way
// the gaze works when the pet is not the frontmost app.
let seenLook = null
globalThis.window.DSHPet.register({
  lookAt: (x, y) => { seenLook = { x, y } },
})
globalThis.window.DSHPet.look(12, 34)
assert.deepEqual(seenLook, { x: 12, y: 34 }, 'the helper can point the pet at the cursor')

console.log('sprite-pet engine: all checks passed')
