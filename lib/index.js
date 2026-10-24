/**
 * dsh-pet — host half.
 *
 * A pet is pure data: a directory under `pets/` holding a `pet.json` manifest
 * that names a sprite atlas and the animation rows it holds. Adding a pet is
 * therefore a data change; this module never enumerates pets by name.
 *
 * Two live settings drive the pet, and both are *volatile*: DSH commits a
 * write straight into the running references and tells this fiber about it
 * with `loader/volatile-update`, so changing the pet or its size restarts
 * the floating helper without restarting DSH.
 *
 * The settings page in the DSH client reads the gallery from the exact Fetch
 * routes registered below, and writes the two settings through DSH's own
 * settings form (`ctx.configForms`), so the values live in the profile patch
 * like every other plugin setting.
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { ID_PATTERN, normalizeManifest, readImageSize } from './codex-pet.js'

export const name = 'dsh-pet'

/** Profile entry id; the settings form addresses the namespace by it. */
export const NAMESPACE = 'dsh-pet'

/** Exact Fetch routes the settings page reads. */
export const API = {
  pets: '/api/dsh-pet/pets',
  sprite: '/api/dsh-pet/sprite',
  preview: '/api/dsh-pet/preview',
}

/** Pet panel bounds, in CSS pixels. */
const MIN_SIZE = 120
const MAX_SIZE = 260
const DEFAULT_SIZE = 220

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const helper = join(root, 'bin', 'dsh-pet-macos')
const petsDir = join(root, 'pets')
const runtime = join(root, 'runtime', 'pet-runtime.js')
const home = homedir()

/**
 * The first pet of the gallery that actually exists on disk.
 *
 * A pet is data, so the default is derived rather than hard-coded: taking a
 * pet out of `pets/` must not leave the host pointing at something that is
 * no longer there.
 */
function firstPet() {
  for (const id of listIds()) {
    if (readManifest(id) !== null) return id
  }
  return null
}

const DEFAULT_PET = firstPet() ?? 'codex'

/**
 * Live settings of this plugin.
 *
 * `pet` names a directory under `pets/`; `size` is the panel edge in CSS
 * pixels. Both are volatile so the settings form can write them live.
 */
export const Config = z.object({
  pet: z.string().default(DEFAULT_PET).volatile(),
  size: z.number().default(DEFAULT_SIZE).volatile(),
})

/**
 * Read a volatile configuration value.
 *
 * DSH hands a plugin the parsed configuration, where a volatile field is a
 * stable reference whose value changes in place. A plain value is accepted
 * too, so the helper works before the settings form ever writes.
 */
function readValue(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    const current = value.get()
    return current === undefined ? undefined : current
  }
  return value
}

/** Clamp the panel edge into the range the helper can draw. */
function clampSize(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return DEFAULT_SIZE
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(number)))
}

/** A file name with no directory part, as opposed to a path. */
function isPlainName(value) {
  return value !== '.' && value !== '..' && basename(value) === value && !value.includes('\\')
}

/** The pixel size of an atlas, read from its first bytes, or null. */
function atlasSize(file) {
  let fd = -1
  try {
    fd = openSync(file, 'r')
    const head = Buffer.alloc(64)
    const read = readSync(fd, head, 0, head.length, 0)
    return readImageSize(head.subarray(0, read))
  } catch {
    return null
  } finally {
    if (fd !== -1) closeSync(fd)
  }
}

/**
 * Read one pet manifest, or null when the pet does not exist.
 *
 * The manifest may be a plain Codex `pet.json` (`displayName`,
 * `spritesheetPath`, ...) or a full one of this project. Either way the
 * caller gets the whole contract: whatever the file leaves out is filled in
 * from the Codex defaults, using the atlas's real size to tell a v1 pet from
 * a v2 one. The directory name is the id; a manifest that calls itself
 * something else (Codex ids are not unique to a folder) is still the pet in
 * that directory.
 */
function readManifest(id) {
  if (!ID_PATTERN.test(id)) return null
  try {
    const raw = JSON.parse(readFileSync(join(petsDir, id, 'pet.json'), 'utf8'))
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    // A pet's manifest comes from whoever made it, so the files it names must
    // sit in its own directory: a bare file name, never a path.
    const sheet = typeof raw.spritesheetPath === 'string' ? raw.spritesheetPath : ''
    if (sheet !== '' && !isPlainName(sheet)) return null
    if (typeof raw.preview === 'string' && !isPlainName(raw.preview)) delete raw.preview
    return normalizeManifest(raw, { id, atlas: sheet === '' ? null : atlasSize(join(petsDir, id, sheet)) })
  } catch {
    return null
  }
}

