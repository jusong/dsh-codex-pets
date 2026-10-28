/**
 * `Command+Option+N` as the settings field stores it, turned into the
 * accelerator Electron registers. At least two modifiers are required, so a
 * stray bare key can never become a global hotkey.
 */
const NAMES = { COMMAND: 'Command', CMD: 'Command', OPTION: 'Alt', OPT: 'Alt', ALT: 'Alt', CONTROL: 'Control', CTRL: 'Control', SHIFT: 'Shift' }

export function toAccelerator(value) {
  if (typeof value !== 'string') return null
  const expanded = value
    .replaceAll('⌘', '+Command+')
    .replaceAll('⌥', '+Option+')
    .replaceAll('⌃', '+Control+')
    .replaceAll('⇧', '+Shift+')
  const tokens = expanded.split('+').map((part) => part.trim().toUpperCase()).filter(Boolean)
  if (tokens.length === 0) return null
  const modifiers = new Set()
  let key = null
  for (const token of tokens) {
    if (NAMES[token] !== undefined) {
      modifiers.add(NAMES[token])
    } else if (key === null && (/^[A-Z0-9]$/.test(token) || token === 'SPACE' || /^F(?:[1-9]|1\d|2[0-4])$/.test(token))) {
      key = token === 'SPACE' ? 'Space' : token
    } else {
      return null
    }
  }
  if (key === null || modifiers.size < 2) return null
  return [...modifiers, key].join('+')
}
