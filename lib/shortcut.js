/**
 * The shortcut the settings field records.
 *
 * The field does not take typed text. A keydown with at least two modifiers
 * becomes `Command+Option+N`, which is what the helper already parses.
 * Backspace or Delete clears it. A bare key, or a modifier by itself, is
 * ignored so the stored chord stays as it was.
 */

const SYMBOL = { Command: '⌘', Option: '⌥', Control: '⌃', Shift: '⇧' }

/** `Command+Option+N` as the symbols the field shows. */
export function formatShortcut(value) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  return value.split('+').map((part) => SYMBOL[part] ?? part).join('')
}

/** One keyboard event, as the chord to store. `''` clears it; `undefined` ignores the key. */
export function shortcutFromKeyboard(event) {
  if (event === null || typeof event !== 'object') return undefined
  if (event.key === 'Backspace' || event.key === 'Delete') return ''
  const code = typeof event.code === 'string' ? event.code : ''
  let key = ''
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3)
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5)
  else if (code === 'Space') key = 'Space'
  else if (/^F(?:[1-9]|1\d|2[0-4])$/.test(code)) key = code
  else return undefined
  const names = []
  if (event.metaKey === true) names.push('Command')
  if (event.altKey === true) names.push('Option')
  if (event.ctrlKey === true) names.push('Control')
  if (event.shiftKey === true) names.push('Shift')
  if (names.length < 2) return undefined
  return names.concat(key).join('+')
}
