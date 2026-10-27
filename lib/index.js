/**
 * dsh-codex-pets — host half.
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
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { ID_PATTERN, normalizeManifest, readImageSize, slugify } from './codex-pet.js'
import {
  DEFAULT_REGISTRY, StoreError, appendUserOrder, findSameArt, importCodexPets, inspectPet, installPet,
  migrateLegacyUserDir, migrateLoosePets, orderedUserIds, registryIdOf, removePet, scanCodexPets, stageFromRegistry,
  uniqueId, userPetsDir, writeUserOrder,
} from './pet-store.js'
import { clampSessionLimit, createFocusBus, isSessionId, rankSessions, sessionMetadata, sessionsLine, shapeCachedText, titleOf } from './session-ball.js'

export const name = 'dsh-codex-pets'

/** Profile entry id; the settings form addresses the namespace by it. */
export const NAMESPACE = 'dsh-codex-pets'

/** Exact Fetch routes the settings page reads. */
export const API = {
  pets: '/api/dsh-codex-pets/pets',
  sprite: '/api/dsh-codex-pets/sprite',
  preview: '/api/dsh-codex-pets/preview',
  install: '/api/dsh-codex-pets/install',
  remove: '/api/dsh-codex-pets/remove',
  reorder: '/api/dsh-codex-pets/reorder',
  codexPets: '/api/dsh-codex-pets/codex-pets',
  importCodex: '/api/dsh-codex-pets/import-codex',
  focus: '/api/dsh-codex-pets/focus',
}

/** The community registry pets are installed from. */
const REGISTRY = (process.env.DSH_CODEX_PETS_REGISTRY || DEFAULT_REGISTRY).replace(/\/+$/, '')

/** HTTP status for each failure the store reports. */
const STATUS = {
  'invalid-source': 400, 'invalid-id': 400, 'invalid-pet': 400, 'too-large': 400, insecure: 400, usage: 400,
  'not-found': 404, 'not-installed': 404,
  exists: 409, active: 409, last: 409, bundled: 409, 'invalid-order': 400,
  unreachable: 502, 'no-unzip': 502,
}

/** One failure, as the settings page reads it: a stable code plus detail. */
function failure(error) {
  if (!(error instanceof StoreError)) throw error
  return Response.json(
    { error: { code: error.code, message: error.message, ...error.details } },
    { status: STATUS[error.code] ?? 400 },
  )
}

/** Read a JSON object body; anything else is an empty object. */
async function readBody(request) {
  try {
    const body = await request.json()
    return body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}
  } catch {
    return {}
  }
}

/** Pet panel bounds, in CSS pixels. */
const MIN_SIZE = 80
const MAX_SIZE = 260
const DEFAULT_SIZE = 220

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const helper = join(root, 'bin', 'dsh-codex-pets-macos')
/** Pets that ship with the plugin. Read-only for the user. */
const bundledPetsDir = join(root, 'pets')
/** Pets the user installed. Writable; ordered by `pets.json`. */
const userDir = userPetsDir()
const petRoots = [bundledPetsDir, userDir]
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

const DEFAULT_PET = firstPet() ?? 'deepseek-whale'

/**
 * Live settings of this plugin.
 *
 * `pet` names a directory under `pets/`; `size` is the panel edge in CSS
 * pixels. Both are volatile so the settings form can write them live.
 * `visible` is the switch the settings page and the pet's own menu write.
 */
