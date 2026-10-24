/**
 * The pet store: put pets into `pets/` and take them out again.
 *
 * Shared by the installer CLI (`tools/install-pet.mjs`) and by the host's
 * routes, so a pet is checked and written the same way whichever door it
 * comes through. Everything takes the pets directory as an argument; nothing
 * here knows where the plugin lives.
 *
 * Failures that the person at the keyboard can act on are `StoreError`s with
 * a stable `code`, so the settings page can word them in its own language.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { ID_PATTERN, SHAPES, normalizeManifest, readImageSize, slugify, versionOfAtlas } from './codex-pet.js'

export const DEFAULT_REGISTRY = 'https://codex-pets.net'
export const MAX_ATLAS_BYTES = 32 * 1024 * 1024
const SHEET_EXTENSIONS = new Set(['.webp', '.png'])

/** A failure the user can act on. `code` is stable; `message` is English. */
export class StoreError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.code = code
    this.details = details
  }
}

// -- where Codex keeps its pets ----------------------------------------------

/** `$CODEX_HOME/pets`, the folder Codex itself installs pets into. */
export function codexPetsDir() {
  return join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'pets')
}

// -- fetching ------------------------------------------------------------------

export async function download(url, limit) {
  if (!url.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)) {
    throw new StoreError('insecure', `refusing to download over plain http: ${url}`)
  }
  let response
  try {
    response = await fetch(url, { headers: { 'user-agent': 'dsh-pet' }, signal: AbortSignal.timeout(60_000) })
  } catch (error) {
    throw new StoreError('unreachable', `cannot reach ${url}: ${error.cause?.code ?? error.message}`)
  }
  if (response.status === 404) throw new StoreError('not-found', `${url} answered 404`)
  if (!response.ok) throw new StoreError('unreachable', `${url} answered ${response.status}`)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > limit) throw new StoreError('too-large', `${url} is ${declared} bytes, over the ${limit} byte limit`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > limit) throw new StoreError('too-large', `${url} is over the ${limit} byte limit`)
  return bytes
}

/**
 * The registry pet an id or a page link of the registry names, or null.
 *
 * This is what the settings page accepts: a bare id (`deepseek`), or a link
 * copied from the address bar (`https://codex-pets.net/#/pets/deepseek`, or
 * the path form). Links to any other site are not a pet of the registry.
 */
