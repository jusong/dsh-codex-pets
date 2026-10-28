/** The question card. Return or the blue arrow submits; Escape closes it; the workspace name switches it. */
import { wordsFor } from '../core/labels.mjs'

const field = document.getElementById('field')
const chip = document.getElementById('chip')
const chipText = document.getElementById('chipText')
const send = document.getElementById('send')

function refresh() {
  send.classList.toggle('ready', field.value.trim() !== '')
}

function submit() {
  const text = field.value.trim()
  if (text === '') return
  window.bridge.send('ask:submit', { text })
}

field.addEventListener('input', refresh)
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
  refresh()
  field.focus()
})
window.bridge.on('ask:workspace', ({ title }) => {
  chipText.textContent = title
  field.focus()
})

window.bridge.send('ask:ready')