export const Config = z.object({
  pet: z.string().default(DEFAULT_PET).volatile(),
  size: z.number().default(DEFAULT_SIZE).volatile(),
  // Off hides the pet without uninstalling it; the helper process stops.
  visible: z.boolean().default(true).volatile(),
  // The ball under the pet, and how many sessions it lists (1–10).
  sessions: z.boolean().default(true).volatile(),
  sessionLimit: z.number().default(5).volatile(),
  // Pet keeps running while a listed session is busy, and jumps when one finishes.
  sessionMotion: z.boolean().default(true).volatile(),
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
/** Directory that holds this pet's files, or null. User store wins on a clash. */
function petHome(id) {
  if (!ID_PATTERN.test(id)) return null
  if (existsSync(join(userDir, id, 'pet.json'))) return userDir
  if (existsSync(join(bundledPetsDir, id, 'pet.json'))) return bundledPetsDir
  return null
}

function readManifest(id) {
  const homeDir = petHome(id)
  if (homeDir === null) return null
  try {
    const raw = JSON.parse(readFileSync(join(homeDir, id, 'pet.json'), 'utf8'))
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    // A pet's manifest comes from whoever made it, so the files it names must
    // sit in its own directory: a bare file name, never a path.
    const sheet = typeof raw.spritesheetPath === 'string' ? raw.spritesheetPath : ''
    if (sheet !== '' && !isPlainName(sheet)) return null
    if (typeof raw.preview === 'string' && !isPlainName(raw.preview)) delete raw.preview
    return normalizeManifest(raw, { id, atlas: sheet === '' ? null : atlasSize(join(homeDir, id, sheet)) })
  } catch {
    return null
  }
}

/** Read the gallery index: the curated, ordered list of shipped pet ids. */
function readIndex() {
  try {
    const index = JSON.parse(readFileSync(join(bundledPetsDir, 'index.json'), 'utf8'))
    return Array.isArray(index) ? index : []
  } catch {
    return []
  }
}

/** Ids named by `index.json` (shipped pets). Order is fixed. */
function bundledIds() {
  const ids = []
  for (const entry of readIndex()) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.id === 'string' ? entry.id : ''
    if (id !== '' && !ids.includes(id)) ids.push(id)
  }
  return ids
}

function isBundledId(id) {
  return bundledIds().includes(id)
}

/**
 * Every pet in gallery order.
 *
 * Shipped pets from `index.json` come first and never move. User installs
 * follow in `~/.dsh/dsh-codex-pets/pets.json` order (a fresh install is
 * appended).
 */
function listIds() {
  return [...bundledIds(), ...orderedUserIds(userDir)]
}

/**
 * Describe every pet the gallery shows.
 *
 * The list is read from disk on every request, so a pet added under the user
 * directory appears without touching this module.
 */
function gallery() {
  const bundled = new Set(bundledIds())
  const pets = []
  for (const id of listIds()) {
    const homeDir = petHome(id)
    if (homeDir === null) continue
    const manifest = readManifest(id)
    if (manifest === null) continue
    if (typeof manifest.spritesheetPath !== 'string' || !existsSync(join(homeDir, id, manifest.spritesheetPath))) continue
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
      hasPreview: existsSync(join(homeDir, id, typeof manifest.preview === 'string' ? manifest.preview : 'preview.png')),
      // Shipped pets cannot be deleted or reordered in the settings page.
      bundled: bundled.has(id) && homeDir === bundledPetsDir,
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
  const homeDir = petHome(manifest.id)
  if (homeDir === null) return new Response('not found', { status: 404 })
  const file = join(homeDir, manifest.id, relative)
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
    const homeDir = petHome(candidate)
    if (homeDir === null) continue
    const manifest = readManifest(candidate)
    if (manifest === null) continue
    if (typeof manifest.spritesheetPath !== 'string' || manifest.spritesheetPath === '') continue
    const dir = join(homeDir, candidate)
    if (!existsSync(join(dir, manifest.spritesheetPath))) continue
    if (candidate !== id) logger?.warn?.(`dsh-codex-pets: pet "${id}" not found, using ${candidate}`)
    return { id: candidate, dir }
  }
  return null
}

/**
 * The ball's list, from the host's session services.
 *
 * `lastPromptAt` comes from the session-list projection when one is mounted,
 * which is what "most recently used" means; without it the list falls back
 * to when the session was created. A resumed session has no materialized
 * cell, so the read materializes one instead of settling for its old
 * checkpoint. Titles come from the query service.
 */
async function collectSessions(services, limit) {
  const records = await services.query.listSessions()
  const shaped = []
  for (const record of records ?? []) {
    const header = record?.header
    if (header === null || typeof header !== 'object' || typeof header.id !== 'string') continue
    const live = services.sessions?.get?.(header.id)
    const meta = sessionMetadata(services, header, live)
    let lastPromptAt
    let blank
    if (typeof meta?.lastPromptAt === 'number') lastPromptAt = meta.lastPromptAt
    if (typeof meta?.blank === 'boolean') blank = meta.blank
    let running = false
    try {
      running = services.agents?.get?.(header.id)?.status === 'running'
    } catch { /* no agent service: nothing is running */ }
    shaped.push({
      id: header.id,
      createdAt: header.createdAt,
      origin: header.origin,
      delegationDepth: header.delegationDepth,
      lastPromptAt,
      blank,
      running,
    })
  }
  const ranked = rankSessions(shaped, { limit })
  if (ranked.length === 0) return []
  let snapshots = []
  try {
    snapshots = await services.query.readTitleSnapshots(ranked.map((item) => item.id))
  } catch {
    snapshots = []
  }
  return ranked.map((item, index) => ({ ...item, title: titleOf(snapshots[index]) }))
}

/** Projection files the host already keeps for the session list. */
const SESSION_CACHE_DIR = join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions')

/**
 * The same list, read off disk.
 *
 * Used when the session service is missing, throws, or does not answer.
 * The files are the projection cache, which already stores the title and
 * the last time someone talked to the session.
 */
const cacheRows = new Map()

function readCachedSessions(limit) {
  let names
  try {
    names = readdirSync(SESSION_CACHE_DIR)
  } catch {
    return []
  }
  const seen = new Set()
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -'.json'.length)
    if (!isSessionId(id)) continue
    seen.add(id)
    const path = join(SESSION_CACHE_DIR, name)
    let stat
    try {
      stat = statSync(path)
    } catch {
      continue
    }
    const previous = cacheRows.get(id)
    if (previous !== undefined && previous.mtimeMs === stat.mtimeMs && previous.size === stat.size) continue
    let text
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    cacheRows.set(id, { mtimeMs: stat.mtimeMs, size: stat.size, row: shapeCachedText(id, text) })
  }
  for (const id of cacheRows.keys()) {
    if (!seen.has(id)) cacheRows.delete(id)
  }
  const shaped = []
  for (const entry of cacheRows.values()) {
    if (entry.row !== null) shaped.push(entry.row)
  }
  const ranked = rankSessions(shaped, { limit })
  const byId = new Map(shaped.map((row) => [row.id, row.title]))
  return ranked.map((item) => ({ ...item, title: byId.get(item.id) ?? '' }))
}

