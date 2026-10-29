/**
 * dsh-codex-pets: the pet window, as an Electron app.
 *
 * The DSH host plugin spawns this with the pet directory and its own pid,
 * talks to it in lines on stdin/stdout, and kills it on unload. Nothing in
 * here is compiled: it is the same plain JavaScript the rest of the plugin is.
 *
 * Why the pet drags smoothly: the pet is a native drag region. macOS moves
 * the window with the cursor by itself, so no script runs per mouse move and
 * a busy main process cannot make the pet lag. What the main process does
 * during a drag is only to read the cursor, to tell the pet which way it is
 * running.
 */
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, screen } from 'electron'
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { normalizeManifest, readImageSize } from '../lib/codex-pet.js'
import { createClickDecider } from './core/click.mjs'
import { wordsFor, workspaceLabel } from './core/labels.mjs'
import * as layout from './core/layout.mjs'
import { acquireLock } from './core/lock.mjs'
import { out, parseCommand } from './core/protocol.mjs'
import { toAccelerator } from './core/shortcut.mjs'
import { platformFor } from './platform/index.mjs'

const here = dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key.startsWith('--dsh-')) values[key.slice(6)] = argv[index + 1] ?? ''
  }
  return {
    petDir: values['pet-dir'] ?? '',
    state: values.state ?? '',
    lock: values.lock ?? '',
    dragLog: values['drag-log'] ?? '',
    size: layout.clampEdge(Number(values.size) || 220),
    shortcut: values.shortcut ?? 'Command+Option+N',
    parentPid: Number(values['parent-pid']) || 0,
    hostApp: values['host-app'] ?? '',
    userData: values['user-data'] ?? '',
  }
}

const args = parseArgs(process.argv.slice(2))
const adapter = platformFor()
if (adapter === null) {
  process.stderr.write(`dsh-codex-pets: no window adapter for ${process.platform}\n`)
  process.exit(2)
}

if (args.userData !== '') app.setPath('userData', args.userData)
app.setName('dsh-codex-pets')
// The pet is never the frontmost app, and its timers must keep their pace.
for (const name of ['disable-renderer-backgrounding', 'disable-background-timer-throttling', 'disable-backgrounding-occluded-windows']) {
  app.commandLine.appendSwitch(name)
}
adapter.prepare(app)

const chinese = () => (app.getPreferredSystemLanguages()[0] ?? '').startsWith('zh')
const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const monotonic = () => performance.now()

// -- the pet ----------------------------------------------------------------

function loadPet(dir) {
  const raw = JSON.parse(readFileSync(join(dir, 'pet.json'), 'utf8'))
  const sheet = typeof raw.spritesheetPath === 'string' ? raw.spritesheetPath : ''
  if (sheet === '' || basename(sheet) !== sheet) throw new Error('pet.json names no usable spritesheetPath')
  const atlasPath = join(dir, sheet)
  const fd = openSync(atlasPath, 'r')
  let atlas = null
  try {
    const head = Buffer.alloc(64)
    atlas = readImageSize(head.subarray(0, readSync(fd, head, 0, head.length, 0)))
  } finally {
    closeSync(fd)
  }
  return { manifest: normalizeManifest(raw, { id: basename(dir), atlas }), atlasUrl: pathToFileURL(atlasPath).href }
}

// -- state ------------------------------------------------------------------

let size = args.size
/** What the window was last laid out for: the pet's edge and the strip's height. */
let laid = { edge: size, chrome: 0 }
let chromeOn = false
let expanded = false
let sessions = []
let workspaces = []
let motionOn = false
let rendererGliding = false
let settleTimer = null
let rendererReady = false
let shownAt = 0
/** @type {BrowserWindow | null} */
let win = null
let release = null

const chromeNow = () => layout.chromeHeight({ chromeOn, count: sessions.length, expanded })
const toPet = (channel, payload) => {
  if (rendererReady && win !== null && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function visibleAreaAt(point) {
  return screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) }).workArea
}

/** The pet's centre on screen, from where the window was last laid out. */
function petCenterNow() {
  const bounds = win.getBounds()
  const slot = layout.petSlot(bounds.width, bounds.height, laid.edge, laid.chrome)
  return { x: bounds.x + slot.x + slot.width / 2, y: bounds.y + slot.y + slot.height / 2 }
}

function defaultCenter() {
  const area = screen.getPrimaryDisplay().workArea
  return { x: area.x + area.width - 24 - size / 2, y: area.y + area.height - 200 - size / 2 }
}

