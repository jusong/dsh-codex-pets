/** The question card. Return or the blue arrow submits; Escape closes it; the workspace name switches it. Pasted pictures stack above the field. */
import { wordsFor } from '../core/labels.mjs'

const card = document.getElementById('card')
const shots = document.getElementById('shots')
const field = document.getElementById('field')
const chip = document.getElementById('chip')
const chipText = document.getElementById('chipText')
const send = document.getElementById('send')
const preview = document.getElementById('preview')
const previewShot = document.getElementById('previewShot')

/** The picture types the prompt accepts, and the most the card will put on the wire. */
const IMAGE_TYPE = /^image\/(?:png|jpeg|webp|gif)$/
// ponytail: six pictures of 10 MB. A paste past either ceiling is dropped
// instead of sent; a size warning is the upgrade if it ever bites.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_IMAGES = 6
/** The card is this wide; enlarging one borrows a bigger window. */
const WIDTH = 360
const PREVIEW = { width: 520, height: 420 }

/** Pasted pictures, oldest first: `{ mediaType, data, url }`. */
let images = []
/** The picture shown full size, or null. */
let enlarged = null
let lastSize = ''

/** The window hugs the card, so the page reports its own height; an unchanged size is not sent. */
function resize() {
  if (enlarged !== null) {
    report(PREVIEW, false)
    return
  }
  // Measure at the width the card will have, not the one the enlarged picture borrowed,
  // or six thumbnails would report the height of a single row.
  card.style.width = `${WIDTH}px`
  report({ width: WIDTH, height: Math.ceil(card.getBoundingClientRect().height) }, true)
}

/** `card` marks the size the card returns to, so the next show opens at it rather than at the preview's. */
function report(size, card) {
  const key = `${size.width}x${size.height}`
  if (key === lastSize) return
  lastSize = key
  window.bridge.send('ask:size', { ...size, card })
}

function remove(image) {
  images = images.filter((item) => item !== image)
  render()
}

function enlarge(image) {
  enlarged = image
  previewShot.src = image.url
  preview.hidden = false
  card.hidden = true
  // The field must not eat Return while the picture is in the way.
  field.blur()
  resize()
}

function closePreview() {
  if (enlarged === null) return
  enlarged = null
  preview.hidden = true
  previewShot.removeAttribute('src')
  card.hidden = false
  resize()
  field.focus()
}

/** Redrawn whole from `images`, so a removal cannot leave a stale thumbnail behind. */
function render() {
  shots.replaceChildren(...images.map((image) => {
    const box = document.createElement('div')
    box.className = 'shot'
    const thumb = document.createElement('img')
    thumb.src = image.url
    thumb.alt = ''
    thumb.draggable = false
    thumb.addEventListener('click', () => enlarge(image))
    const kill = document.createElement('button')
    kill.type = 'button'
    kill.className = 'kill'
    kill.textContent = '\u00d7'
    kill.setAttribute('aria-label', 'Remove')
    kill.addEventListener('click', () => remove(image))
    box.append(thumb, kill)
    return box
  }))
  send.classList.toggle('ready', field.value.trim() !== '' || images.length > 0)
  resize()
}

function submit() {
  const text = field.value.trim()
  if (text === '' && images.length === 0) return
  window.bridge.send('ask:submit', { text, images: images.map(({ mediaType, data }) => ({ mediaType, data })) })
}

field.addEventListener('input', render)
field.addEventListener('keydown', (event) => {
  // Return while an input method is composing picks a candidate; it is not a submit.
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault()
    submit()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    window.bridge.send('ask:cancel')
  }
})
// Escape drops the enlarged picture before it drops the card.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || enlarged === null) return
  event.preventDefault()
  closePreview()
})
// A screenshot on the clipboard is a file, not text: an input alone would drop it.
// Several at once are taken in the order the clipboard lists them.
document.addEventListener('paste', (event) => {
  const files = Array.from(event.clipboardData?.items ?? [])
    .filter((entry) => entry.kind === 'file' && IMAGE_TYPE.test(entry.type))
    .map((entry) => entry.getAsFile())
    // Too big: leave that one out rather than swallow the whole paste.
    .filter((file) => file !== null && file.size <= MAX_IMAGE_BYTES)
  const room = MAX_IMAGES - images.length
  if (files.length === 0 || room <= 0) return
  event.preventDefault()
  // Pasting while a picture is enlarged would land behind it; come back to the card first.
  closePreview()
  for (const file of files.slice(0, room)) {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      const comma = url.indexOf(',')
      if (comma === -1) return
      images.push({ mediaType: file.type, data: url.slice(comma + 1), url })
      render()
    }
    reader.readAsDataURL(file)
  }
})
preview.addEventListener('click', closePreview)
send.addEventListener('click', submit)
chip.addEventListener('click', () => {
  const box = chip.getBoundingClientRect()
  window.bridge.send('ask:pick', { x: Math.round(box.left), y: Math.round(box.bottom + 6) })
})

window.bridge.on('ask:show', ({ title, chinese }) => {
  field.placeholder = wordsFor(chinese).askPlaceholder
  send.setAttribute('aria-label', wordsFor(chinese).send)
  chipText.textContent = title
  field.value = ''
  enlarged = null
  preview.hidden = true
  previewShot.removeAttribute('src')
  card.hidden = false
  images = []
  // Shown again after an enlarged picture borrowed the window: report the size even if it is the same shape.
  lastSize = ''
  render()
  field.focus()
})
window.bridge.on('ask:workspace', ({ title }) => {
  chipText.textContent = title
  field.focus()
})

// Draw once before saying ready, so the window takes its real height on the first show.
render()
window.bridge.send('ask:ready')
