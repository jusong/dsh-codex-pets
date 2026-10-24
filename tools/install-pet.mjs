#!/usr/bin/env node
/**
 * Install pets made for Codex into this project's `pets/`.
 *
 *   node tools/install-pet.mjs deepseek
 *   node tools/install-pet.mjs https://codex-pets.net/#/pets/deepseek
 *   node tools/install-pet.mjs ~/Downloads/deepseek.zip
 *   node tools/install-pet.mjs ~/.codex/pets/wangcai
 *   node tools/install-pet.mjs --codex-home wangcai blue-whale-girl
 *
 * A source is one of
 *
 *   an id or a codex-pets.net page   fetched from the registry's API
 *   a folder with pet.json           e.g. anything under ~/.codex/pets
 *   a .zip (file or URL)             the package the site's Download gives
 *
 * and is installed as `pets/<id>/` holding the `pet.json` and the atlas. That
 * is the whole Codex format, so a pet needs nothing else: the plugin fills in
 * the rows and timings the Codex contract fixes, and the settings page picks
 * the pet up on its next refresh. Nothing has to be registered.
 *
 * Options
 *   --id <id>           install under another directory name (one source only)
 *   --force             replace a pet that is already installed under that id
 *   --codex-home        read bare ids from ~/.codex/pets instead of the registry
 *   --registry <url>    another registry host (default https://codex-pets.net)
 *   --pets-dir <dir>    install somewhere else (default: this project's pets/)
 *   --dry-run           check the source and say what would happen
 *
 * No dependencies: Node 18+, and `unzip` (macOS has it) for zip packages.
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ID_PATTERN, SHAPES, normalizeManifest, readImageSize, slugify, versionOfAtlas } from '../lib/codex-pet.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_PETS_DIR = join(HERE, '..', 'pets')
const DEFAULT_REGISTRY = 'https://codex-pets.net'
const MAX_ATLAS_BYTES = 32 * 1024 * 1024
const SHEET_EXTENSIONS = new Set(['.webp', '.png'])

class InstallError extends Error {}

// -- arguments ---------------------------------------------------------------

export function parseArgs(argv) {
  const options = {
    sources: [], id: null, force: false, codexHome: false, dryRun: false,
    registry: DEFAULT_REGISTRY, petsDir: DEFAULT_PETS_DIR, help: false,
  }
  const needsValue = (flag, value) => {
    if (value === undefined || value.startsWith('--')) throw new InstallError(`${flag} needs a value`)
    return value
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--force') options.force = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--codex-home') options.codexHome = true
    else if (arg === '--id') options.id = needsValue(arg, argv[++i])
    else if (arg === '--registry') options.registry = needsValue(arg, argv[++i]).replace(/\/+$/, '')
    else if (arg === '--pets-dir') options.petsDir = resolve(needsValue(arg, argv[++i]))
    else if (arg.startsWith('--')) throw new InstallError(`unknown option ${arg}`)
    else options.sources.push(arg)
  }
  if (options.id !== null && options.sources.length > 1) {
    throw new InstallError('--id names one pet, but several sources were given')
  }
  return options
}

// -- reading a source into a staging folder -----------------------------------

/**
 * What kind of source an argument is.
 *
 * Paths are told from registry ids by their shape: an id is a bare word, so
 * anything with a slash or a leading `.` or `~` is a path.
 */
export function classifySource(arg, options) {
  if (/^https?:\/\//i.test(arg)) {
    const url = new URL(arg)
    const page = /\/pets\/([^/?#]+)/.exec(`${url.pathname}${url.hash.replace(/^#/, '')}`)
    // A page of the registry, in either the hash or the path form.
    if (page !== null && url.origin === new URL(options.registry).origin && !url.pathname.endsWith('/download')) {
      return { kind: 'registry', id: decodeURIComponent(page[1]) }
    }
    return { kind: 'zip-url', url: arg }
  }
  if (/[\\/]/.test(arg) || arg.startsWith('.') || arg.startsWith('~')) {
    const path = resolve(arg.startsWith('~') ? join(homedir(), arg.slice(1)) : arg)
    return { kind: path.toLowerCase().endsWith('.zip') ? 'zip-file' : 'folder', path }
  }
  if (options.codexHome) return { kind: 'folder', path: join(homedir(), '.codex', 'pets', arg) }
  return { kind: 'registry', id: arg }
}

async function download(url, limit) {
  if (!url.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)) {
    throw new InstallError(`refusing to download over plain http: ${url}`)
  }
  let response
  try {
    response = await fetch(url, { headers: { 'user-agent': 'dsh-pet-installer' } })
  } catch (error) {
    throw new InstallError(`cannot reach ${url}: ${error.cause?.code ?? error.message}`)
  }
  if (!response.ok) throw new InstallError(`${url} answered ${response.status}`)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > limit) throw new InstallError(`${url} is ${declared} bytes, over the ${limit} byte limit`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > limit) throw new InstallError(`${url} is over the ${limit} byte limit`)
  return bytes
}