function readCenter() {
  if (args.state === '') return null
  try {
    const saved = JSON.parse(readFileSync(args.state, 'utf8'))
    let center = null
    if (saved.v === 2 && finite(saved.cx) && finite(saved.cy)) {
      center = { x: saved.cx, y: saved.cy }
    } else if (finite(saved.x) && finite(saved.y)) {
      // Older versions saved the Cocoa origin of the window: y up from the
      // bottom of the main screen.
      center = { x: saved.x + size / 2, y: screen.getPrimaryDisplay().bounds.height - saved.y - size / 2 }
    }
    if (center === null) return null
    const box = { x: center.x - size / 2, y: center.y - size / 2, width: size, height: size }
    return layout.onSomeScreen(box, screen.getAllDisplays().map((d) => d.workArea)) ? center : null
  } catch {
    return null
  }
}

function saveCenter() {
  if (args.state === '' || win === null || win.isDestroyed()) return
  const center = petCenterNow()
  try {
    writeFileSync(args.state, JSON.stringify({ v: 2, cx: Math.round(center.x), cy: Math.round(center.y) }))
  } catch {}
}

// -- window layout ----------------------------------------------------------

function sendView() {
  toPet('pet:view', { edge: size, chrome: laid.chrome, expanded, chromeOn })
}

/**
 * Put the window where it belongs for the pet's current centre.
 * `reserved` is how much room the pet is given (the largest size while a
 * resize is gliding, the real size once it has settled); `drawn` is the size
 * it is drawn at inside that room. `keepOnScreen` is off while reserving, so
 * making room never nudges the pet.
 */
function place({ reserved, drawn, keepOnScreen }) {
  const center = petCenterNow()
  const chrome = chromeNow()
  const bounds = layout.placeWindow({
    center,
    size: layout.windowSize(reserved, chrome),
    drawnEdge: drawn,
    chrome,
    visible: keepOnScreen ? visibleAreaAt(center) : null,
  })
  win.setBounds(bounds)
  laid = { edge: drawn, chrome }
  sendView()
}

function relayoutSettled() {
  settleTimer = null
  if (win === null || win.isDestroyed()) return
  rendererGliding = false
  place({ reserved: size, drawn: size, keepOnScreen: true })
  saveCenter()
}

/** The strip changed. Fit the window now, unless the size is still easing. */
function relayout() {
  if (rendererGliding) {
    sendView()
    return
  }
  relayoutSettled()
}

/**
 * Change the pet's size, keeping its centre where it is.
 *
 * Resizing the window itself is what flashed: every setBounds makes the
 * window server rebuild the backing store of a transparent window. So while
 * the size is in motion the window is opened up to its largest once and
 * stays there, and the pet is only an element inside it, eased towards each
 * new size by the page. When the slider rests, the window is fitted to the
 * pet in a single step that changes nothing on screen.
 */
function resize(requested) {
  const edge = layout.clampEdge(requested)
  if (edge === size || win === null) return
  if (!rendererGliding) {
    place({ reserved: layout.MAX_EDGE, drawn: laid.edge, keepOnScreen: false })
    rendererGliding = true
  }
  size = edge
  if (settleTimer !== null) clearTimeout(settleTimer)
  settleTimer = null
  sendView()
}

// -- click or drag -----------------------------------------------------------

const decider = createClickDecider({
  now: monotonic,
  guard: () => {
    if (win === null || monotonic() - shownAt < 1500) return false
    if (askVisible() || monotonic() - askClosedAt < 600) return false
    const cursor = screen.getCursorScreenPoint()
    const bounds = win.getBounds()
    return cursor.x >= bounds.x && cursor.x < bounds.x + bounds.width && cursor.y >= bounds.y && cursor.y < bounds.y + bounds.height
  },
  onDecision: (kind) => {
    if (win === null || win.isDestroyed()) return
    if (kind === 'click') {
      process.stdout.write(out.activate())
      toPet('pet:react')
    }
    // The press made the panel key. Give the keyboard back.
    win.blur()
  },
})

// -- drag ---------------------------------------------------------------------

let dragging = false
let dragTimer = null
let dragStart = 0
let lastMoved = 0
let moves = 0
let lastCursor = { x: 0, y: 0 }
let lastSideways = 0
let dragDirection = null
let lastBeat = 0
let worstBlock = 0
let worstMoveGap = 0

function beginDrag() {
  if (dragging) return
  dragging = true
  dragStart = monotonic()
  lastMoved = dragStart
  moves = 0
  worstMoveGap = 0
  worstBlock = 0
  lastBeat = dragStart
  dragDirection = null
  lastSideways = 0
  lastCursor = screen.getCursorScreenPoint()
  toPet('pet:drag-begin')
  dragTimer = setInterval(pollDrag, 16)
}

