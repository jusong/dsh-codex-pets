/**
 * The Codex pet contract, in one place.
 *
 * Pets made for Codex (the ones on https://codex-pets.net, or anything
 * `hatch-pet` produces) are a directory with two files:
 *
 *     pet.json          { id, displayName, description, spritesheetPath,
 *                         spriteVersionNumber?, kind? }
 *     spritesheet.webp  a 1536 x 1872 (v1) or 1536 x 2288 (v2) atlas
 *
 * That is all there is: no animation table. The rows, the frame counts and
 * the timings are part of the Codex contract, so this module owns them. A
 * manifest of this project (`animations`, `grid`, `look`, ...) is the same
 * thing with the contract spelled out, and it wins over the defaults wherever
 * it says something.
 *
 * Both the host (gallery, routes) and the installer use this file. The
 * native helper has the same defaults in `native/main.swift`; keep them in
 * step.
 */

export const CELL = { width: 192, height: 208 }
export const COLUMNS = 8

/** The two atlas shapes the Codex apps use, by `spriteVersionNumber`. */
export const SHAPES = {
  1: { rows: 9, height: 1872 },
  2: { rows: 11, height: 2288 },
}

/** The official rows and per-frame timings (ms). The last frame lingers. */
export const ANIMATIONS = {
  idle: { row: 0, durations: [280, 110, 110, 140, 140, 320] },
  'running-right': { row: 1, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  'running-left': { row: 2, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  waving: { row: 3, durations: [140, 140, 140, 280] },
  jumping: { row: 4, durations: [140, 140, 140, 140, 280] },
  failed: { row: 5, durations: [140, 140, 140, 140, 140, 140, 140, 240] },
  waiting: { row: 6, durations: [150, 150, 150, 150, 150, 260] },
  running: { row: 7, durations: [120, 120, 120, 120, 120, 220] },
  review: { row: 8, durations: [150, 150, 150, 150, 150, 280] },
}

/** Rows 9 and 10 of a v2 atlas: 16 gaze directions, 22.5 degrees apart. */
export const LOOK = { rows: [9, 10], count: 16, startDegrees: 0, stepDegrees: 22.5 }

/** What a pet does besides idling; the same choices the built-in pets make. */
export const BEHAVIOUR = {
  drag: { right: 'running-right', left: 'running-left' },
  react: { click: 'jumping' },
  // Rows that move the body, not only the face: the idle, jumping and review
  // rows barely change anything, which is what makes a pet look switched off.
  idleRoutine: { every: [3, 6], animations: ['waiting', 'waving', 'running'] },
  perform: { sequence: ['jumping', 'waving'], splash: 'sparkle' },
}

export const DEFAULT_SIZE = 200

/** The ids the gallery and the helper accept for a pet directory. */
export const ID_PATTERN = /^[a-z0-9-]+$/

/** Turn whatever a pet calls itself into a directory name, or ''. */
export function slugify(raw) {
  return String(raw ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Read the pixel size out of a WebP or PNG header.
 *
 * Only the first bytes are looked at, so this is cheap enough to run for
 * every pet on every gallery request, and it needs no image library.
 * Returns `{ width, height }`, or null when the bytes are not an image this
 * understands.
 */
export function readImageSize(bytes) {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString('latin1', 12, 16) === 'IHDR') {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  if (bytes.length >= 30 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    const kind = bytes.toString('latin1', 12, 16)
    if (kind === 'VP8X') {
      // 24-bit little-endian canvas size, each stored minus one.
      return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) }
    }
    if (kind === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
    }
    if (kind === 'VP8L' && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21)
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }
    }
  }
  return null
}

/** The sprite version an atlas of this size belongs to, or null. */
export function versionOfAtlas(size) {
  if (size === null || size === undefined) return null
  for (const [version, shape] of Object.entries(SHAPES)) {
    if (size.width === CELL.width * COLUMNS && size.height === shape.height) return Number(version)
  }
  return null
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Fill in everything a Codex manifest leaves to the contract.
 *
 * `raw` is the parsed `pet.json`; `atlas` is the atlas's pixel size when it
 * is known (it decides the version when the manifest does not say, and the
 * atlas is the truth when the two disagree). A manifest that already spells
 * things out keeps its own values.
 */
export function normalizeManifest(raw, { id, atlas = null } = {}) {
  const source = isObject(raw) ? raw : {}
  const declared = source.spriteVersionNumber === 2 ? 2 : source.spriteVersionNumber === 1 ? 1 : null
  const version = versionOfAtlas(atlas) ?? declared ?? 1
  const cell = isObject(source.cell) ? source.cell : { ...CELL }
  const grid = isObject(source.grid) ? source.grid : { columns: COLUMNS, rows: SHAPES[version].rows }
  const name = [source.name, source.displayName].find((value) => typeof value === 'string' && value !== '') ?? id

  // A partial animations table (e.g. only overriding `jumping`) must still
  // keep the Codex row contract for drag / idle / look — otherwise the
  // helper has nothing to play while dragged.
  const animations = { ...ANIMATIONS }
  if (isObject(source.animations)) {
    for (const [key, value] of Object.entries(source.animations)) {
      if (isObject(value)) animations[key] = value
    }
  }

  const manifest = {
    ...source,
    id,
    name,
    description: typeof source.description === 'string' ? source.description : '',
    size: typeof source.size === 'number' ? source.size : DEFAULT_SIZE,
    type: 'sprite',
    spriteVersionNumber: version,
    cell,
    grid,
    idle: typeof source.idle === 'string' ? source.idle : 'idle',
    animations,
    drag: isObject(source.drag) ? source.drag : BEHAVIOUR.drag,
    react: isObject(source.react) ? source.react : BEHAVIOUR.react,
    idleRoutine: isObject(source.idleRoutine) ? source.idleRoutine : BEHAVIOUR.idleRoutine,
    perform: isObject(source.perform) ? source.perform : BEHAVIOUR.perform,
  }
  // Only a v2 atlas carries the look directions; a v1 pet never turns its
  // head towards the cursor.
  if (isObject(source.look)) manifest.look = source.look
  else if (grid.rows >= SHAPES[2].rows) manifest.look = LOOK
  else delete manifest.look
  return manifest
}
