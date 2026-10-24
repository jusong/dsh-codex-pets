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
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

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
  for (const entry of readIndex()) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.id === 'string' ? entry.id : ''
    if (id !== '' && readManifest(id) !== null) return id
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

/** Read one pet manifest, or null when the pet does not exist. */
function readManifest(id) {
  if (!/^[a-z0-9-]+$/.test(id)) return null
  try {
    const manifest = JSON.parse(readFileSync(join(petsDir, id, 'pet.json'), 'utf8'))
    return manifest !== null && typeof manifest === 'object' && manifest.id === id ? manifest : null
  } catch {
    return null
  }
}

/** Read the gallery index: the ordered list of pet directories. */
function readIndex() {
  try {
    const index = JSON.parse(readFileSync(join(petsDir, 'index.json'), 'utf8'))
    return Array.isArray(index) ? index : []
  } catch {
    return []
  }
}

/**
 * Describe every pet the gallery shows.
 *
 * The list is read from disk on every request, so a pet added to `pets/`
 * appears without touching this module.
 */
function gallery() {
  const pets = []
  for (const entry of readIndex()) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.id === 'string' ? entry.id : ''
    const manifest = readManifest(id)
    if (manifest === null) continue
    pets.push({
      id,
      name: typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : id,
      description: typeof manifest.description === 'string' ? manifest.description : '',
      size: clampSize(manifest.size ?? DEFAULT_SIZE),
      cell: manifest.cell,
      grid: manifest.grid,
      idle: manifest.idle,
      animations: manifest.animations,
      look: manifest.look,
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

/** Serve a file of a pet directory as a binary response. */
function servePetFile(id, relative, contentType) {
  const manifest = manifestOf(id)
  if (manifest === null) return new Response('not found', { status: 404 })
  const file = join(petsDir, manifest.id, relative)
  try {
    const body = readFileSync(file)
    return new Response(body, {
      headers: { 'content-type': contentType, 'cache-control': 'no-store' },
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
  const id = /^[a-z0-9-]+$/.test(requested ?? '') ? requested : DEFAULT_PET
  // The requested pet first, then the gallery in order, so a pet that was
  // removed falls back to one that is actually on disk.
  const candidates = [id]
  for (const entry of readIndex()) {
    if (entry === null || typeof entry !== 'object') continue
    const candidate = typeof entry.id === 'string' ? entry.id : ''
    if (candidate !== '' && !candidates.includes(candidate)) candidates.push(candidate)
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
        return servePetFile(id, manifest.spritesheetPath, 'image/webp')
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
        return servePetFile(id, preview, 'image/png')
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
      ], { stdio: 'ignore' })
      child.on('error', (error) => {
        ctx.logger?.warn?.(`dsh-pet: failed to start helper: ${error.message}`)
      })
      child.on('exit', (code, signal) => {
        if (code !== null && code !== 0) ctx.logger?.warn?.(`dsh-pet: helper exited (${code})`)
        else if (signal !== null && signal !== 'SIGTERM') ctx.logger?.debug?.(`dsh-pet: helper stopped (${signal})`)
      })
    }

    start()

    // A volatile write lands in the running references and arrives here; the
    // helper is restarted so the new pet or the new size takes effect.
    const off = ctx.on('loader/volatile-update', () => {
      const before = `${current.pet}@${current.size}`
      readCurrent()
      if (`${current.pet}@${current.size}` === before) return
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