function noteMoved() {
  const now = monotonic()
  if (!dragging) beginDrag()
  if (moves > 0) worstMoveGap = Math.max(worstMoveGap, now - lastMoved)
  lastMoved = now
  moves += 1
}

/** Which way the cursor goes tells the pet which way to run. */
function pollDrag() {
  const now = monotonic()
  worstBlock = Math.max(worstBlock, now - lastBeat)
  lastBeat = now
  const cursor = screen.getCursorScreenPoint()
  const dx = cursor.x - lastCursor.x
  lastCursor = cursor
  // 2px a tick (120px/s) keeps a mostly vertical drag from flipping the pet on every wobble.
  if (Math.abs(dx) >= 2) {
    lastSideways = now
    const right = dx > 0
    if (dragDirection !== right) {
      dragDirection = right
      toPet('pet:drag-dir', { right })
    }
  } else if (dragDirection !== null && now - lastSideways > 200) {
    dragDirection = null
    toPet('pet:drag-dir', { right: null })
  }
  if (now - lastMoved > 300) endDrag()
}

function endDrag() {
  if (!dragging) return
  dragging = false
  clearInterval(dragTimer)
  dragTimer = null
  toPet('pet:drag-end')
  saveCenter()
  writeDragLog()
}

/** A line about the drag, so "does it follow?" has numbers. */
function writeDragLog() {
  if (args.dragLog === '') return
  const round = (value) => Math.round(value * 10) / 10
  const line = JSON.stringify({
    at: Date.now() / 1000,
    mover: 'window-server',
    runtime: 'electron',
    moves,
    dragMs: round(lastMoved - dragStart),
    worstMoveGapMs: round(worstMoveGap),
    worstMainBlockMs: round(Math.max(0, worstBlock - 16)),
  })
  try {
    // A note of the last few drags, not a history of every drag ever.
    if (existsSync(args.dragLog) && statSync(args.dragLog).size > 32_768) rmSync(args.dragLog)
    appendFileSync(args.dragLog, `${line}\n`)
  } catch {}
}

// -- gaze -----------------------------------------------------------------------

let lastGaze = null

/** Point the pet at the cursor, if the cursor is close enough. Read here: a floating pet is never frontmost, so the page gets no mouse-moved events. */
function updateGaze() {
  if (win === null || win.isDestroyed() || dragging) return
  const mouse = screen.getCursorScreenPoint()
  const bounds = win.getBounds()
  const slot = layout.petSlot(bounds.width, bounds.height, laid.edge, laid.chrome)
  // Measured from the pet's eyes, a little above the middle.
  const dx = (mouse.x - bounds.x) - (slot.x + slot.width / 2)
  const dy = (mouse.y - bounds.y) - (slot.y + slot.height * 0.42)
  const inside = mouse.x >= bounds.x && mouse.x < bounds.x + bounds.width && mouse.y >= bounds.y && mouse.y < bounds.y + bounds.height
  let degrees = null
  if (Math.hypot(dx, dy) <= size * 1.4) degrees = Math.round(Math.atan2(dx, -dy) * 1800 / Math.PI) / 10
  const key = `${degrees}|${inside}`
  if (key === lastGaze) return
  lastGaze = key
  toPet('pet:gaze', { degrees, inside })
}

// -- menu -----------------------------------------------------------------------

function showMenu() {
  if (win === null) return
  const words = wordsFor(chinese())
  const choices = workspaces.length === 0
    ? [{ label: words.noWorkspaces, enabled: false }]
    : workspaces.map((item) => ({
      label: workspaceLabel(item.title === '' ? item.id : item.title, chinese()),
      click: () => showAsk(item.id, workspaceLabel(item.title === '' ? item.id : item.title, chinese())),
    }))
  Menu.buildFromTemplate([
    { label: words.newSession, submenu: choices },
    {
      label: words.settings,
      click: () => {
        adapter.activateHost({ hostApp: args.hostApp })
        process.stdout.write(out.settings())
      },
    },
    { label: words.hidePet, click: () => process.stdout.write(out.hide()) },
  ]).popup({ window: win })
}

// -- the question card ------------------------------------------------------------

/** @type {BrowserWindow | null} */
let askWin = null
let askWorkspaceId = null
let askMenuOpen = false
let askClosedAt = 0
let askReady = false
let askPending = null

const askVisible = () => askWin !== null && !askWin.isDestroyed() && askWin.isVisible()

