/**
 * One adapter per platform. Everything that differs between operating
 * systems (how the pet is dragged, how a click is told from a drag, how DSH
 * is brought forward) lives behind this. Adding Windows means adding
 * `win32.mjs` here and a row in `lib/electron-runtime.js`; nothing else
 * moves.
 */
import darwin from './darwin.mjs'

const adapters = { darwin }

/** The adapter for a platform, or null when the pet does not run there yet. */
export function platformFor(name = process.platform) {
  return adapters[name] ?? null
}

export const supportedPlatforms = Object.keys(adapters)
