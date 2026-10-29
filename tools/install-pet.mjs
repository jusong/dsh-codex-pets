#!/usr/bin/env node
/**
 * Install pets made for Codex into the user pet store (`~/.dsh/dsh-codex-pets/pets`).
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
 * and is installed as `~/.dsh/dsh-codex-pets/pets/<id>/` holding the `pet.json`
 * and the atlas. That is the whole Codex format, so a pet needs nothing else:
 * the plugin fills in the rows and timings the Codex contract fixes, and the
 * settings page picks the pet up on its next refresh. Nothing has to be
 * registered. Shipped pets stay in the plugin's `pets/`; installs never land
 * there.
 *
 * Options
 *   --id <id>           install under another directory name (one source only)
 *   --force             replace a pet that is already installed under that id
 *   --codex-home        read bare ids from ~/.codex/pets instead of the registry
 *   --registry <url>    another registry host (default https://codex-pets.net)
 *   --pets-dir <dir>    install somewhere else (default: ~/.dsh/dsh-codex-pets/pets)
 *   --dry-run           check the source and say what would happen
 *
 * No dependencies: Node 18+, and `unzip` (macOS has it) for zip packages.
 */
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_REGISTRY, MAX_ATLAS_BYTES, StoreError, appendUserOrder, download, inspectPet, installPet,
  registryIdOf, stageFromRegistry, stageFromZip, userPetsDir,
} from '../lib/pet-store.js'

// -- arguments ---------------------------------------------------------------

export function parseArgs(argv) {
  const options = {
    sources: [], id: null, force: false, codexHome: false, dryRun: false,
    registry: DEFAULT_REGISTRY, petsDir: userPetsDir(), help: false,
  }
  const needsValue = (flag, value) => {
    if (value === undefined || value.startsWith('--')) throw new StoreError('usage', `${flag} needs a value`)
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
    else if (arg.startsWith('--')) throw new StoreError('usage', `unknown option ${arg}`)
    else options.sources.push(arg)
  }
  if (options.id !== null && options.sources.length > 1) {
    throw new StoreError('usage', '--id names one pet, but several sources were given')
  }
  return options
}

// -- reading a source ----------------------------------------------------------

/**
 * What kind of source an argument is.
 *
 * Paths are told from registry ids by their shape: an id is a bare word, so
 * anything with a slash or a leading `.` or `~` is a path.
 */
export function classifySource(arg, options) {
  if (/^https?:\/\//i.test(arg)) {
    const id = registryIdOf(arg, options.registry)
    return id !== null ? { kind: 'registry', id } : { kind: 'zip-url', url: arg }
  }
  if (/[\\/]/.test(arg) || arg.startsWith('.') || arg.startsWith('~')) {
    const path = resolve(arg.startsWith('~') ? join(homedir(), arg.slice(1)) : arg)
    return { kind: path.toLowerCase().endsWith('.zip') ? 'zip-file' : 'folder', path }
  }
  if (options.codexHome) return { kind: 'folder', path: join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'pets', arg) }
  return { kind: 'registry', id: arg }
}

// -- main ----------------------------------------------------------------------

/** Install every source; returns the process exit code. */
export async function run(argv, log = console.log) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    if (!(error instanceof StoreError)) throw error
    log(`${error.message}\n\n${usage()}`)
    return 2
  }
  if (options.help || options.sources.length === 0) {
    log(usage())
    return options.help ? 0 : 2
  }

  let failures = 0
  for (const arg of options.sources) {
    const staging = mkdtempSync(join(tmpdir(), 'dsh-codex-pets-install-'))
    try {
      const source = classifySource(arg, options)
      let folder = staging
      let origin = arg
      let fallbackId = ''
      if (source.kind === 'registry') {
        ;({ origin, fallbackId } = await stageFromRegistry(source.id, options.registry, staging))
      } else if (source.kind === 'zip-url') {
        const zipPath = join(staging, 'download.zip')
        writeFileSync(zipPath, await download(source.url, MAX_ATLAS_BYTES))
        folder = stageFromZip(zipPath, staging)
      } else if (source.kind === 'zip-file') {
        if (!existsSync(source.path)) throw new StoreError('invalid-source', `${source.path} does not exist`)
        folder = stageFromZip(source.path, staging)
        origin = basename(source.path)
        fallbackId = basename(source.path, extname(source.path))
      } else {
        if (!existsSync(source.path) || !statSync(source.path).isDirectory()) throw new StoreError('invalid-source', `${source.path} is not a folder`)
        folder = source.path
        origin = `folder ${source.path}`
        fallbackId = basename(source.path)
      }
      const pet = inspectPet(folder, { fallbackId })
      for (const note of pet.notes) log(`  note: ${note}`)
      const done = installPet(pet, { petsDir: options.petsDir, id: options.id, force: options.force, dryRun: options.dryRun, origin })
      if (!options.dryRun) appendUserOrder(options.petsDir, done.id)
      const looks = done.look ? 'follows the cursor' : 'no look directions (v1 atlas)'
      log(`${arg}: ${options.dryRun ? 'would install' : 'installed'} ${done.id}: "${done.name}", v${done.version} atlas, ${looks}`)
    } catch (error) {
      if (!(error instanceof StoreError)) throw error
      failures += 1
      log(`${arg}: FAILED - ${error.message}`)
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }
  return failures === 0 ? 0 : 1
}

function usage() {
  return `Install pets made for Codex into ~/.dsh/dsh-codex-pets.

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
  --pets-dir <dir>  install somewhere else (default: ~/.dsh/dsh-codex-pets)
  --dry-run         check only`
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code })
}