function ensureAsk() {
  if (askWin !== null && !askWin.isDestroyed()) return askWin
  askReady = false
  askWin = new BrowserWindow({
    width: 360,
    height: 72,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    ...adapter.windowOptions,
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true },
  })
  adapter.float(askWin, app)
  askWin.on('blur', () => {
    if (!askMenuOpen) hideAsk()
  })
  askWin.loadFile(join(here, 'renderer', 'ask.html'))
  return askWin
}

function showAsk(workspaceId, title) {
  if (win === null) return
  askWorkspaceId = workspaceId
  const card = ensureAsk()
  const pet = layout.petOnScreen(win.getBounds(), laid.edge, laid.chrome)
  const origin = layout.askDialogOrigin(pet, { width: 360, height: 72 }, visibleAreaAt({ x: pet.x + pet.width / 2, y: pet.y + pet.height / 2 }))
  card.setPosition(origin.x, origin.y)
  const payload = { title, chinese: chinese() }
  if (askReady) card.webContents.send('ask:show', payload)
  else askPending = payload
  card.show()
  card.focus()
  app.focus({ steal: true })
}

function hideAsk() {
  if (askWin === null || askWin.isDestroyed() || !askWin.isVisible()) return
  askWorkspaceId = null
  askClosedAt = monotonic()
  askWin.hide()
}

ipcMain.on('ask:ready', (event) => {
  if (askWin === null || event.sender !== askWin.webContents) return
  askReady = true
  if (askPending !== null) {
    askWin.webContents.send('ask:show', askPending)
    askPending = null
  }
})

ipcMain.on('ask:submit', (event, payload) => {
  if (askWin === null || event.sender !== askWin.webContents) return
  const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
  if (askWorkspaceId === null || text === '') return
  process.stdout.write(out.ask(askWorkspaceId, text))
  hideAsk()
})

ipcMain.on('ask:cancel', (event) => {
  if (askWin !== null && event.sender === askWin.webContents) hideAsk()
})

/** Clicking the workspace name opens a menu of the others, without leaving the card. */
ipcMain.on('ask:pick', (event, payload) => {
  if (askWin === null || event.sender !== askWin.webContents || workspaces.length === 0) return
  askMenuOpen = true
  const menu = Menu.buildFromTemplate(workspaces.map((item) => {
    const label = workspaceLabel(item.title === '' ? item.id : item.title, chinese())
    return {
      label,
      type: 'radio',
      checked: item.id === askWorkspaceId,
      click: () => {
        askWorkspaceId = item.id
        askWin?.webContents.send('ask:workspace', { title: label })
      },
    }
  }))
  menu.popup({
    window: askWin,
    x: Math.round(Number(payload?.x) || 0),
    y: Math.round(Number(payload?.y) || 0),
    callback: () => {
      setTimeout(() => {
        askMenuOpen = false
        if (askWin !== null && !askWin.isDestroyed() && askWin.isVisible()) {
          askWin.focus()
          askWin.webContents.focus()
        }
      }, 50)
    },
  })
})

function openDefaultAsk() {
  const item = workspaces.find((entry) => entry.title === 'default-workspace') ?? workspaces[0]
  if (item === undefined) return
  showAsk(item.id, workspaceLabel(item.title === '' ? item.id : item.title, chinese()))
}

// -- the global shortcut ----------------------------------------------------------

let registered = null

function setShortcut(value) {
  if (registered !== null) globalShortcut.unregister(registered)
  registered = null
  const accelerator = toAccelerator(value)
  if (accelerator === null) return
  try {
    if (globalShortcut.register(accelerator, openDefaultAsk)) registered = accelerator
  } catch {}
}

// -- the host's commands -------------------------------------------------------------

function handleCommand(line) {
  const command = parseCommand(line)
  if (command === null) return
  switch (command.type) {
    case 'activate':
      adapter.activateHost({ hostApp: args.hostApp })
      break
    case 'size':
      resize(command.value)
      break
    case 'motion':
      motionOn = command.on
      toPet('pet:motion', { on: motionOn })
      break
    case 'chrome':
      if (chromeOn === command.on) break
      chromeOn = command.on
      if (!chromeOn) expanded = false
      relayout()
      break
    case 'shortcut':
      setShortcut(command.value)
      break
    case 'workspaces':
      workspaces = command.items
      break
    case 'sessions':
      sessions = command.items
      if (sessions.length === 0) expanded = false
      toPet('pet:sessions', { items: sessions })
      relayout()
      break
    default:
      break
  }
}

function watchStdin() {
  let pending = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    pending += chunk
    let newline = pending.indexOf('\n')
    while (newline !== -1) {
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      handleCommand(line)
      newline = pending.indexOf('\n')
    }
  })
  // The host went away: nobody is left to talk to.
  process.stdin.on('end', () => app.quit())
  process.stdin.on('error', () => {})
  process.stdin.resume()
}

