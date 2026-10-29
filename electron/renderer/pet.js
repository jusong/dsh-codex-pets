/**
 * The pet's page: draws the sprite, the ground shadow, the splash and the
 * session ball. Behaviour (which cell, when) is `core/player.mjs`; this file
 * only turns it into pixels and tells the main process what was clicked.
 */
import { wordsFor, workspaceLabel } from '../core/labels.mjs'
import { SpritePlayer, readManifest } from '../core/player.mjs'

const $ = (id) => document.getElementById(id)
const pet = $('pet')
const canvas = $('sprite')
const shadow = $('shadow')
const splash = $('splash')
const chrome = $('chrome')
const ball = $('ball')
const count = $('count')
const chevron = $('chevron')
const list = $('list')

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
document.body.dataset.motion = reduced ? '0' : '1'

let chinese = false
let player = null
let manifest = null
let atlas = null
let ctx = null

// -- sprite -----------------------------------------------------------------

function drawCell(row, column) {
  if (atlas === null || ctx === null) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(atlas, column * manifest.cellWidth, row * manifest.cellHeight, manifest.cellWidth, manifest.cellHeight, 0, 0, canvas.width, canvas.height)
}

function setShadow({ scale, opacity }) {
  shadow.style.setProperty('--shadow-scale', String(scale))
  shadow.style.setProperty('--shadow-opacity', String(opacity))
}

/** Particles that fly up from the pet's feet after a show. */
function showSplash(kind) {
  const sparkle = kind === 'sparkle'
  const color = sparkle ? 'rgb(255, 233, 168)' : 'rgb(143, 216, 255)'
  const added = []
  const width = pet.clientWidth
  const height = pet.clientHeight
  for (let index = 0; index < 20; index += 1) {
    const bit = document.createElement('div')
    bit.className = 'bit'
    bit.style.width = sparkle ? '6px' : '7px'
    bit.style.height = sparkle ? '6px' : '10px'
    bit.style.borderRadius = sparkle ? '2px' : '3.5px'
    bit.style.background = color
    bit.style.boxShadow = `0 0 ${sparkle ? 4 : 3}px ${color}`
    const startX = width * (0.5 + (Math.random() - 0.5) * 0.12)
    const startY = height * 0.8
    // Up, give or take 63 degrees either side.
    const angle = Math.PI / 2 + (Math.random() * 2.2 - 1.1)
    const distance = 16 + Math.random() * 44
    const dx = Math.cos(angle) * distance
    const dy = -Math.sin(angle) * distance
    bit.style.left = `${startX - 3}px`
    bit.style.top = `${startY - 3}px`
    const spin = sparkle ? ' rotate(180deg)' : ''
    bit.animate([
      { opacity: 0, transform: 'translate(0, 0) scale(.3)' },
      { opacity: 1, transform: `translate(${dx * 0.18}px, ${dy * 0.18}px) scale(1)`, offset: sparkle ? 0.2 : 0.15 },
      { opacity: 0, transform: `translate(${dx}px, ${dy}px) scale(.4)${spin}` },
    ], { duration: 850 + Math.random() * 250, delay: Math.random() * 100, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'both' })
    splash.appendChild(bit)
    added.push(bit)
  }
  if (!sparkle) {
    for (let index = 0; index < 2; index += 1) {
      const ripple = document.createElement('div')
      ripple.className = 'bit'
      ripple.style.cssText = ''
      ripple.style.width = '72px'
      ripple.style.height = '14px'
      ripple.style.left = `${width / 2 - 36}px`
      ripple.style.top = `${height * 0.84 - 7}px`
      ripple.style.border = `2px solid ${color}`
      ripple.style.borderRadius = '50%'
      ripple.style.boxSizing = 'border-box'
      ripple.animate([
        { opacity: 0.75, transform: 'scale(.4)' },
        { opacity: 0, transform: 'scale(1.9)' },
      ], { duration: 1050, delay: index * 160, easing: 'ease-out', fill: 'both' })
      splash.appendChild(ripple)
      added.push(ripple)
    }
  }
  setTimeout(() => added.forEach((node) => node.remove()), 1500)
}

// -- the clock ----------------------------------------------------------------

let last = performance.now()
function frame(now) {
  const delta = Math.min(100, now - last)
  last = now
  player?.tick(delta)
  requestAnimationFrame(frame)
}

// -- glide: the size eases towards what the slider says ------------------------

let target = 220
let shown = 220
let gliding = false
let glideClock = 0
const GLIDE_TAU = 0.05

function applyEdge() {
  document.documentElement.style.setProperty('--edge', `${shown}px`)
}

function glide(now) {
  const delta = Math.min(0.05, (now - glideClock) / 1000)
  glideClock = now
  // Exponential easing: quick to react, no overshoot, and a target that
  // moves mid-glide just changes where it is heading.
  const gap = target - shown
  shown = Math.abs(gap) < 0.25 ? target : shown + gap * (1 - Math.exp(-delta / GLIDE_TAU))
  applyEdge()
  if (shown === target) {
    gliding = false
    window.bridge.send('pet:glide-done')
    return
  }
  requestAnimationFrame(glide)
}

function setTarget(edge) {
  if (edge === target && !gliding && shown === target) return
  target = edge
  if (gliding) return
  gliding = true
  glideClock = performance.now()
  requestAnimationFrame(glide)
}

