/**
 * The window's pure logic: wire protocol, layout, shortcut, click-or-drag,
 * and the sprite player. No Electron needed.
 *
 *   node tools/test-electron-core.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeManifest } from '../lib/codex-pet.js'
import { createClickDecider } from '../electron/core/click.mjs'
import * as layout from '../electron/core/layout.mjs'
import { acquireLock } from '../electron/core/lock.mjs'
import { SpritePlayer, readManifest } from '../electron/core/player.mjs'
import { out, parseCommand } from '../electron/core/protocol.mjs'
import { toAccelerator } from '../electron/core/shortcut.mjs'

let checks = 0
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks += 1
}
const ok = (condition, message) => {
  assert.ok(condition, message)
  checks += 1
}

// -- protocol -------------------------------------------------------------
eq(parseCommand('activate'), { type: 'activate' }, 'activate')
eq(parseCommand('size 120'), { type: 'size', value: 120 }, 'size')
eq(parseCommand('size abc'), null, 'bad size')
eq(parseCommand('motion on'), { type: 'motion', on: true }, 'motion on')
eq(parseCommand('chrome off'), { type: 'chrome', on: false }, 'chrome off')
eq(parseCommand('shortcut "Command+Option+N"'), { type: 'shortcut', value: 'Command+Option+N' }, 'shortcut')
eq(parseCommand('shortcut ""'), { type: 'shortcut', value: '' }, 'empty shortcut clears')
eq(parseCommand('shortcut 12'), null, 'a non-string shortcut is ignored')
eq(parseCommand('sessions []'), { type: 'sessions', items: [] }, 'no sessions')
eq(
  parseCommand('sessions [{"id":"s1","title":"Hi","status":"running","workspace":"w"},{"id":"bad id"},{"id":""},5]'),
  { type: 'sessions', items: [{ id: 's1', title: 'Hi', status: 'running', workspace: 'w' }] },
  'sessions keep valid rows only',
)
eq(
  parseCommand('workspaces [{"id":"w1","title":"A\\nB"}]'),
  { type: 'workspaces', items: [{ id: 'w1', title: 'A B' }] },
  'workspace titles lose line breaks',
)
eq(parseCommand('sessions {'), null, 'broken json')
eq(parseCommand('nonsense'), null, 'unknown line')
eq(out.open('s1'), 'open s1\n', 'open line')
eq(out.ask('w1', 'hi'), 'ask {"workspaceId":"w1","text":"hi"}\n', 'ask line')

// -- layout ---------------------------------------------------------------
eq(layout.chromeHeight({ chromeOn: false, count: 3, expanded: true }), 0, 'chrome off')
eq(layout.chromeHeight({ chromeOn: true, count: 0, expanded: false }), 0, 'no sessions')
eq(layout.chromeHeight({ chromeOn: true, count: 3, expanded: false }), 52, 'folded strip')
eq(layout.chromeHeight({ chromeOn: true, count: 3, expanded: true }), 6 + 36 + 8 + 48 * 3 + 10, 'open strip')
eq(layout.windowSize(100, 0), { width: 100, height: 100 }, 'window = pet without a strip')
eq(layout.windowSize(100, 52), { width: 316, height: 152 }, 'a strip widens the window')
eq(layout.petSlot(100, 100, 100, 0), { x: 0, y: 0, width: 100, height: 100 }, 'centred')
eq(layout.petSlot(260, 260, 100, 0), { x: 80, y: 80, width: 100, height: 100 }, 'centred in a bigger window')
eq(layout.petSlot(316, 152, 100, 52), { x: 108, y: 0, width: 100, height: 100 }, 'pinned to the top with a strip')
eq(layout.clampEdge(10), 80, 'clamp low')
eq(layout.clampEdge(999), 260, 'clamp high')
{
  const visible = { x: 0, y: 0, width: 1000, height: 800 }
  const a = layout.placeWindow({ center: { x: 500, y: 400 }, size: { width: 260, height: 260 }, drawnEdge: 100, chrome: 0, visible })
  eq(a, { x: 370, y: 270, width: 260, height: 260 }, 'window keeps the pet centre')
  const b = layout.placeWindow({ center: { x: 500, y: 400 }, size: { width: 100, height: 100 }, drawnEdge: 100, chrome: 0, visible })
  eq({ x: b.x + 50, y: b.y + 50 }, { x: 500, y: 400 }, 'fitting the window changes nothing on screen')
  const c = layout.placeWindow({ center: { x: 990, y: 790 }, size: { width: 100, height: 100 }, drawnEdge: 100, chrome: 0, visible })
  eq({ x: c.x, y: c.y }, { x: 900, y: 700 }, 'kept inside the screen')
  const d = layout.placeWindow({ center: { x: 500, y: 400 }, size: { width: 316, height: 152 }, drawnEdge: 100, chrome: 52, visible })
  eq({ cx: d.x + 108 + 50, cy: d.y + 50 }, { cx: 500, cy: 400 }, 'with a strip the pet stays put')
  eq(
    layout.askDialogOrigin({ x: 100, y: 300, width: 100, height: 100 }, { width: 360, height: 72 }, visible),
    { x: 212, y: 314 }, 'question card to the right of the pet',
  )
  eq(
    layout.askDialogOrigin({ x: 850, y: 300, width: 100, height: 100 }, { width: 360, height: 72 }, visible),
    { x: 478, y: 314 }, 'flips to the left near the edge',
  )
  ok(layout.onSomeScreen({ x: 10, y: 10, width: 50, height: 50 }, [visible]), 'on screen')
  ok(!layout.onSomeScreen({ x: 5000, y: 10, width: 50, height: 50 }, [visible]), 'off screen')
}

// -- shortcut -------------------------------------------------------------
eq(toAccelerator('Command+Option+N'), 'Command+Alt+N', 'default shortcut')
eq(toAccelerator('⌘⌥N'), 'Command+Alt+N', 'symbols')
eq(toAccelerator('Control+Shift+Space'), 'Control+Shift+Space', 'space')
eq(toAccelerator('Command+Shift+F5'), 'Command+Shift+F5', 'function key')
eq(toAccelerator('Command+N'), null, 'one modifier is not enough')
eq(toAccelerator('N'), null, 'a bare key')
eq(toAccelerator('Command+Option'), null, 'no key')
eq(toAccelerator('Command+Option+N+M'), null, 'two keys')
eq(toAccelerator(''), null, 'empty')
eq(toAccelerator(null), null, 'not a string')

// -- click or drag --------------------------------------------------------
{
  let clock = 1000
  const timers = []
  const decisions = []
  const decider = createClickDecider({
    now: () => clock,
    setTimer: (fn, ms) => { timers.push({ fn, at: clock + ms }); return timers.length },
    clearTimer: (id) => { if (timers[id - 1]) timers[id - 1].fn = null },
    onDecision: (kind) => decisions.push(kind),
  })
  const advance = (ms) => {
    clock += ms
    for (const timer of timers) {
      if (timer.fn !== null && timer.at <= clock) {
        const fn = timer.fn
        timer.fn = null
        fn()
      }
    }
  }
  decider.focus(); advance(200)
  eq(decisions.at(-1), 'click', 'a bare focus is a click')
  decider.focus(); advance(55); decider.willMove(); advance(200)
  eq(decisions.at(-1), 'drag', 'will-move after focus is a drag (the measured case)')
  advance(1000); decider.willMove(); advance(22); decider.focus(); advance(200)
  eq(decisions.at(-1), 'drag', 'will-move just before focus is a drag too (the case the probe got wrong)')
  advance(1000); decider.focus(); advance(40); decider.pagePress(); advance(200)
  eq(decisions.at(-1), 'ignored', 'a press the page saw is not a click on the pet')
  advance(1000); decider.pagePress(); advance(20); decider.focus(); advance(200)
  eq(decisions.at(-1), 'ignored', 'also when the page saw it first')
  advance(2000); decider.focus(); advance(200)
  eq(decisions.at(-1), 'click', 'old events do not leak into the next press')
  const guarded = []
  const g = createClickDecider({ now: () => clock, setTimer: (fn) => { fn(); return 0 }, guard: () => false, onDecision: (k) => guarded.push(k) })
  g.focus()
  eq(guarded, ['ignored'], 'a focus the guard rejects is ignored')
}

// -- lock -----------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lock-test-'))
  try {
    const file = join(dir, 'pet.pid')
    const release = await acquireLock(file, { waitMs: 200 })
    ok(typeof release === 'function', 'first window gets the lock')
    eq(await acquireLock(file, { waitMs: 250, pid: 4242 }), null, 'a second window waits, then gives up')
    release()
    ok(typeof (await acquireLock(file, { waitMs: 200 })) === 'function', 'free after release')
    writeFileSync(file, '99999999')
    ok(typeof (await acquireLock(file, { waitMs: 200 })) === 'function', 'a dead owner is taken over')
    writeFileSync(file, '')
    ok(typeof (await acquireLock(file, { waitMs: 200 })) === 'function', 'the empty lock file of the old helper is taken over')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// -- the player -----------------------------------------------------------
const v2 = readManifest(normalizeManifest({ spritesheetPath: 'sheet.webp', spriteVersionNumber: 2 }, { id: 't' }))
const v1 = readManifest(normalizeManifest({ spritesheetPath: 'sheet.webp' }, { id: 't' }))
eq(v2.rows, 11, 'v2 atlas has 11 rows')
eq(v2.lookRows, [9, 10], 'v2 pets can look around')
eq(v1.lookRows, [], 'v1 pets cannot')
eq(v1.animations.get('running-right').row, 1, 'contract row for running-right')
eq(v1.splash, 'sparkle', 'default splash')

function makePlayer(manifest = v2, extra = {}) {
  const frames = []
  const shadows = []
  const splashes = []
  const player = new SpritePlayer(manifest, {
    random: () => 0,
    onFrame: (row, column) => frames.push([row, column]),
    onShadow: (shadow) => shadows.push(shadow),
    onSplash: (kind) => splashes.push(kind),
    ...extra,
  })
  const run = (ms, step = 10) => { for (let t = 0; t < ms; t += step) player.tick(step) }
  return { player, frames, shadows, splashes, run }
}

{
  const { player, frames, run } = makePlayer()
  eq(frames[0], [0, 0], 'starts on the first idle frame')
  run(300)
  ok(frames.some(([row, column]) => row === 0 && column === 1), 'idle plays through its frames')
  player.react()
  eq(frames.at(-1)[0], 4, 'a click plays the jumping row')
  ok(player.reacting, 'reacting while it plays')
  run(1000)
  ok(!player.reacting, 'reaction ends')
  eq(frames.at(-1)[0], 0, 'and the pet is back in idle')
}
{
  const { player, frames, run } = makePlayer()
  player.setDragDirection(true)
  eq(frames.at(-1)[0], 1, 'drag right runs in row 1')
  player.setDragDirection(false)
  eq(frames.at(-1)[0], 2, 'drag left runs in row 2')
  run(100)
  ok(player.dragging, 'dragging')
  player.setDragDirection(null)
  ok(!player.dragging, 'not dragging after standing still')
  player.setDragDirection(true)
  player.endDrag()
  ok(!player.dragging, 'endDrag stops the run')
  eq(frames.at(-1)[0], 0, 'and goes back to idle')
}
{
  const { player, frames, run } = makePlayer()
  player.look(0)
  const held = frames.at(-1)
  eq(held[0], 9, 'the pet is looking')
  player.holdForDrag()
  run(80)
  eq(frames.at(-1), held, 'the press that starts a drag does not swap the picture')
  player.setDragDirection(true)
  eq(frames.at(-1)[0], 1, 'then a direction starts the run')
}
{
  // Idle turns: with the random source pinned to 0, the first turn comes after idleMin.
  const { player, frames, run } = makePlayer()
  run(player.manifest.idleMin + 50)
  ok(frames.some(([row]) => row === 6), 'after a while the pet takes an idle turn (waiting row)')
}
{
  const { player, frames, run } = makePlayer()
  player.setWorkRunning(true)
  eq(frames.at(-1)[0], 1, 'working pets run in the drag-right row')
  run(player.manifest.idleMax + 500)
  ok(frames.every(([row], index) => index === 0 || row === 1 || row === 0), 'a working pet does not take idle turns')
  player.look(90)
  eq(frames.at(-1)[0], 1, 'a working pet does not stare at the cursor')
  player.setWorkRunning(false)
  eq(frames.at(-1)[0], 0, 'back to idle when the work is done')
}
{
  const { player, frames, run } = makePlayer()
  player.celebrateJumps(3)
  ok(player.performing, 'celebrating')
  eq(frames.at(-1)[0], 4, 'jumps')
  const total = player.manifest.animations.get('jumping').total
  run(total * 3 + 200)
  ok(!player.performing, 'three jumps end')
  eq(frames.at(-1)[0], 0, 'then idle')
}
{
  const { player, frames, splashes, shadows, run } = makePlayer()
  const length = player.perform()
  const expected = player.manifest.animations.get('jumping').total + player.manifest.animations.get('waving').total
  eq(length, expected, 'the show is a jump and a wave')
  eq(shadows.at(-1).scale, 0.72, 'the shadow shrinks while jumping')
  run(length + 200)
  eq(splashes, ['sparkle'], 'the show ends with a splash')
  ok(!player.performing, 'show over')
  ok(frames.some(([row]) => row === 3), 'it waved')
}
{
  const { player, frames } = makePlayer()
  player.look(0)
  eq(frames.at(-1), [9, 0], 'straight up is the first look frame')
  player.look(90)
  eq(frames.at(-1), [9, 4], 'right is four steps round')
  player.look(180)
  eq(frames.at(-1), [10, 0], 'down is on the second look row')
  player.look(-90)
  eq(frames.at(-1), [10, 4], 'left wraps around')
  player.lookOut()
  eq(frames.at(-1), [0, 0], 'looking away returns to idle')
  player.react()
  player.look(90)
  eq(frames.at(-1)[0], 4, 'a reaction outranks the gaze')
}
{
  const { player, frames } = makePlayer(v1)
  player.look(90)
  ok(frames.every(([row]) => row < 9), 'a v1 pet never looks')
}
{
  const { player, frames, run } = makePlayer(v2, { reducedMotion: true })
  run(2000)
  eq(frames, [[0, 0]], 'reduced motion shows one still frame')
  eq(player.perform() > 0, true, 'the show can still be asked for')
  player.celebrateJumps(3)
  run(200)
  eq(frames.at(-1), [0, 0], 'and stays still')
}
{
  const { player } = makePlayer()
  player.play('no-such-animation', false)
  ok(player.animation?.animation.name === 'idle', 'an unknown animation falls back to idle')
}

console.log(`electron core: ${checks} checks passed`)