function watchParent() {
  if (args.parentPid <= 0) return
  setInterval(() => {
    try {
      process.kill(args.parentPid, 0)
    } catch (error) {
      if (error?.code === 'ESRCH') app.quit()
    }
  }, 1000)
}

// -- start -----------------------------------------------------------------------------

function createPetWindow(pet) {
  const center = readCenter() ?? defaultCenter()
  const bounds = layout.placeWindow({
    center,
    size: layout.windowSize(size, 0),
    drawnEdge: size,
    chrome: 0,
    visible: visibleAreaAt(center),
  })
  win = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    // A rounded mask paints one opaque frame the first time the window moves.
    roundedCorners: false,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    ...adapter.windowOptions,
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  })
  laid = { edge: size, chrome: 0 }
  adapter.float(win, app)

  // Becoming key, or the first move, otherwise swaps in an opaque backing
  // store for one frame. Pin the clear colour again on those transitions.
  const pinClear = () => {
    if (win === null || win.isDestroyed()) return
    win.setBackgroundColor('#00000000')
    win.setHasShadow(false)
  }
  win.on('will-move', () => {
    if (!dragging) pinClear()
    decider.willMove()
    noteMoved()
  })
  win.on('moved', noteMoved)
  win.on('focus', () => {
    pinClear()
    decider.focus()
  })
  win.on('blur', pinClear)
  // A press the page saw is not a click on the pet; a press on the drag region never reaches the page.
  win.webContents.on('before-mouse-event', (_event, mouse) => {
    if (mouse.type === 'mouseDown') decider.pagePress()
  })
  win.webContents.on('render-process-gone', () => {
    rendererReady = false
    win.reload()
  })

  ipcMain.on('pet:ready', (event) => {
    if (win === null || event.sender !== win.webContents) return
    rendererReady = true
    toPet('pet:init', { ...pet, chinese: chinese() })
    sendView()
    toPet('pet:sessions', { items: sessions })
    toPet('pet:motion', { on: motionOn })
    if (!win.isVisible()) {
      // Build the transparent surface while the window is still hidden.
      // Doing this after it is on screen is the flash.
      const bounds = win.getBounds()
      win.setBounds({ ...bounds, x: bounds.x + 1 })
      win.setBounds(bounds)
      win.setBackgroundColor('#00000000')
      win.setHasShadow(false)
      win.showInactive()
      shownAt = monotonic()
      adapter.float(win, app)
    }
  })
  ipcMain.on('pet:contextmenu', (event) => {
    if (win !== null && event.sender === win.webContents) showMenu()
  })
  ipcMain.on('pet:toggle', (event) => {
    if (win === null || event.sender !== win.webContents) return
    expanded = !expanded
    relayout()
  })
  ipcMain.on('pet:open', (event, id) => {
    if (win === null || event.sender !== win.webContents || typeof id !== 'string') return
    expanded = false
    relayout()
    process.stdout.write(out.open(id))
  })
  ipcMain.on('pet:glide-done', (event) => {
    if (win === null || event.sender !== win.webContents || !rendererGliding || settleTimer !== null) return
    settleTimer = setTimeout(relayoutSettled, 250)
  })

  win.loadFile(join(here, 'renderer', 'index.html'))
}

function cleanup() {
  globalShortcut.unregisterAll()
  release?.()
  release = null
}

process.on('SIGTERM', () => {
  cleanup()
  app.exit(0)
})
process.on('SIGINT', () => {
  cleanup()
  app.exit(0)
})
app.on('window-all-closed', () => {})
app.on('will-quit', cleanup)

// Not a top-level await: Electron holds `ready` back until the main module has
// finished evaluating, so waiting for it here would wait forever.
async function boot() {
  // Edit shortcuts (copy, paste) work through the menu bar, and the question field needs them.
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'editMenu' }]))

  if (args.lock !== '') {
    release = await acquireLock(args.lock)
    if (release === null) {
      app.exit(0)
      return
    }
  }
  let pet
  try {
    pet = loadPet(args.petDir)
  } catch (error) {
    process.stderr.write(`dsh-codex-pets: no usable pet in ${args.petDir}: ${error.message}\n`)
    app.exit(1)
    return
  }
  if (args.state !== '') mkdirSync(dirname(args.state), { recursive: true })
  createPetWindow(pet)
  setShortcut(args.shortcut)
  setInterval(updateGaze, 33)
  watchParent()
  watchStdin()
}
app.whenReady().then(boot).catch((error) => {
  process.stderr.write(`dsh-codex-pets: start failed: ${error?.stack ?? error}\n`)
  app.exit(1)
})