export function registryIdOf(text, registry = DEFAULT_REGISTRY) {
  const value = String(text ?? '').trim()
  if (value === '') return null
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) return value
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.origin !== new URL(registry).origin || url.pathname.endsWith('/download')) return null
  const page = /\/pets\/([^/?#]+)/.exec(`${url.pathname}${url.hash.replace(/^#/, '')}`)
  return page === null ? null : decodeURIComponent(page[1])
}

/** Stage a pet from the registry's API: its manifest and its atlas. */
export async function stageFromRegistry(id, registry, staging) {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new StoreError('invalid-source', `"${id}" is not a pet id`)
  const apiUrl = `${registry}/api/pets/${encodeURIComponent(id)}`
  let payload
  try {
    payload = JSON.parse((await download(apiUrl, 1024 * 1024)).toString('utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) throw new StoreError('unreachable', `${apiUrl} did not answer with JSON`)
    if (error instanceof StoreError && error.code === 'not-found') {
      throw new StoreError('not-found', `no pet "${id}" on ${registry}`, { id })
    }
    throw error
  }
  const pet = payload.pet
  if (pet === null || typeof pet !== 'object' || typeof pet.spritesheetUrl !== 'string') {
    throw new StoreError('invalid-pet', `${apiUrl} has no pet with an atlas`)
  }
  const sheetName = typeof pet.spritesheetPath === 'string' && pet.spritesheetPath !== '' ? basename(pet.spritesheetPath) : 'spritesheet.webp'
  const manifest = {
    id: pet.id ?? id,
    displayName: pet.displayName ?? '',
    description: pet.description ?? '',
    spritesheetPath: sheetName,
    ...(pet.spriteVersionNumber === 2 ? { spriteVersionNumber: 2 } : {}),
    ...(typeof pet.kind === 'string' ? { kind: pet.kind } : {}),
  }
  writeFileSync(join(staging, 'pet.json'), JSON.stringify(manifest))
  writeFileSync(join(staging, sheetName), await download(pet.spritesheetUrl, MAX_ATLAS_BYTES))
  return { origin: `${registry}/#/pets/${pet.id ?? id}`, fallbackId: id }
}

/** Unpack a zip into the staging folder; returns the folder holding pet.json. */
export function stageFromZip(zipPath, staging) {
  try {
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', join(staging, 'unzipped')], { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (error) {
    if (error.code === 'ENOENT') throw new StoreError('no-unzip', 'unzip is not installed, so zip packages cannot be opened')
    throw new StoreError('invalid-pet', `cannot open ${zipPath} as a zip: ${String(error.stderr ?? error.message).trim()}`)
  }
  // The package holds pet.json at its top, or inside one folder.
  const root = join(staging, 'unzipped')
  const folders = [root, ...readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== '__MACOSX').map((d) => join(root, d.name))]
  const found = folders.find((folder) => existsSync(join(folder, 'pet.json')))
  if (found === undefined) throw new StoreError('invalid-pet', `${zipPath} has no pet.json`)
  return found
}

// -- checking and installing ---------------------------------------------------

/**
 * Check one staged pet against the Codex contract.
 *
 * Returns what to install; throws a StoreError saying what is wrong
 * otherwise. The atlas must be exactly one of the two shapes Codex draws,
 * because the rows are only meaningful on that grid.
 */
export function inspectPet(folder, { fallbackId = '' } = {}) {
  const manifestPath = join(folder, 'pet.json')
  if (!existsSync(manifestPath)) throw new StoreError('invalid-pet', 'no pet.json')
  let raw
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    throw new StoreError('invalid-pet', 'pet.json is not valid JSON')
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new StoreError('invalid-pet', 'pet.json is not an object')

  const sheet = typeof raw.spritesheetPath === 'string' ? raw.spritesheetPath : ''
  if (sheet === '') throw new StoreError('invalid-pet', 'pet.json has no spritesheetPath')
  // The file sits next to pet.json: a bare name, never a path out of the folder.
  if (sheet === '.' || sheet === '..' || basename(sheet) !== sheet || sheet.includes('\\')) {
    throw new StoreError('invalid-pet', `spritesheetPath "${sheet}" must be a file name in the pet's folder`)
  }
  const extension = extname(sheet).toLowerCase()
  if (!SHEET_EXTENSIONS.has(extension)) throw new StoreError('invalid-pet', `the atlas must be .webp or .png, not "${extension}"`)
  const sheetPath = join(folder, sheet)
  if (!existsSync(sheetPath)) throw new StoreError('invalid-pet', `the atlas ${sheet} is missing`)
  if (statSync(sheetPath).size > MAX_ATLAS_BYTES) throw new StoreError('too-large', `the atlas is over ${MAX_ATLAS_BYTES} bytes`)

  const size = readImageSize(readFileSync(sheetPath).subarray(0, 64))
  if (size === null) throw new StoreError('invalid-pet', `${sheet} is not a readable ${extension.slice(1).toUpperCase()} image`)
  const version = versionOfAtlas(size)
  if (version === null) {
    const wanted = Object.entries(SHAPES).map(([v, shape]) => `1536x${shape.height} (v${v})`).join(' or ')
    throw new StoreError('invalid-pet', `the atlas is ${size.width}x${size.height}; a Codex atlas is ${wanted}`)
  }
  const declared = raw.spriteVersionNumber
  const notes = []
  if (declared !== undefined && declared !== 1 && declared !== 2) {
    throw new StoreError('invalid-pet', `spriteVersionNumber must be 1 or 2, not ${JSON.stringify(declared)}`)
  }
  if ((declared ?? 1) !== version) {
    notes.push(`pet.json says version ${declared ?? 1}, but the atlas is v${version}; the atlas is used`)
  }

  const id = slugify(raw.id) || slugify(fallbackId)
  return { raw, sheet, sheetPath, extension, version, size, suggestedId: id, notes }
}

/**
 * Install one inspected pet as `<petsDir>/<id>/`.
 *
 * Returns `{ id, name, version, look }`. Refuses an id that is taken unless
 * `force`; with `dryRun` it only checks and writes nothing.
 */
export function installPet(pet, { petsDir, id = null, force = false, dryRun = false, origin = '' }) {
  const chosen = id !== null ? id : pet.suggestedId
  if (!ID_PATTERN.test(chosen ?? '')) {
    throw new StoreError('invalid-id', `"${pet.raw.id ?? ''}" cannot be a directory name here (a-z, 0-9 and "-" only); pick one with --id`)
  }
  const target = join(petsDir, chosen)
  if (existsSync(target) && !force) {
    let other = ''
    try {
      other = ` ("${JSON.parse(readFileSync(join(target, 'pet.json'), 'utf8')).name ?? chosen}")`
    } catch { /* an unreadable pet is still in the way */ }
    throw new StoreError('exists', `pets/${chosen} is already installed${other}; use --id <other-id> to keep both, or --force to replace it`, { id: chosen })
  }

  const sheetName = `spritesheet${pet.extension}`
  const manifest = normalizeManifest({ ...pet.raw, spritesheetPath: sheetName, source: origin }, { id: chosen, atlas: pet.size })
  // `preview` is left out on purpose: the settings page cuts a thumbnail out of
  // the atlas for a pet that has none.
  delete manifest.preview
  const result = { id: chosen, name: manifest.name, version: pet.version, look: pet.version === 2 }
  if (dryRun) return result

  // Written aside and renamed into place, so a failure never leaves half a pet.
  mkdirSync(petsDir, { recursive: true })
  const partial = mkdtempSync(join(petsDir, `.${chosen}-`))
  try {
    copyFileSync(pet.sheetPath, join(partial, sheetName))
    writeFileSync(join(partial, 'pet.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    chmodSync(partial, 0o755)
    if (existsSync(target)) rmSync(target, { recursive: true })
    renameSync(partial, target)
  } catch (error) {
    rmSync(partial, { recursive: true, force: true })
    throw error
  }
  return result
}

/**
 * A directory name for `base` that is not taken: `base`, then `base-2`, ...
 *
 * Used where there is nobody to ask (the settings page), so that a pet whose
 * name is already in use is installed next to the old one instead of failing.
 */
export function uniqueId(petsDir, base) {
  let id = base
  for (let n = 2; existsSync(join(petsDir, id)); n += 1) id = `${base}-${n}`
  return id
}

// -- removing ------------------------------------------------------------------

/**
 * Delete an installed pet's directory.
 *
 * Only a real directory of the pets folder that holds a `pet.json` is ever
 * removed -- an id is never trusted as a path, and a symlink is unlinked
 * rather than followed -- so this cannot be talked into deleting anything
 * that is not a pet.
 */
export function removePet(petsDir, id) {
  if (!ID_PATTERN.test(String(id ?? ''))) throw new StoreError('invalid-id', `"${id}" is not a pet id`)
  const target = join(petsDir, id)
  let stat
  try {
    stat = lstatSync(target)
  } catch {
    throw new StoreError('not-installed', `pets/${id} does not exist`, { id })
  }
  if (stat.isSymbolicLink()) {
    unlinkSync(target)
    return
  }
  if (!stat.isDirectory() || !existsSync(join(target, 'pet.json'))) {
    throw new StoreError('not-installed', `pets/${id} is not a pet`, { id })
  }
  rmSync(target, { recursive: true })
}

// -- what Codex already has on this machine ---------------------------------------

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** The installed pet whose atlas is this very file, or null. */
export function findSameArt(petsDir, sheetPath) {
  const size = statSync(sheetPath).size
  let hash = null
  let ids = []
  try {
    ids = readdirSync(petsDir, { withFileTypes: true }).filter((d) => d.isDirectory() && ID_PATTERN.test(d.name)).map((d) => d.name)
  } catch { /* no pets yet */ }
  for (const id of ids) {
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(petsDir, id, 'pet.json'), 'utf8'))
    } catch { continue }
    const sheet = typeof manifest?.spritesheetPath === 'string' ? manifest.spritesheetPath : ''
    if (sheet === '' || basename(sheet) !== sheet) continue
    const file = join(petsDir, id, sheet)
    try {
      if (statSync(file).size !== size) continue
      hash ??= sha256(sheetPath)
      if (sha256(file) === hash) return id
    } catch { /* unreadable: not a match */ }
  }
  return null
}

/**
 * Look through the pets Codex has installed on this machine.
 *
 * Each entry says what importing it would do: `ready`, or why not. The
 * folder name is the id (it is the name the person knows the pet by; the
 * `id` inside `pet.json` is not unique to a folder).
 */
export function scanCodexPets(petsDir, codexDir = codexPetsDir()) {
  let folders = []
  try {
    folders = readdirSync(codexDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort()
  } catch {
    return []
  }
  const entries = []
  for (const folder of folders) {
    const path = join(codexDir, folder)
    if (!existsSync(join(path, 'pet.json'))) continue
    const entry = { folder, path, id: slugify(folder), name: folder, status: 'ready', pet: null, error: null }
    try {
      const pet = inspectPet(path, { fallbackId: folder })
      entry.pet = pet
      entry.id = slugify(folder) || pet.suggestedId
      entry.name = [pet.raw.displayName, pet.raw.name].find((v) => typeof v === 'string' && v !== '') ?? folder
      entry.version = pet.version
      const same = findSameArt(petsDir, pet.sheetPath)
      if (same !== null) Object.assign(entry, { status: 'installed', installedAs: same })
      else if (!ID_PATTERN.test(entry.id)) Object.assign(entry, { status: 'failed', error: 'invalid-id' })
      else if (existsSync(join(petsDir, entry.id))) Object.assign(entry, { status: 'taken' })
    } catch (error) {
      if (!(error instanceof StoreError)) throw error
      Object.assign(entry, { status: 'failed', error: error.code, message: error.message })
    }
    entries.push(entry)
  }
  return entries
}

/**
 * Import every Codex pet that is not here yet.
 *
 * Returns `{ installed, skipped, failed }`. A pet whose art is already
 * installed (under any name) is skipped, and so is one whose folder name is
 * taken by a different pet: importing never replaces anything.
 */
export function importCodexPets(petsDir, codexDir = codexPetsDir()) {
  const result = { installed: [], skipped: [], failed: [] }
  for (const entry of scanCodexPets(petsDir, codexDir)) {
    if (entry.status === 'installed') result.skipped.push({ id: entry.installedAs, name: entry.name, reason: 'installed' })
    else if (entry.status === 'taken') result.skipped.push({ id: entry.id, name: entry.name, reason: 'taken' })
    else if (entry.status === 'failed') result.failed.push({ folder: entry.folder, name: entry.name, code: entry.error, message: entry.message ?? entry.error })
    else {
      try {
        result.installed.push(installPet(entry.pet, { petsDir, id: entry.id, origin: `codex ${entry.path}` }))
      } catch (error) {
        if (!(error instanceof StoreError)) throw error
        result.failed.push({ folder: entry.folder, name: entry.name, code: error.code, message: error.message })
      }
    }
  }
  return result
}
