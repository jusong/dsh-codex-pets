/**
 * dsh-codex-pets — host half.
 *
 * A pet is pure data: a directory under `pets/` holding a `pet.json` manifest
 * that names a sprite atlas and the animation rows it holds. Adding a pet is
 * therefore a data change; this module never enumerates pets by name.
 *
 * Two live settings drive the pet, and both are *volatile*: DSH commits a
 * write straight into the running references and tells this fiber about it
 * with `loader/volatile-update`, so changing the pet or its size updates
 * the floating window without restarting DSH.
 *
 * The settings page in the DSH client reads the gallery from the exact Fetch
 * routes registered below, and writes the two settings through DSH's own
 * settings form (`ctx.configForms`), so the values live in the profile patch
 * like every other plugin setting.
 */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { platformFor } from '../electron/platform/index.mjs'
import z from '@deepseek-ai/schemastery'
import { ID_PATTERN, normalizeManifest, readImageSize, slugify } from './codex-pet.js'
import {
  DEFAULT_REGISTRY, StoreError, appendUserOrder, findSameArt, importCodexPets, inspectPet, installPet,
  migrateLoosePets, orderedUserIds, pluginDataDir, registryIdOf, removePet, runtimeDir, scanCodexPets, stageFromRegistry,
  uniqueId, userPetsDir, writeUserOrder,
} from './pet-store.js'
import { createRuntimeManager } from './electron-runtime.js'
import { helperAction } from './helper-actions.js'
import { clampSessionLimit, createFocusBus, isSessionId, rankSessions, sessionMetadata, sessionsLine, shapeCachedText, titleOf, withWorkspace, workspacesLine } from './session-ball.js'

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
  runtime: '/api/dsh-codex-pets/runtime',
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
const DEFAULT_SHORTCUT = 'Command+Option+N'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
/** The pet window: a small Electron app that ships as plain JavaScript. */
const windowApp = join(root, 'electron')
/** Pets that ship with the plugin. Read-only for the user. */
const bundledPetsDir = join(root, 'pets')
/** Pets the user installed. Writable; ordered by `pets.json`. */
const userDir = userPetsDir()
const petRoots = [bundledPetsDir, userDir]
const dataDir = pluginDataDir()
/** Electron itself is fetched here on first start. Not inside the pet store, which scans its folders. */
const electronRuntimeDir = runtimeDir()

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
  // Global shortcut for the lightweight new-session box; empty disables it.
  shortcut: z.string().default(DEFAULT_SHORTCUT).volatile(),
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
 * follow in `~/.dsh/dsh-codex-pets/pets/pets.json` order (a fresh install is
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
      cwd: typeof header.cwd === 'string' ? header.cwd : '',
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
  return withWorkspace(
    ranked.map((item, index) => ({ ...item, title: titleOf(snapshots[index]) })),
    shaped,
    services.workspaces,
  )
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

function readCachedSessions(limit, workspaces) {
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
  return withWorkspace(
    ranked.map((item) => ({ ...item, title: byId.get(item.id) ?? '' })),
    shaped,
    workspaces,
  )
}

/** Workspace paths and stored titles, for matching a session to where it runs. */
function listedWorkspaces(registry) {
  if (typeof registry?.list !== 'function') return []
  try {
    return registry.list().map((item) => ({
      path: typeof item?.path === 'string' ? item.path : '',
      title: typeof item?.title === 'string' ? item.title : '',
    }))
  } catch {
    return []
  }
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
  // The Electron the pet window runs in. Only DSH Desktop on a platform the
  // window supports has one; elsewhere the settings page just reads
  // `unsupported`.
  const desktop = process.env.ELECTRON_RUN_AS_NODE === '1'
  const adapter = platformFor()
  const runtime = desktop && adapter !== null
    ? createRuntimeManager({ dir: join(electronRuntimeDir, 'electron'), logger: ctx.logger })
    : null

  // Older builds left loose pets inside the plugin tree; move them into the
  // user store once. Skipped when DSH_CODEX_PETS_USER_DIR is set (tests / a
  // custom store): moving out of the package tree then would surprise a
  // developer checkout.
  try {
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
  const current = {
    pet: DEFAULT_PET,
    size: DEFAULT_SIZE,
    visible: true,
    sessions: true,
    sessionLimit: 5,
    sessionMotion: true,
    shortcut: DEFAULT_SHORTCUT,
  }
  const readCurrent = () => {
    current.pet = readValue(petRef) ?? DEFAULT_PET
    current.size = clampSize(readValue(sizeRef) ?? DEFAULT_SIZE)
    current.visible = readValue(config.visible) !== false
    current.sessions = readValue(config.sessions) !== false
    current.sessionLimit = clampSessionLimit(readValue(config.sessionLimit))
    current.sessionMotion = readValue(config.sessionMotion) !== false
    current.shortcut = typeof readValue(config.shortcut) === 'string' ? readValue(config.shortcut) : DEFAULT_SHORTCUT
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

    // Where fetching Electron stands, for the settings page. POST retries,
    // and may carry a download address of the user's own.
    child.effect(() => child.connection.fetch.register({
      path: API.runtime,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (runtime === null) {
          return Response.json({ status: 'unsupported', platform: process.platform, error: 'the floating pet runs in DSH Desktop on macOS' })
        }
        if (request.method === 'POST') {
          const body = await readBody(request)
          if (typeof body.source === 'string' && !runtime.setCustomSource(body.source)) {
            return Response.json({ error: { code: 'invalid-source', message: 'the address must start with http:// or https://' } }, { status: 400 })
          }
          // A runtime already on disk is ready; don't start another download.
          if (runtime.executable() === null && runtime.snapshot().status !== 'ready') runtime.retry()
        }
        return Response.json(runtime.refresh())
      },
    }), 'dsh-codex-pets: runtime route')
  })

  // The window brings DSH forward by its app bundle, so it is Desktop-only.
  if (runtime === null) {
    ctx.logger?.info?.('dsh-codex-pets: requires DSH Desktop on macOS; the floating pet is skipped')
    return
  }
  if (!existsSync(join(windowApp, 'main.mjs'))) {
    ctx.logger?.warn?.(`dsh-codex-pets: pet window missing at ${windowApp}`)
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
    let workspaceWire = 'workspaces []\n'
    const pushWire = (line) => {
      if (line.startsWith('sessions ')) sessionWire = line
      else if (line.startsWith('motion ')) motionWire = line
      else if (line.startsWith('chrome ')) chromeWire = line
      else if (line.startsWith('workspaces ')) workspaceWire = line
      const stdin = child?.stdin
      if (stdin?.writable) stdin.write(line)
    }
    const pushFlags = () => {
      pushWire(current.sessionMotion ? 'motion on\n' : 'motion off\n')
      pushWire(current.sessions ? 'chrome on\n' : 'chrome off\n')
    }

    let stopped = false
    // Starting waits for Electron (the first run downloads it), so a stop or a
    // newer start that comes in the meantime must win. Each start takes a number.
    let generation = 0
    const stop = () => {
      generation += 1
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

    // Filled in once the host services can be read. A question that arrives
    // before that is dropped; the helper is not up yet either.
    let startAsk = () => {}

    /** The DSH app the window brings forward: the bundle this process runs from. */
    const hostApp = /^(.*?\.app)\//.exec(process.execPath)?.[1] ?? ''

    const start = () => {
      const pet = resolvePet(current.pet, ctx.logger)
      if (pet === null) {
        ctx.logger?.warn?.('dsh-codex-pets: no usable pet found')
        return
      }
      generation += 1
      const mine = generation
      runtime.ensure().then((electron) => {
        if (mine !== generation) return
        const exe = electron ?? runtime.executable()
        if (exe === null) {
          ctx.logger?.warn?.(`dsh-codex-pets: Electron is not available (${runtime.snapshot().error}); see Settings > Pet`)
          return
        }
        launch(exe, pet)
        // Clear a stale "download failed" once the files are in use.
        runtime.refresh()
      })
    }

    const launch = (electron, pet) => {
      if (child !== null) return
      // Electron runs as a plain Node when this is set, and the window never opens.
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const started = spawn(electron, [
        windowApp,
        '--dsh-parent-pid', String(process.pid),
        '--dsh-pet-dir', pet.dir,
        '--dsh-size', String(current.size),
        '--dsh-shortcut', current.shortcut,
        '--dsh-host-app', hostApp,
        '--dsh-user-data', join(electronRuntimeDir, 'electron-data'),
        '--dsh-lock', join(dataDir, 'dsh-codex-pets.pid'),
        '--dsh-state', join(dataDir, 'dsh-codex-pets-state.json'),
        // A note of every drag, so "how well does the pet follow?" can be
        // answered with numbers instead of an impression.
        '--dsh-drag-log', join(dataDir, 'dsh-codex-pets-drag.log'),
      ], { stdio: ['pipe', 'pipe', 'pipe'], env })
      child = started
      // The window takes `size N`, `sessions …`, and `workspaces …` on stdin.
      // It says `open <id>` when a session row is clicked, and `ask {…}` when
      // a new-session question is submitted. A window that is already gone
      // must not turn a late write into an uncaught error.
      started.stdin.on('error', () => {})
      started.stdout.on('error', () => {})
      // Electron talks to its own stderr a lot; keep only the end, for a crash.
      let noise = ''
      started.stderr.on('error', () => {})
      started.stderr.on('data', (chunk) => {
        noise = (noise + chunk.toString('utf8')).slice(-1500)
      })
      let pending = ''
      started.stdout.on('data', (chunk) => {
        pending += chunk.toString('utf8')
        let newline = pending.indexOf('\n')
        while (newline !== -1) {
          const line = pending.slice(0, newline).trim()
          pending = pending.slice(newline + 1)
          const action = helperAction(line)
          if (action?.type === 'activate') pushWire('activate\n')
          else if (action?.type === 'open') {
            pushWire('activate\n')
            focus.publish(action.id)
          } else if (action?.type === 'ask') {
            startAsk(action)
          } else if (action?.type === 'settings') {
            focus.publishSettings()
          } else if (line === 'hide') {
            hidePet()
          }
          newline = pending.indexOf('\n')
        }
      })
      if (chromeWire !== 'chrome off\n') started.stdin.write(chromeWire)
      if (motionWire !== 'motion off\n') started.stdin.write(motionWire)
      if (sessionWire !== 'sessions []\n') started.stdin.write(sessionWire)
      if (workspaceWire !== 'workspaces []\n') started.stdin.write(workspaceWire)
      started.on('error', (error) => {
        if (child === started) child = null
        ctx.logger?.warn?.(`dsh-codex-pets: failed to start the pet window: ${error.message}`)
      })
      started.on('exit', (code, signal) => {
        if (child === started) child = null
        if (code !== null && code !== 0) ctx.logger?.warn?.(`dsh-codex-pets: pet window exited (${code}) ${noise.trim().split('\n').at(-1) ?? ''}`)
        else if (signal !== null && signal !== 'SIGTERM') ctx.logger?.debug?.(`dsh-codex-pets: pet window stopped (${signal})`)
      })
    }

    // Electron arrives late on a first run, or after a retry from Settings.
    const offRuntime = runtime.subscribe((state) => {
      if (state.status !== 'ready' || child !== null || !current.visible || stopped) return
      // After this listener returns. Starting from inside the status update
      // re-enters ensure() on the same stack.
      queueMicrotask(() => {
        if (child === null && current.visible && !stopped) start()
      })
    })

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

    /** The stored title. `default-workspace` is renamed when the menu draws it. */
    const workspaceTitle = (workspace) => {
      const raw = typeof workspace?.title === 'string' ? workspace.title.replace(/[\r\n\t]+/g, ' ').trim() : ''
      if (raw !== '') return raw
      const path = typeof workspace?.path === 'string' ? workspace.path : ''
      return path.split(/[/\\]/).filter(Boolean).at(-1) ?? ''
    }

    const pushWorkspaces = () => {
      const registry = safeGet('workspaceRegistry')
      let rows = []
      if (registry != null && typeof registry.list === 'function') {
        try {
          rows = registry.list().map((workspace) => ({ id: workspace?.id, title: workspaceTitle(workspace) }))
        } catch (error) {
          ctx.logger?.debug?.(`dsh-codex-pets: workspace list failed: ${error instanceof Error ? error.message : error}`)
        }
      }
      const line = workspacesLine(rows)
      if (line !== workspaceWire) pushWire(line)
    }

    // One question at a time. The session is created and prompted here, and
    // left running in that workspace. The page is not opened.
    let asks = Promise.resolve()
    startAsk = (ask) => {
      if (ask === null) return
      asks = asks.then(async () => {
        const controller = safeGet('sessionController')
        if (controller == null || typeof controller.create !== 'function' || typeof controller.prompt !== 'function') {
          ctx.logger?.warn?.('dsh-codex-pets: cannot start a session; sessionController is missing')
          return
        }
        const created = await controller.create({ workspaceId: ask.workspaceId })
        const sessionId = created?.sessionId
        if (!isSessionId(sessionId)) throw new Error('session create returned no id')
        await controller.prompt({
          sessionId,
          mode: 'queue',
          requestId: randomUUID(),
          content: [{ type: 'text', text: ask.text }],
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }, AbortSignal.timeout(30_000))
        ctx.logger?.info?.(`dsh-codex-pets: new session ${sessionId}`)
      }).catch((error) => {
        ctx.logger?.warn?.(`dsh-codex-pets: new session failed: ${error instanceof Error ? error.message : error}`)
      })
    }
    let busy = false
    let serviceQuietUntil = 0
    const tick = async () => {
      if (stopped) return
      pushWorkspaces()
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
        const workspaces = listedWorkspaces(safeGet('workspaceRegistry'))
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
                workspaces,
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
        if (items === null) items = readCachedSessions(current.sessionLimit, workspaces)
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
        shortcut: current.shortcut,
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
      if (current.shortcut !== before.shortcut && child !== null && child.stdin?.writable) {
        child.stdin.write(`shortcut ${JSON.stringify(current.shortcut)}\n`)
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
      offRuntime()
      stopPoll()
      stop()
    }
  }, `dsh-codex-pets: floating ${current.pet}`)
}