/** Give up on a session read that does not come back, and keep the pet moving. */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    promise.then((value) => {
      clearTimeout(timer)
      resolve(value)
    }, (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

export function apply(ctx, config = {}) {
  // Pets installed before the rename lived in `~/.dsh/pets`; move the store
  // once so an upgrade keeps them. Older builds also left loose pets inside
  // the plugin tree, which move into the user store on the same pass.
  // Skipped when DSH_CODEX_PETS_USER_DIR is set (tests / a custom store): moving
  // out of the package tree then would surprise a developer checkout.
  try {
    migrateLegacyUserDir()
    if (!process.env.DSH_CODEX_PETS_USER_DIR) {
      migrateLoosePets(bundledPetsDir, userDir, bundledIds())
    }
  } catch (error) {
    ctx.logger?.warn?.(`dsh-codex-pets: could not migrate pets: ${error instanceof Error ? error.message : error}`)
  }

  // The live settings of this plugin. Both fields are volatile references:
  // DSH commits a write straight into them and tells this fiber about it.
  const petRef = config.pet
  const sizeRef = config.size
  const current = { pet: DEFAULT_PET, size: DEFAULT_SIZE, visible: true, sessions: true, sessionLimit: 5, sessionMotion: true }
  const readCurrent = () => {
    current.pet = readValue(petRef) ?? DEFAULT_PET
    current.size = clampSize(readValue(sizeRef) ?? DEFAULT_SIZE)
    current.visible = readValue(config.visible) !== false
    current.sessions = readValue(config.sessions) !== false
    current.sessionLimit = clampSessionLimit(readValue(config.sessionLimit))
    current.sessionMotion = readValue(config.sessionMotion) !== false
    return current
  }
  readCurrent()

  // The gallery is useful wherever the settings page runs, so the routes are
  // registered on every platform; only the floating helper is Desktop-only.
  // "Open this session", said by the helper and waited on by the page.
  const focus = createFocusBus()

  // The pet's own menu hides it. Going through Settings writes the same
  // profile field the page's switch does, so both stay in step and the
  // choice survives a restart.
  let settings = null
  ctx.inject(['settings'], (child) => { settings = child.settings })

  ctx.inject(['connection'], (child) => {
    child.effect(() => child.connection.fetch.register({
      path: API.pets,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: () => Response.json({ pets: gallery(), current: { ...current } }),
    }), 'dsh-codex-pets: gallery route')
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
    }), 'dsh-codex-pets: sprite route')
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
    }), 'dsh-codex-pets: preview route')

    // Changing what is installed. Writes are one at a time, so two clicks (or
    // two windows) can never half-install over each other.
    let queue = Promise.resolve()
    const serialized = (task) => {
      const result = queue.then(task, task)
      queue = result.catch(() => {})
      return result
    }
    const post = { methods: ['POST'], requestBody: 'buffered' }

    // Install a pet from the registry, by id or by the link of its page.
    child.effect(() => child.connection.fetch.register({
      path: API.install,
      ...post,
      fetch: async (request) => {
        const body = await readBody(request)
        const id = typeof body.source === 'string' ? registryIdOf(body.source, REGISTRY) : null
        if (id === null) {
          return failure(new StoreError('invalid-source', 'give a pet id or a link to its page on the registry'))
        }
        return serialized(async () => {
          const staging = mkdtempSync(join(tmpdir(), 'dsh-codex-pets-install-'))
          try {
            const { origin, fallbackId } = await stageFromRegistry(id, REGISTRY, staging)
            const pet = inspectPet(staging, { fallbackId })
            // The same art again is the same pet, not a new one.
            const same = findSameArt(petRoots, pet.sheetPath)
            if (same !== null) {
              const manifest = readManifest(same)
              return Response.json({ ok: true, already: true, pet: { id: same, name: manifest?.name ?? same, version: pet.version } })
            }
            // A name that is taken by a different pet is not an error here:
            // there is nobody to ask, so the newcomer gets a free name.
            // Never reuse a shipped id; installs always land in the user store.
            const free = uniqueId(petRoots, pet.suggestedId || slugify(id) || 'pet')
            const done = installPet(pet, { petsDir: userDir, id: free, origin })
            appendUserOrder(userDir, done.id)
            return Response.json({ ok: true, already: false, pet: done, notes: pet.notes })
          } catch (error) {
            return failure(error)
          } finally {
            rmSync(staging, { recursive: true, force: true })
          }
        })
      },
    }), 'dsh-codex-pets: install route')

    // Delete a user-installed pet. Shipped pets cannot be removed.
    child.effect(() => child.connection.fetch.register({
      path: API.remove,
      ...post,
      fetch: async (request) => {
        const body = await readBody(request)
        const id = typeof body.id === 'string' ? body.id : ''
        return serialized(() => {
          try {
            if (!ID_PATTERN.test(id)) throw new StoreError('invalid-id', `"${id}" is not a pet id`)
            if (isBundledId(id) && petHome(id) === bundledPetsDir) {
              throw new StoreError('bundled', 'a pet that ships with the plugin cannot be deleted', { id })
            }
            // Deleting the pet on the desktop is allowed; the answer names the
            // one to switch to, so the page can move the helper off it.
            readCurrent()
            const inUse = new Set([current.pet, resolvePet(current.pet)?.id])
            const remaining = listIds().filter((other) => other !== id && readManifest(other) !== null)
            if (remaining.length === 0) {
              throw new StoreError('last', 'the last pet cannot be deleted', { id })
            }
            removePet(userDir, id)
            orderedUserIds(userDir)
            return Response.json({ ok: true, id, next: inUse.has(id) ? remaining[0] : null })
          } catch (error) {
            return failure(error)
          }
        })
      },
    }), 'dsh-codex-pets: remove route')

    // Reorder user-installed pets. The list must be exactly today's user ids.
    child.effect(() => child.connection.fetch.register({
      path: API.reorder,
      ...post,
      fetch: async (request) => {
        const body = await readBody(request)
        const ids = Array.isArray(body.ids) ? body.ids : null
        return serialized(() => {
          try {
            if (ids === null) throw new StoreError('invalid-order', 'ids must be an array of pet ids')
            const current = orderedUserIds(userDir)
            const next = []
            for (const id of ids) {
              if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
                throw new StoreError('invalid-order', `"${id}" is not a pet id`)
              }
              if (isBundledId(id) && petHome(id) === bundledPetsDir) {
                throw new StoreError('bundled', 'a pet that ships with the plugin cannot be reordered', { id })
              }
              if (!current.includes(id)) {
                throw new StoreError('not-installed', `pets/${id} does not exist`, { id })
              }
              if (next.includes(id)) throw new StoreError('invalid-order', `duplicate id "${id}"`)
              next.push(id)
            }
            if (next.length !== current.length || current.some((id) => !next.includes(id))) {
              throw new StoreError('invalid-order', 'ids must list every user-installed pet once')
            }
            writeUserOrder(userDir, next)
            return Response.json({ ok: true, ids: next })
          } catch (error) {
            return failure(error)
          }
        })
      },
    }), 'dsh-codex-pets: reorder route')

    // What Codex has installed on this machine, and what importing would do.
    child.effect(() => child.connection.fetch.register({
      path: API.codexPets,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: () => Response.json({
        pets: scanCodexPets(petRoots).map(({ folder, id, name, status, version, installedAs, error }) => ({
          folder, id, name, status, version, installedAs, error,
        })),
      }),
    }), 'dsh-codex-pets: codex pets route')

    // One click: import every Codex pet that is not here yet.
    child.effect(() => child.connection.fetch.register({
      path: API.importCodex,
      ...post,
      fetch: () => serialized(() => {
        try {
          return Response.json({ ok: true, ...importCodexPets(userDir, undefined, petRoots) })
        } catch (error) {
          return failure(error)
        }
      }),
    }), 'dsh-codex-pets: import route')

    // The page waits here until the pet's list is clicked. A wait that times
    // out answers with an empty id, so the page just waits again.
    child.effect(() => child.connection.fetch.register({
      path: API.focus,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request) => {
        const since = new URL(request.url).searchParams.get('since') ?? '0'
        return focus.wait(since).then((payload) => Response.json(payload))
      },
    }), 'dsh-codex-pets: focus route')
  })

  // The helper activates the Desktop app by bundle id, so it is Desktop-only.
  const desktop = process.env.ELECTRON_RUN_AS_NODE === '1'
  if (process.platform !== 'darwin' || !desktop) {
    ctx.logger?.info?.('dsh-codex-pets: requires DSH Desktop on macOS; the floating pet is skipped')
    return
  }
  if (!existsSync(helper)) {
    ctx.logger?.warn?.(`dsh-codex-pets: native helper missing at ${helper}`)
    return
  }
  if (!existsSync(runtime)) {
    ctx.logger?.warn?.(`dsh-codex-pets: runtime missing at ${runtime}`)
    return
  }

  ctx.logger?.info?.(`dsh-codex-pets: pet ${current.pet} (${current.size}px)`)

  ctx.effect(() => {
    let child = null
    // The last list sent to the helper, so a helper that starts later (a pet
    // change restarts it) draws the list it already had.
    let sessionWire = 'sessions []\n'
    let motionWire = 'motion off\n'
    let chromeWire = 'chrome off\n'
    const pushWire = (line) => {
      if (line.startsWith('sessions ')) sessionWire = line
      else if (line.startsWith('motion ')) motionWire = line
      else if (line.startsWith('chrome ')) chromeWire = line
      const stdin = child?.stdin
      if (stdin?.writable) stdin.write(line)
    }
    const pushFlags = () => {
      pushWire(current.sessionMotion ? 'motion on\n' : 'motion off\n')
      pushWire(current.sessions ? 'chrome on\n' : 'chrome off\n')
    }

    const stop = () => {
      if (child === null) return
      const running = child
      child = null
      try {
        running.kill('SIGTERM')
      } catch {}
    }

    // The pet's right-click menu asks for this: off the screen now, and off
    // after the next start too. Hiding must work even when Settings is not
    // available, so the helper stops first and the write is best effort.
    const hidePet = () => {
      stop()
      const update = settings?.update
      if (typeof update !== 'function') {
        ctx.logger?.warn?.('dsh-codex-pets: hidden, but Settings is missing; it returns on the next start')
        return
      }
      update.call(settings, NAMESPACE, { visible: false }).catch((error) => {
        ctx.logger?.warn?.(`dsh-codex-pets: hidden, but "visible" was not saved: ${error instanceof Error ? error.message : error}`)
      })
    }

    const start = () => {
      const pet = resolvePet(current.pet, ctx.logger)
      if (pet === null) {
        ctx.logger?.warn?.('dsh-codex-pets: no usable pet found')
        return
      }
      child = spawn(helper, [
        '--parent-pid', String(process.pid),
        '--runtime', runtime,
        '--pet-dir', pet.dir,
        '--size', String(current.size),
        '--lock', join(home, '.dsh', 'dsh-codex-pets.lock'),
        '--state', join(home, '.dsh', 'dsh-codex-pets-state.json'),
        // A note of every drag, so "how well does the pet follow?" can be
        // answered with numbers instead of an impression.
        '--drag-log', join(home, '.dsh', 'dsh-codex-pets-drag.log'),
      ], { stdio: ['pipe', 'pipe', 'ignore'] })
      // The helper takes `size N` and `sessions …` lines on stdin, and says
      // `open <id>` on stdout when a row of the list is clicked. A helper
      // that is already gone must not turn a late write into an uncaught error.
      child.stdin.on('error', () => {})
      child.stdout.on('error', () => {})
      let pending = ''
      child.stdout.on('data', (chunk) => {
        pending += chunk.toString('utf8')
        let newline = pending.indexOf('\n')
        while (newline !== -1) {
          const line = pending.slice(0, newline).trim()
          pending = pending.slice(newline + 1)
          if (line.startsWith('open ')) focus.publish(line.slice(5).trim())
          else if (line === 'hide') hidePet()
          newline = pending.indexOf('\n')
        }
      })
      if (chromeWire !== 'chrome off\n') child.stdin.write(chromeWire)
      if (motionWire !== 'motion off\n') child.stdin.write(motionWire)
      if (sessionWire !== 'sessions []\n') child.stdin.write(sessionWire)
      child.on('error', (error) => {
        ctx.logger?.warn?.(`dsh-codex-pets: failed to start helper: ${error.message}`)
      })
      child.on('exit', (code, signal) => {
        if (code !== null && code !== 0) ctx.logger?.warn?.(`dsh-codex-pets: helper exited (${code})`)
        else if (signal !== null && signal !== 'SIGTERM') ctx.logger?.debug?.(`dsh-codex-pets: helper stopped (${signal})`)
      })
    }

    if (current.visible) start()

    // The list under the pet. ctx.get reads the session service directly.
    // Waiting on a nested inject left the helper's stdin empty, so the ball
    // never appeared. A service that is missing or does not answer falls
    // back to the projection files on disk, which carry the same titles.
    const safeGet = (service) => {
      try {
        return ctx.get(service)
      } catch {
        return undefined
      }
    }
    let stopped = false
    let busy = false
    let serviceQuietUntil = 0
    const tick = async () => {
      if (stopped) return
      const wantList = current.sessions || current.sessionMotion
      // Turning both features off must win over a list that is still being read.
      if (!wantList) {
        pushFlags()
        if (sessionWire !== 'sessions []\n') pushWire('sessions []\n')
        return
      }
      if (busy) return
      busy = true
      try {
        let items = null
        if (Date.now() >= serviceQuietUntil) {
          const query = safeGet('sessionQuery')
          if (query != null && typeof query.listSessions === 'function') {
            try {
              items = await withTimeout(collectSessions({
                query,
                agents: safeGet('agents'),
                projections: safeGet('sessionProjections'),
                cache: safeGet('sessionProjectionCache'),
                sessions: safeGet('sessions'),
              }, current.sessionLimit), 2500)
            } catch (error) {
              serviceQuietUntil = Date.now() + 15000
              ctx.logger?.debug?.(`dsh-codex-pets: session list failed: ${error instanceof Error ? error.message : error}`)
            }
          }
        }
        if (stopped) return
        if (!current.sessions && !current.sessionMotion) {
          pushFlags()
          pushWire('sessions []\n')
          return
        }
        if (items === null) items = readCachedSessions(current.sessionLimit)
        pushFlags()
        pushWire(sessionsLine(items))
      } finally {
        busy = false
      }
    }
    const refreshSessions = () => { tick() }
    tick()
    const timer = setInterval(tick, 3000)
    const stopPoll = () => {
      stopped = true
      clearInterval(timer)
    }

    // A volatile write lands in the running references and arrives here. A
    // new pet means a new helper; a new size is just told to the one that is
    // running, so the pet follows the settings slider while it is dragged
    // instead of vanishing and coming back at every step. The session ball
    // and the work-motion switch are neither: the helper that is already up
    // is told the new list and the new flags. `visible` starts and stops it.
    const off = ctx.on('loader/volatile-update', () => {
      const before = {
        pet: current.pet,
        size: current.size,
        visible: current.visible,
        sessions: current.sessions,
        sessionLimit: current.sessionLimit,
        sessionMotion: current.sessionMotion,
      }
      readCurrent()
      if (
        current.sessions !== before.sessions
        || current.sessionLimit !== before.sessionLimit
        || current.sessionMotion !== before.sessionMotion
      ) refreshSessions()
      if (!current.visible) {
        stop()
        return
      }
      if (!before.visible) {
        ctx.logger?.info?.(`dsh-codex-pets: pet ${current.pet} (${current.size}px)`)
        start()
        return
      }
      if (current.pet === before.pet && current.size === before.size) return
      if (current.pet === before.pet && child !== null && child.stdin?.writable) {
        child.stdin.write(`size ${current.size}\n`)
        return
      }
      ctx.logger?.info?.(`dsh-codex-pets: pet ${current.pet} (${current.size}px)`)
      stop()
      start()
    })

    return () => {
      off()
      stopPoll()
      stop()
    }
  }, `dsh-codex-pets: floating ${current.pet}`)
}