// -- the show -------------------------------------------------------------------

let performTimer = null
let pointerInside = false

function schedulePerformance(afterSeconds) {
  clearTimeout(performTimer)
  const wait = afterSeconds ?? 18 + Math.random() * 12
  performTimer = setTimeout(startPerformance, wait * 1000)
}

function startPerformance() {
  // Don't start a show under the cursor or in the hand.
  if (player.dragging || pointerInside) {
    schedulePerformance(6)
    return
  }
  const seconds = Math.max(0.5, Math.min(15, player.perform() / 1000))
  schedulePerformance(seconds + 18 + Math.random() * 12)
}

// -- session ball -----------------------------------------------------------------

let items = []
let view = { edge: 220, chrome: 0, expanded: false, chromeOn: false }
let motionOn = false
let previouslyRunning = new Set()
let renderedSignature = ''

function applySessionMotion() {
  if (!motionOn) {
    previouslyRunning = new Set()
    player?.setWorkRunning(false)
    return
  }
  const running = new Set(items.filter((item) => item.status === 'running').map((item) => item.id))
  const finished = [...previouslyRunning].filter((id) => !running.has(id))
  previouslyRunning = running
  if (finished.length > 0) player?.celebrateJumps(3)
  player?.setWorkRunning(running.size > 0)
}

function progressLabel() {
  const total = items.length
  if (total === 0) return ''
  const running = items.filter((item) => item.status === 'running').length
  return running === 0 ? String(total) : `${running}/${total}`
}

/** Fit the label inside the round ball. Wider text scales down; the ball does not grow. */
function showCount(label) {
  count.textContent = label
  count.style.setProperty('--count-scale', '1')
  const width = count.scrollWidth
  // Inside the 36px ball, clear of the 5px rim.
  const available = 22
  const scale = width > available ? available / width : 1
  if (scale < 1) count.style.setProperty('--count-scale', String(Math.round(scale * 1000) / 1000))
}

function renderChrome() {
  const strip = view.chrome > 0
  document.body.dataset.strip = strip ? '1' : '0'
  chrome.hidden = !strip
  if (!strip) {
    renderedSignature = ''
    return
  }
  chrome.style.height = `${view.chrome}px`
  const signature = `${view.expanded}|${items.map((i) => `${i.id}\u0001${i.status}\u0001${i.title}\u0001${i.workspace}`).join('\u0002')}`
  if (signature === renderedSignature) return
  renderedSignature = signature

  const words = wordsFor(chinese)
  const busy = items.some((item) => item.status === 'running')
  showCount(progressLabel())
  ball.className = busy ? 'busy' : ''
  chevron.hidden = true

  list.replaceChildren()
  list.hidden = !view.expanded || items.length === 0
  list.className = items.length === 1 ? 'single' : ''
  if (list.hidden) return
  for (const item of items) {
    const row = document.createElement('div')
    row.className = 'row'
    const running = item.status === 'running'
    const marker = document.createElement('div')
    marker.className = running ? 'spin' : 'dot'
    const title = document.createElement('div')
    title.className = 'title'
    title.textContent = item.title === '' ? words.untitled : item.title
    const state = document.createElement('div')
    state.className = 'state'
    const place = workspaceLabel(item.workspace, chinese)
    const status = running ? words.thinking : words.done
    state.textContent = place === '' ? status : `${status} · ${place}`
    row.append(marker, title, state)
    row.addEventListener('mousedown', () => window.bridge.send('pet:open', item.id))
    list.appendChild(row)
  }
}

ball.addEventListener('mousedown', () => window.bridge.send('pet:toggle'))
document.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  window.bridge.send('pet:contextmenu')
})

// -- from the main process ------------------------------------------------------------

window.bridge.on('pet:init', (init) => {
  chinese = init.chinese === true
  manifest = readManifest(init.manifest)
  atlas = new Image()
  atlas.onload = () => {
    canvas.width = manifest.cellWidth
    canvas.height = manifest.cellHeight
    ctx = canvas.getContext('2d')
    player = new SpritePlayer(manifest, { reducedMotion: reduced, onFrame: drawCell, onShadow: setShadow, onSplash: showSplash })
    applySessionMotion()
    schedulePerformance()
    requestAnimationFrame(frame)
  }
  atlas.src = init.atlasUrl
})

window.bridge.on('pet:view', (next) => {
  view = next
  setTarget(next.edge)
  renderChrome()
})

window.bridge.on('pet:sessions', ({ items: next }) => {
  items = Array.isArray(next) ? next : []
  applySessionMotion()
  renderChrome()
})

window.bridge.on('pet:motion', ({ on }) => {
  motionOn = on === true
  applySessionMotion()
})

window.bridge.on('pet:gaze', ({ degrees, inside }) => {
  pointerInside = inside === true
  if (player === null) return
  if (degrees === null) player.lookOut()
  else player.look(degrees)
})

window.bridge.on('pet:drag-begin', () => {
  // Keep the frame already on screen. Swapping sprites on the press is the blink.
  player?.holdForDrag()
  schedulePerformance(20)
})
window.bridge.on('pet:drag-dir', ({ right }) => player?.setDragDirection(right))
window.bridge.on('pet:drag-end', () => player?.endDrag())
window.bridge.on('pet:react', () => {
  player?.react()
  // A click puts the next show off.
  schedulePerformance(20)
})

window.bridge.send('pet:ready')