/** Stage a pet from the registry's API: its manifest and its atlas. */
async function stageFromRegistry(id, options, staging) {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new InstallError(`"${id}" is not a pet id`)
  const apiUrl = `${options.registry}/api/pets/${encodeURIComponent(id)}`
  let payload
  try {
    payload = JSON.parse((await download(apiUrl, 1024 * 1024)).toString('utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) throw new InstallError(`${apiUrl} did not answer with JSON`)
    if (error instanceof InstallError && /answered 404/.test(error.message)) {
      throw new InstallError(`no pet "${id}" on ${options.registry}`)
    }
    throw error
  }
  const pet = payload.pet
  if (pet === null || typeof pet !== 'object' || typeof pet.spritesheetUrl !== 'string') {
    throw new InstallError(`${apiUrl} has no pet with an atlas`)
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
  return { origin: `${options.registry}/#/pets/${pet.id ?? id}`, fallbackId: id }
}

/** Unpack a zip into the staging folder and move into the pet's own folder. */
function stageFromZip(zipPath, staging) {
  try {
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', join(staging, 'unzipped')], { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (error) {
    if (error.code === 'ENOENT') throw new InstallError('unzip is not installed, so zip packages cannot be opened')
    throw new InstallError(`cannot open ${zipPath} as a zip: ${String(error.stderr ?? error.message).trim()}`)
  }
  // The package holds pet.json at its top, or inside one folder.
  const root = join(staging, 'unzipped')
  const folders = [root, ...readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== '__MACOSX').map((d) => join(root, d.name))]
  const found = folders.find((folder) => existsSync(join(folder, 'pet.json')))
  if (found === undefined) throw new InstallError(`${zipPath} has no pet.json`)
  return found
}

// -- checking and installing --------------------------------------------------

/**
 * Check one staged pet against the Codex contract.
 *
 * Returns what to install; throws an InstallError saying what is wrong
 * otherwise. The atlas must be exactly one of the two shapes Codex draws,
 * because the rows are only meaningful on that grid.
 */
export function inspectPet(folder, { fallbackId = '' } = {}) {
  const manifestPath = join(folder, 'pet.json')
  if (!existsSync(manifestPath)) throw new InstallError('no pet.json')
  let raw
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    throw new InstallError('pet.json is not valid JSON')
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new InstallError('pet.json is not an object')

  const sheet = typeof raw.spritesheetPath === 'string' ? raw.spritesheetPath : ''
  if (sheet === '') throw new InstallError('pet.json has no spritesheetPath')
  // The file sits next to pet.json: a bare name, never a path out of the folder.
  if (sheet === '.' || sheet === '..' || basename(sheet) !== sheet || sheet.includes('\\')) {
    throw new InstallError(`spritesheetPath "${sheet}" must be a file name in the pet's folder`)
  }
  const extension = extname(sheet).toLowerCase()
  if (!SHEET_EXTENSIONS.has(extension)) throw new InstallError(`the atlas must be .webp or .png, not "${extension}"`)
  const sheetPath = join(folder, sheet)
  if (!existsSync(sheetPath)) throw new InstallError(`the atlas ${sheet} is missing`)
  if (statSync(sheetPath).size > MAX_ATLAS_BYTES) throw new InstallError(`the atlas is over ${MAX_ATLAS_BYTES} bytes`)

  const head = readFileSync(sheetPath).subarray(0, 64)
  const size = readImageSize(head)
  if (size === null) throw new InstallError(`${sheet} is not a readable ${extension.slice(1).toUpperCase()} image`)
  const version = versionOfAtlas(size)
  if (version === null) {
    const wanted = Object.entries(SHAPES).map(([v, shape]) => `${1536}x${shape.height} (v${v})`).join(' or ')
    throw new InstallError(`the atlas is ${size.width}x${size.height}; a Codex atlas is ${wanted}`)
  }
  const declared = raw.spriteVersionNumber
  const notes = []
  if (declared !== undefined && declared !== 1 && declared !== 2) {
    throw new InstallError(`spriteVersionNumber must be 1 or 2, not ${JSON.stringify(declared)}`)
  }
  if ((declared ?? 1) !== version) {
    notes.push(`pet.json says version ${declared ?? 1}, but the atlas is v${version}; the atlas is used`)
  }

  const id = slugify(raw.id) || slugify(fallbackId)
  return { raw, sheet, sheetPath, extension, version, size, suggestedId: id, notes }
}

function describeOutcome(pet, id, manifest) {
  const looks = pet.version === 2 ? 'follows the cursor' : 'no look directions (v1 atlas)'
  return `${id}: "${manifest.name}", v${pet.version} atlas, ${looks}`
}

/** Install one staged pet; returns a line to print. */
export function installPet(pet, options, { origin }) {
  const id = options.id !== null ? options.id : pet.suggestedId
  if (!ID_PATTERN.test(id ?? '')) {
    throw new InstallError(`"${pet.raw.id ?? ''}" cannot be a directory name here (a-z, 0-9 and "-" only); pick one with --id`)
  }
  const target = join(options.petsDir, id)
  if (existsSync(target) && !options.force) {
    let other = ''
    try {
      other = ` ("${JSON.parse(readFileSync(join(target, 'pet.json'), 'utf8')).name ?? id}")`
    } catch { /* an unreadable pet is still in the way */ }
    throw new InstallError(`pets/${id} is already installed${other}; use --id <other-id> to keep both, or --force to replace it`)
  }

  const sheetName = `spritesheet${pet.extension}`
  const manifest = normalizeManifest({ ...pet.raw, spritesheetPath: sheetName, source: origin }, { id, atlas: pet.size })
  // `preview` is left out on purpose: the settings page cuts a thumbnail out of
  // the atlas for a pet that has none.
  delete manifest.preview
  const summary = describeOutcome(pet, id, manifest)
  if (options.dryRun) return `would install ${summary}`

  // Written aside and renamed into place, so a failure never leaves half a pet.
  mkdirSync(options.petsDir, { recursive: true })
  const partial = mkdtempSync(join(options.petsDir, `.${id}-`))
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
  return `installed ${summary}`
}

// -- main ----------------------------------------------------------------------

/** Install every source; returns the process exit code. */
export async function run(argv, log = console.log) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    log(`${error.message}\n\n${usage()}`)
    return 2
  }
  if (options.help || options.sources.length === 0) {
    log(usage())
    return options.help ? 0 : 2
  }

  let failures = 0
  for (const arg of options.sources) {
    const staging = mkdtempSync(join(tmpdir(), 'dsh-pet-install-'))
    try {
      const source = classifySource(arg, options)
      let folder = staging
      let origin = arg
      let fallbackId = ''
      if (source.kind === 'registry') {
        ;({ origin, fallbackId } = await stageFromRegistry(source.id, options, staging))
      } else if (source.kind === 'zip-url') {
        const zipPath = join(staging, 'download.zip')
        writeFileSync(zipPath, await download(source.url, MAX_ATLAS_BYTES))
        folder = stageFromZip(zipPath, staging)
      } else if (source.kind === 'zip-file') {
        if (!existsSync(source.path)) throw new InstallError(`${source.path} does not exist`)
        folder = stageFromZip(source.path, staging)
        origin = basename(source.path)
        fallbackId = basename(source.path, extname(source.path))
      } else {
        if (!existsSync(source.path) || !statSync(source.path).isDirectory()) throw new InstallError(`${source.path} is not a folder`)
        folder = source.path
        origin = `folder ${source.path}`
        fallbackId = basename(source.path)
      }
      const pet = inspectPet(folder, { fallbackId })
      for (const note of pet.notes) log(`  note: ${note}`)
      log(`${arg}: ${installPet(pet, options, { origin })}`)
    } catch (error) {
      if (!(error instanceof InstallError)) throw error
      failures += 1
      log(`${arg}: FAILED - ${error.message}`)
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }
  return failures === 0 ? 0 : 1
}

function usage() {
  return `Install pets made for Codex into pets/.

  node tools/install-pet.mjs <source>... [options]

sources
  deepseek                               a pet id on codex-pets.net
  https://codex-pets.net/#/pets/deepseek a page of the site
  ~/Downloads/deepseek.zip               a package from the site's Download
  ~/.codex/pets/wangcai                  a folder with pet.json
  --codex-home wangcai                   same, by id under ~/.codex/pets

options
  --id <id>         install under another directory name
  --force           replace a pet already installed under that id
  --registry <url>  another registry host (default ${DEFAULT_REGISTRY})
  --pets-dir <dir>  install somewhere else (default: this project's pets/)
  --dry-run         check only`
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code })
}