/** Read the gallery index: the curated, ordered list of pet directories. */
function readIndex() {
  try {
    const index = JSON.parse(readFileSync(join(petsDir, 'index.json'), 'utf8'))
    return Array.isArray(index) ? index : []
  } catch {
    return []
  }
}

/**
 * Every pet directory, in gallery order.
 *
 * `index.json` comes first and fixes the order of the pets that ship with the
 * plugin. Any other directory holding a `pet.json` follows, by name -- that
 * is where a pet installed from Codex lands, and a folder copied in by hand
 * counts too, so there is no registry to keep in step.
 */
function listIds() {
  const ids = []
  for (const entry of readIndex()) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.id === 'string' ? entry.id : ''
    if (id !== '' && !ids.includes(id)) ids.push(id)
  }
  let found = []
  try {
    found = readdirSync(petsDir, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory() && ID_PATTERN.test(dirent.name))
      .map((dirent) => dirent.name)
      .sort()
  } catch {
    // no pets directory: only the index counts
  }
  for (const id of found) {
    if (!ids.includes(id) && existsSync(join(petsDir, id, 'pet.json'))) ids.push(id)
  }
  return ids
}

/**
 * Describe every pet the gallery shows.
 *
 * The list is read from disk on every request, so a pet added to `pets/`
 * appears without touching this module.
 */
function gallery() {
  const pets = []
  for (const id of listIds()) {
    const manifest = readManifest(id)
    if (manifest === null) continue
    if (typeof manifest.spritesheetPath !== 'string' || !existsSync(join(petsDir, id, manifest.spritesheetPath))) continue
    pets.push({
      id,
      name: manifest.name,
      description: manifest.description,
      size: clampSize(manifest.size ?? DEFAULT_SIZE),
      cell: manifest.cell,
      grid: manifest.grid,
      idle: manifest.idle,
      animations: manifest.animations,
      look: manifest.look,
      version: manifest.spriteVersionNumber,
      hasPreview: existsSync(join(petsDir, id, typeof manifest.preview === 'string' ? manifest.preview : 'preview.png')),
    })
  }
  return pets
}

/** Resolve the manifest of the pet the settings page asks for. */
function manifestOf(id) {
  if (typeof id !== 'string') return null
  const manifest = readManifest(id)
  if (manifest === null) return null
  if (typeof manifest.spritesheetPath !== 'string' || manifest.spritesheetPath === '') return null
  return manifest
}

const MIME = { '.webp': 'image/webp', '.png': 'image/png' }

