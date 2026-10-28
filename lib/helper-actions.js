import { isSessionId, parseAskLine } from './session-ball.js'

/** Decode one complete stdout line from the native helper. */
export function helperAction(line) {
  if (line === 'activate') return { type: 'activate' }
  // The helper has already brought DSH forward before it says this.
  if (line === 'settings') return { type: 'settings' }
  if (line.startsWith('open ')) {
    const id = line.slice(5).trim()
    return isSessionId(id) ? { type: 'open', id } : null
  }
  const ask = parseAskLine(line)
  return ask === null ? null : { type: 'ask', ...ask }
}