/** Serve a file of a pet directory as a binary response. */
function servePetFile(id, relative) {
  const manifest = manifestOf(id)
  if (manifest === null) return new Response('not found', { status: 404 })
  const file = join(petsDir, manifest.id, relative)
  try {
    const body = readFileSync(file)
    return new Response(body, {
      headers: { 'content-type': MIME[extname(relative).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' },
    })
  } catch {
    return new Response('not found', { status: 404 })
  }
}

/**
 * Resolve the selected pet into a directory the helper can open.
 *
 * A pet is a directory with a `pet.json` manifest naming a sprite atlas.
 * The manifest also carries the animation rows, so a new pet is pure data
 * and never needs a code change.
 */
function resolvePet(requested, logger) {
  const id = ID_PATTERN.test(requested ?? '') ? requested : DEFAULT_PET
  // The requested pet first, then the gallery in order, so a pet that was
  // removed falls back to one that is actually on disk.
  const candidates = [id]
  for (const candidate of listIds()) {
    if (!candidates.includes(candidate)) candidates.push(candidate)
  }
  for (const candidate of candidates) {
    const manifest = readManifest(candidate)
    if (manifest === null) continue
    if (typeof manifest.spritesheetPath !== 'string' || manifest.spritesheetPath === '') continue
    const dir = join(petsDir, candidate)
    if (!existsSync(join(dir, manifest.spritesheetPath))) continue
    if (candidate !== id) logger?.warn?.(`dsh-pet: pet "${id}" not found, using ${candidate}`)
    return { id: candidate, dir }
  }
  return null
}

export function apply(ctx, config = {}) {
  // The live settings of this plugin. Both fields are volatile references:
  // DSH commits a write straight into them and tells this fiber about it.
  const petRef = config.pet
  const sizeRef = config.size
  const current = { pet: DEFAULT_PET, size: DEFAULT_SIZE }
  const readCurrent = () => {
    current.pet = readValue(petRef) ?? DEFAULT_PET
    current.size = clampSize(readValue(sizeRef) ?? DEFAULT_SIZE)
    return current
  }
  readCurrent()

  // The gallery is useful wherever the settings page runs, so the routes are
  // registered on every platform; only the floating helper is Desktop-only.
  ctx.inject(['connection'], (child) => {
    child.effect(() => child.connection.fetch.register({
      path: API.pets,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: () => Response.json({ pets: gallery(), current: { ...current } }),
    }), 'dsh-pet: gallery route')
    child.effect(() => child.connection.fetch.register({
      path: API.sprite,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request) => {
        const id = new URL(request.url).searchParams.get('id') ?? ''
        const manifest = manifestOf(id)
        if (manifest === null) return new Response('not found', { status: 404 })
        return servePetFile(id, manifest.spritesheetPath)
      },
    }), 'dsh-pet: sprite route')
    child.effect(() => child.connection.fetch.register({
      path: API.preview,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request) => {
        const id = new URL(request.url).searchParams.get('id') ?? ''
        const manifest = manifestOf(id)
        if (manifest === null) return new Response('not found', { status: 404 })
        const preview = typeof manifest.preview === 'string' ? manifest.preview : 'preview.png'
        return servePetFile(id, preview)
      },
    }), 'dsh-pet: preview route')
  })

  // The helper activates the Desktop app by bundle id, so it is Desktop-only.
  const desktop = process.env.ELECTRON_RUN_AS_NODE === '1'
  if (process.platform !== 'darwin' || !desktop) {
    ctx.logger?.info?.('dsh-pet: requires DSH Desktop on macOS; the floating pet is skipped')
    return
  }
  if (!existsSync(helper)) {
    ctx.logger?.warn?.(`dsh-pet: native helper missing at ${helper}`)
    return
  }
  if (!existsSync(runtime)) {
    ctx.logger?.warn?.(`dsh-pet: runtime missing at ${runtime}`)
    return
  }

  ctx.logger?.info?.(`dsh-pet: pet ${current.pet} (${current.size}px)`)

  ctx.effect(() => {
    let child = null

    const stop = () => {
      if (child === null) return
      const running = child
      child = null
      try {
        running.kill('SIGTERM')
      } catch {}
    }

    const start = () => {
      const pet = resolvePet(current.pet, ctx.logger)
      if (pet === null) {
        ctx.logger?.warn?.('dsh-pet: no usable pet found')
        return
      }
      child = spawn(helper, [
        '--parent-pid', String(process.pid),
        '--runtime', runtime,
        '--pet-dir', pet.dir,
        '--size', String(current.size),
        '--lock', join(home, '.dsh', 'dsh-pet.lock'),
        '--state', join(home, '.dsh', 'dsh-pet-state.json'),
        // A note of every drag, so "how well does the pet follow?" can be
        // answered with numbers instead of an impression.
        '--drag-log', join(home, '.dsh', 'dsh-pet-drag.log'),
      ], { stdio: ['pipe', 'ignore', 'ignore'] })
      // The helper takes `size N` lines on stdin. A helper that is already
      // gone must not turn a late write into an uncaught error.
      child.stdin.on('error', () => {})
      child.on('error', (error) => {
        ctx.logger?.warn?.(`dsh-pet: failed to start helper: ${error.message}`)
      })
      child.on('exit', (code, signal) => {
        if (code !== null && code !== 0) ctx.logger?.warn?.(`dsh-pet: helper exited (${code})`)
        else if (signal !== null && signal !== 'SIGTERM') ctx.logger?.debug?.(`dsh-pet: helper stopped (${signal})`)
      })
    }

    start()

    // A volatile write lands in the running references and arrives here. A
    // new pet means a new helper; a new size is just told to the one that is
    // running, so the pet follows the settings slider while it is dragged
    // instead of vanishing and coming back at every step.
    const off = ctx.on('loader/volatile-update', () => {
      const before = { pet: current.pet, size: current.size }
      readCurrent()
      if (current.pet === before.pet && current.size === before.size) return
      if (current.pet === before.pet && child !== null && child.stdin?.writable) {
        child.stdin.write(`size ${current.size}\n`)
        return
      }
      ctx.logger?.info?.(`dsh-pet: pet ${current.pet} (${current.size}px)`)
      stop()
      start()
    })

    return () => {
      off()
      stop()
    }
  }, `dsh-pet: floating ${current.pet}`)
}
