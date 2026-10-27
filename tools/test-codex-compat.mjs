/**
 * Tests for Codex pet compatibility: the contract module, the host's gallery
 * and routes reading plain Codex pets, and the installer.
 *
 * Hermetic: the plugin is copied into a temp project and fed temp pets, the
 * registry is a local HTTP server, and the atlases are header-only stand-ins
 * (nothing here decodes pixels; the native side is covered by
 * `dsh-codex-pets-macos --describe`).
 *
 *   node tools/test-codex-compat.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  ANIMATIONS, normalizeManifest, readImageSize, slugify, versionOfAtlas,
} from '../lib/codex-pet.js'
import { classifySource, parseArgs, run } from './install-pet.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let checks = 0
const ok = (condition, message) => { assert.ok(condition, message); checks += 1 }
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks += 1 }

// -- fake atlases: just enough header to carry a size -----------------------

function webpVP8X(width, height) {
  const body = Buffer.alloc(18)
  body.write('VP8X', 0, 'latin1')
  body.writeUInt32LE(10, 4)
  body.writeUIntLE(width - 1, 12, 3)
  body.writeUIntLE(height - 1, 15, 3)
  const header = Buffer.alloc(12)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(4 + body.length, 4)
  header.write('WEBP', 8, 'latin1')
  return Buffer.concat([header, body, Buffer.alloc(16)])
}
function webpVP8L(width, height) {
  const out = Buffer.alloc(40)
  out.write('RIFF', 0, 'latin1'); out.write('WEBP', 8, 'latin1'); out.write('VP8L', 12, 'latin1')
  out[20] = 0x2f
  out.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 21)
  return out
}
function webpVP8(width, height) {
  const out = Buffer.alloc(40)
  out.write('RIFF', 0, 'latin1'); out.write('WEBP', 8, 'latin1'); out.write('VP8 ', 12, 'latin1')
  out[23] = 0x9d; out[24] = 0x01; out[25] = 0x2a
  out.writeUInt16LE(width, 26); out.writeUInt16LE(height, 28)
  return out
}
function png(width, height) {
  const out = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(out)
  out.writeUInt32BE(13, 8); out.write('IHDR', 12, 'latin1')
  out.writeUInt32BE(width, 16); out.writeUInt32BE(height, 20)
  return out
}
const V1 = webpVP8X(1536, 1872)
const V2 = webpVP8X(1536, 2288)

// ---------------------------------------------------------------------------
console.log('contract module')

eq(readImageSize(V1), { width: 1536, height: 1872 }, 'VP8X size')
eq(readImageSize(webpVP8L(1536, 2288)), { width: 1536, height: 2288 }, 'VP8L (lossless) size')
eq(readImageSize(webpVP8(1536, 1872)), { width: 1536, height: 1872 }, 'VP8 (lossy) size')
eq(readImageSize(png(1536, 2288)), { width: 1536, height: 2288 }, 'PNG size')
eq(readImageSize(Buffer.from('not an image at all, just text........')), null, 'garbage has no size')
eq(readImageSize(Buffer.alloc(3)), null, 'a short buffer has no size')
const shipped = readFileSync(join(ROOT, 'pets', 'deepseek-whale', 'spritesheet.webp')).subarray(0, 64)
eq(readImageSize(shipped), { width: 1536, height: 1872 }, 'a real shipped atlas reads as v1')

eq(versionOfAtlas({ width: 1536, height: 1872 }), 1, '1536x1872 is v1')
eq(versionOfAtlas({ width: 1536, height: 2288 }), 2, '1536x2288 is v2')
eq(versionOfAtlas({ width: 1536, height: 2000 }), null, 'other sizes are not Codex atlases')
eq(versionOfAtlas(null), null, 'unknown size')

eq(slugify('Blue Whale Girl'), 'blue-whale-girl', 'slug of a name')
eq(slugify('蓝鲸娘'), '', 'a name with no ascii has no slug')
eq(slugify('../../etc'), 'etc', 'a path is flattened')
eq(slugify(undefined), '', 'nothing has no slug')

const bare = { id: 'p', displayName: 'Pee', description: 'd', spritesheetPath: 'spritesheet.webp' }
const v1 = normalizeManifest(bare, { id: 'p', atlas: { width: 1536, height: 1872 } })
eq(v1.grid, { columns: 8, rows: 9 }, 'a v1 atlas has 9 rows')
eq(v1.look, undefined, 'a v1 pet has no look directions')
eq(v1.spriteVersionNumber, 1, 'v1 by the atlas')
eq(v1.name, 'Pee', 'displayName becomes the name')
eq(v1.animations, ANIMATIONS, 'the contract animations fill in')
eq(v1.drag, { right: 'running-right', left: 'running-left' }, 'drag rows fill in')
const v2 = normalizeManifest(bare, { id: 'p', atlas: { width: 1536, height: 2288 } })
eq(v2.grid.rows, 11, 'a v2 atlas has 11 rows')
eq(v2.look.rows, [9, 10], 'a v2 pet looks')
eq(v2.look.count, 16, 'with 16 directions')
eq(normalizeManifest({ ...bare, spriteVersionNumber: 1 }, { id: 'p', atlas: { width: 1536, height: 2288 } }).spriteVersionNumber, 2,
  'the atlas wins over a wrong spriteVersionNumber')
eq(normalizeManifest({ ...bare, spriteVersionNumber: 2 }, { id: 'p' }).spriteVersionNumber, 2, 'the declared version is used without an atlas')
eq(normalizeManifest({}, { id: 'only-id' }).name, 'only-id', 'the id is the last resort for a name')
const full = JSON.parse(readFileSync(join(ROOT, 'pets', 'deepseek-whale', 'pet.json'), 'utf8'))
const again = normalizeManifest(full, { id: 'deepseek-whale', atlas: { width: 1536, height: 1872 } })
for (const key of ['name', 'animations', 'drag', 'react', 'idleRoutine', 'perform', 'grid', 'cell', 'size', 'preview']) {
  eq(again[key], full[key], `a full manifest keeps its own ${key}`)
}
eq(again.look, undefined, 'a v1 shipped pet has no look rows')

// ---------------------------------------------------------------------------
console.log('host: gallery and routes with plain Codex pets')

const project = mkdtempSync(join(tmpdir(), 'dsh-codex-pets-compat-'))
mkdirSync(join(project, 'lib'))
for (const file of ['index.js', 'codex-pet.js', 'pet-store.js', 'session-ball.js']) copyFileSync(join(ROOT, 'lib', file), join(project, 'lib', file))
symlinkSync(join(ROOT, 'node_modules'), join(project, 'node_modules'))
const pets = join(project, 'pets')
const userPets = join(project, 'user-pets')
mkdirSync(pets)
mkdirSync(userPets)
process.env.DSH_CODEX_PETS_USER_DIR = userPets

function putPet(root, dir, manifest, sheets = {}) {
  const folder = join(root, dir)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'pet.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
  for (const [name, bytes] of Object.entries(sheets)) writeFileSync(join(folder, name), bytes)
}
// Bundled tree: only `index.json` pets appear in the gallery. Extra folders
 // here are fixtures for the installer / route negative cases.
putPet(pets, 'indexed', { id: 'indexed', name: 'Indexed', spritesheetPath: 'spritesheet.webp', preview: 'preview.png' }, { 'spritesheet.webp': V2, 'preview.png': png(600, 600) })
putPet(pets, 'evil', { id: 'evil', displayName: 'Evil', spritesheetPath: '../outside.webp' }, {})
writeFileSync(join(pets, 'outside.webp'), V2)
putPet(pets, 'Bad_Name', { id: 'x', displayName: 'Bad', spritesheetPath: 'spritesheet.webp' }, { 'spritesheet.webp': V2 })
putPet(pets, 'broken-json', '{ not json', { 'spritesheet.webp': V2 })
// Installer source fixtures (not listed in index → not in the gallery).
putPet(pets, 'zeta-v1', { id: 'zeta-v1', displayName: 'Zeta', spritesheetPath: 'spritesheet.webp', kind: 'object' }, { 'spritesheet.webp': V1 })
putPet(pets, 'alpha-v2', { id: 'alpha-v2', displayName: 'Alpha', description: 'a v2 pet', spritesheetPath: 'spritesheet.webp', spriteVersionNumber: 2 }, { 'spritesheet.webp': V2 })
putPet(pets, 'folder-name', { id: 'something-else', displayName: 'Folder Name', spritesheetPath: 'sheet.png' }, { 'sheet.png': png(1536, 1872) })
writeFileSync(join(pets, 'index.json'), JSON.stringify([{ id: 'indexed' }, { id: 'ghost' }]))
// User installs are what the gallery shows after the bundled block.
putPet(userPets, 'zeta-v1', { id: 'zeta-v1', displayName: 'Zeta', spritesheetPath: 'spritesheet.webp', kind: 'object' }, { 'spritesheet.webp': V1 })
putPet(userPets, 'alpha-v2', { id: 'alpha-v2', displayName: 'Alpha', description: 'a v2 pet', spritesheetPath: 'spritesheet.webp', spriteVersionNumber: 2 }, { 'spritesheet.webp': V2 })
putPet(userPets, 'no-version', { id: 'no-version', displayName: 'No Version', spritesheetPath: 'spritesheet.webp' }, { 'spritesheet.webp': V2 })
putPet(userPets, 'folder-name', { id: 'something-else', displayName: 'Folder Name', spritesheetPath: 'sheet.png' }, { 'sheet.png': png(1536, 1872) })
putPet(userPets, 'no-sheet', { id: 'no-sheet', displayName: 'No Sheet', spritesheetPath: 'missing.webp' }, {})
putPet(userPets, 'evil-preview', { id: 'evil-preview', displayName: 'EP', spritesheetPath: 'spritesheet.webp', preview: '../outside.webp' }, { 'spritesheet.webp': V2 })

const host = await import(pathToFileURL(join(project, 'lib', 'index.js')).href)
const routes = new Map()
host.apply({
  logger: { info() {}, warn() {}, debug() {} },
  inject(_names, callback) {
    callback({ effect(fn) { fn(); return () => {} }, connection: { fetch: { register: (route) => routes.set(route.path, route) } } })
  },
  effect() {},
  on: () => () => {},
}, { pet: 'indexed', size: 180 })
const call = (path, query = '') => routes.get(path).fetch(new Request(`http://x${path}${query}`))

const gallery = (await (await call('/api/dsh-codex-pets/pets')).json()).pets
eq(gallery.map((p) => p.id), ['indexed', 'alpha-v2', 'evil-preview', 'folder-name', 'no-version', 'zeta-v1'],
  'bundled index first, then user pets by name; broken, unsafe and invalid ones are left out')
eq(gallery.find((p) => p.id === 'indexed').bundled, true, 'an indexed pet is bundled')
eq(gallery.filter((p) => !p.bundled).map((p) => p.id), ['alpha-v2', 'evil-preview', 'folder-name', 'no-version', 'zeta-v1'], 'user pets are not bundled')
const byId = Object.fromEntries(gallery.map((p) => [p.id, p]))
eq(byId['zeta-v1'].name, 'Zeta', 'displayName is the gallery name')
eq(byId['zeta-v1'].grid, { columns: 8, rows: 9 }, 'a v1 pet has 9 rows')
eq(byId['zeta-v1'].look, undefined, 'a v1 pet has no look rows')
eq(byId['zeta-v1'].version, 1, 'version 1')
eq(byId['alpha-v2'].look.rows, [9, 10], 'a v2 pet looks')
eq(byId['alpha-v2'].description, 'a v2 pet', 'the description comes through')
eq(byId['no-version'].grid.rows, 11, 'with no spriteVersionNumber the atlas decides: v2')
eq(byId['no-version'].version, 2, 'version 2 by the atlas')
eq(byId['folder-name'].grid.rows, 9, 'a png atlas works too')
eq(byId['folder-name'].id, 'folder-name', 'the directory name is the id, not what the manifest calls itself')
eq(byId['zeta-v1'].animations.idle.durations.length, 6, 'the idle row has the contract frames')
eq(byId['indexed'].hasPreview, true, 'a pet with a preview says so')
eq(byId['zeta-v1'].hasPreview, false, 'a Codex pet has no preview file')
eq(byId['evil-preview'].hasPreview, false, 'a preview path out of the folder is dropped')

const sheetOf = async (id) => call('/api/dsh-codex-pets/sprite', `?id=${id}`)
const webp = await sheetOf('zeta-v1')
eq([webp.status, webp.headers.get('content-type')], [200, 'image/webp'], 'a webp atlas is served as webp')
eq(Buffer.from(await webp.arrayBuffer()).equals(V1), true, 'with its own bytes')
eq((await sheetOf('folder-name')).headers.get('content-type'), 'image/png', 'a png atlas is served as png')
eq((await sheetOf('evil')).status, 404, 'an atlas path that leaves the folder is refused')
eq((await sheetOf('no-sheet')).status, 404, 'a missing atlas is 404')
eq((await sheetOf('Bad_Name')).status, 404, 'an invalid directory name is 404')
eq((await sheetOf('..')).status, 404, '".." is 404')
eq((await call('/api/dsh-codex-pets/preview', '?id=zeta-v1')).status, 404, 'no preview file is 404, so the page cuts its own')
eq((await call('/api/dsh-codex-pets/preview', '?id=indexed')).headers.get('content-type'), 'image/png', 'a preview is served')

// ---------------------------------------------------------------------------
console.log('installer')

const logs = []
const install = async (...argv) => { logs.length = 0; const code = await run(argv, (line) => logs.push(line)); return { code, out: logs.join('\n') } }
const dest = join(project, 'installed')
const folderOf = (id) => join(dest, id)
const stagings = () => readdirSync(tmpdir()).filter((name) => name.startsWith('dsh-codex-pets-install-')).length
const stagingsBefore = stagings()

eq(parseArgs(['a', '--force', '--id', 'x']).force, true, 'flags parse')
assert.throws(() => parseArgs(['--id']), /needs a value/); checks += 1
assert.throws(() => parseArgs(['--nope']), /unknown option/); checks += 1
assert.throws(() => parseArgs(['a', 'b', '--id', 'x']), /one pet/); checks += 1
const opts = { registry: 'https://codex-pets.net' }
eq(classifySource('deepseek', opts), { kind: 'registry', id: 'deepseek' }, 'a bare word is a registry id')
eq(classifySource('https://codex-pets.net/#/pets/deepseek', opts), { kind: 'registry', id: 'deepseek' }, 'a hash page is a registry id')
eq(classifySource('https://codex-pets.net/pets/deepseek', opts), { kind: 'registry', id: 'deepseek' }, 'a path page is a registry id')
eq(classifySource('https://codex-pets.net/api/pets/deepseek/download', opts).kind, 'zip-url', 'the download link is a zip')
eq(classifySource('https://example.com/x.zip', opts).kind, 'zip-url', 'any other URL is a zip')
eq(classifySource('./pets/x', opts).kind, 'folder', 'a relative path is a folder')
eq(classifySource('/tmp/x.zip', opts).kind, 'zip-file', 'a .zip path is a zip file')
eq(classifySource('wangcai', { ...opts, codexHome: true }).kind, 'folder', '--codex-home makes an id a folder')

// a folder
let result = await install('--pets-dir', dest, join(pets, 'zeta-v1'))
eq(result.code, 0, 'a folder installs')
ok(/installed zeta-v1: "Zeta", v1 atlas/.test(result.out), 'and says what it installed')
const installed = JSON.parse(readFileSync(join(folderOf('zeta-v1'), 'pet.json'), 'utf8'))
eq(installed.displayName, 'Zeta', 'the Codex fields are kept')
eq(installed.kind, 'object', 'including kind')
eq(installed.name, 'Zeta', 'and a name is added')
eq(installed.grid.rows, 9, 'the grid is spelled out')
eq(installed.animations, ANIMATIONS, 'with the animations')
eq(installed.spritesheetPath, 'spritesheet.webp', 'and the atlas name')
eq('look' in installed, false, 'a v1 pet gets no look')
eq('preview' in installed, false, 'and no preview is claimed')
ok(installed.source.startsWith('folder '), 'the source is recorded')
eq(readFileSync(join(folderOf('zeta-v1'), 'spritesheet.webp')).equals(V1), true, 'the atlas is copied unchanged')
eq(readdirSync(dest).filter((name) => name.startsWith('.')).length, 0, 'no partial folder is left behind')

// collisions
result = await install('--pets-dir', dest, join(pets, 'zeta-v1'))
eq(result.code, 1, 'installing over an existing pet fails')
ok(/already installed \("Zeta"\).*--id.*--force/.test(result.out), 'and says how to go on')
result = await install('--pets-dir', dest, '--id', 'zeta-two', join(pets, 'zeta-v1'))
eq(result.code, 0, '--id keeps both')
ok(existsSync(folderOf('zeta-two')), 'under the new name')
eq(JSON.parse(readFileSync(join(folderOf('zeta-two'), 'pet.json'), 'utf8')).id, 'zeta-two', 'whose manifest id follows the directory')
writeFileSync(join(pets, 'zeta-v1', 'pet.json'), JSON.stringify({ id: 'zeta-v1', displayName: 'Zeta Renamed', spritesheetPath: 'spritesheet.webp' }))
result = await install('--pets-dir', dest, '--force', join(pets, 'zeta-v1'))
eq(result.code, 0, '--force replaces')
eq(JSON.parse(readFileSync(join(folderOf('zeta-v1'), 'pet.json'), 'utf8')).name, 'Zeta Renamed', 'with the new content')

// dry run
result = await install('--pets-dir', dest, '--dry-run', join(pets, 'alpha-v2'))
ok(/would install alpha-v2.*v2 atlas, follows the cursor/.test(result.out), 'a dry run says what would happen')
eq(existsSync(folderOf('alpha-v2')), false, 'and writes nothing')

// a v2 pet, a png atlas, a mismatch note
result = await install('--pets-dir', dest, join(pets, 'alpha-v2'), join(pets, 'folder-name'))
eq(result.code, 0, 'two folders install in one go')
eq(JSON.parse(readFileSync(join(folderOf('alpha-v2'), 'pet.json'), 'utf8')).look.rows, [9, 10], 'a v2 pet keeps its look rows')
eq(JSON.parse(readFileSync(join(folderOf('something-else'), 'pet.json'), 'utf8')).spritesheetPath, 'spritesheet.png', 'a png atlas keeps its extension')
putPet(pets, 'wrong-version', { id: 'wrong-version', displayName: 'W', spritesheetPath: 'spritesheet.webp', spriteVersionNumber: 1 }, { 'spritesheet.webp': V2 })
result = await install('--pets-dir', dest, join(pets, 'wrong-version'))
ok(/note: pet.json says version 1, but the atlas is v2/.test(result.out), 'a wrong version number is noted')
eq(JSON.parse(readFileSync(join(folderOf('wrong-version'), 'pet.json'), 'utf8')).spriteVersionNumber, 2, 'and the atlas wins')

// things that must be refused
const refuse = async (label, manifest, sheets, pattern, extra = []) => {
  putPet(pets, `bad-${label}`, manifest, sheets)
  const out = await install('--pets-dir', dest, ...extra, join(pets, `bad-${label}`))
  eq(out.code, 1, `${label}: refused`)
  ok(pattern.test(out.out), `${label}: says why (${out.out.split('\n').pop()})`)
}
await refuse('size', { id: 'a', spritesheetPath: 'spritesheet.webp' }, { 'spritesheet.webp': webpVP8X(1536, 2000) }, /a Codex atlas is 1536x1872 \(v1\) or 1536x2288 \(v2\)/)
await refuse('nosheet', { id: 'b', spritesheetPath: 'spritesheet.webp' }, {}, /atlas spritesheet.webp is missing/)
await refuse('traversal', { id: 'c', spritesheetPath: '../outside.webp' }, {}, /must be a file name/)
await refuse('dotdot', { id: 'c2', spritesheetPath: '..' }, {}, /must be a file name/)
await refuse('empty', { id: 'd' }, {}, /no spritesheetPath/)
await refuse('format', { id: 'e', spritesheetPath: 'sheet.gif' }, { 'sheet.gif': V1 }, /\.webp or \.png/)
await refuse('garbage', { id: 'f', spritesheetPath: 'spritesheet.webp' }, { 'spritesheet.webp': Buffer.from('this is not an image at all, sorry') }, /not a readable WEBP image/)
await refuse('version', { id: 'g', spritesheetPath: 'spritesheet.webp', spriteVersionNumber: 3 }, { 'spritesheet.webp': V1 }, /spriteVersionNumber must be 1 or 2/)
await refuse('json', '{ nope', { 'spritesheet.webp': V1 }, /not valid JSON/)
await refuse('array', '[]', { 'spritesheet.webp': V1 }, /not an object/)
// A pet whose id is not ascii takes its folder's name; with neither usable it must be named.
putPet(pets, 'bad-noascii', { id: '蓝鲸娘', displayName: '蓝鲸娘', spritesheetPath: 'spritesheet.webp' }, { 'spritesheet.webp': V1 })
result = await install('--pets-dir', dest, join(pets, 'bad-noascii'))
ok(result.code === 0 && existsSync(folderOf('bad-noascii')), 'a non-ascii id falls back to the folder name')
eq(JSON.parse(readFileSync(join(folderOf('bad-noascii'), 'pet.json'), 'utf8')).name, '蓝鲸娘', 'and the display name stays Chinese')
putPet(pets, '蓝鲸娘', { id: '蓝鲸娘', displayName: '蓝鲸娘', spritesheetPath: 'spritesheet.webp' }, { 'spritesheet.webp': V1 })
result = await install('--pets-dir', dest, join(pets, '蓝鲸娘'))
ok(result.code === 1 && /cannot be a directory name.*--id/.test(result.out), 'with no usable name at all, --id is asked for')
result = await install('--pets-dir', dest, '--id', 'blue-whale', join(pets, '蓝鲸娘'))
ok(result.code === 0 && existsSync(folderOf('blue-whale')), 'and --id solves it')
result = await install('--pets-dir', dest, '--id', '../escape', join(pets, 'zeta-v1'))
eq(result.code, 1, 'an --id with a path is refused')
eq(existsSync(join(project, 'escape')), false, 'and nothing is written outside the pets folder')
result = await install('--pets-dir', dest, '--id', 'Upper', join(pets, 'zeta-v1'))
eq(result.code, 1, 'an --id with capitals is refused')
result = await install('--pets-dir', dest, join(project, 'does-not-exist'))
ok(/not a folder/.test(result.out) && result.code === 1, 'a missing folder is refused')
result = await install('--pets-dir', dest, join(pets, 'zeta-v1'), join(pets, 'bad-size'))
eq(result.code, 1, 'one failure among several sources fails the run')
result = await install()
eq(result.code, 2, 'no source prints usage and exits 2')
eq((await install('--help')).code, 0, '--help exits 0')

// a zip
const zipSource = join(project, 'zip-src')
mkdirSync(join(zipSource, 'inner'), { recursive: true })
writeFileSync(join(zipSource, 'inner', 'pet.json'), JSON.stringify({ id: 'zippy', displayName: 'Zippy', spritesheetPath: 'spritesheet.webp', spriteVersionNumber: 2 }))
writeFileSync(join(zipSource, 'inner', 'spritesheet.webp'), V2)
execFileSync('zip', ['-q', '-r', join(project, 'nested.zip'), 'inner'], { cwd: zipSource })
execFileSync('zip', ['-q', '-j', join(project, 'flat.zip'), join(zipSource, 'inner', 'pet.json'), join(zipSource, 'inner', 'spritesheet.webp')])
result = await install('--pets-dir', dest, join(project, 'flat.zip'))
ok(result.code === 0 && existsSync(join(folderOf('zippy'), 'spritesheet.webp')), 'a flat zip installs')
result = await install('--pets-dir', dest, '--id', 'zippy-nested', join(project, 'nested.zip'))
ok(result.code === 0 && existsSync(join(folderOf('zippy-nested'), 'spritesheet.webp')), 'a zip with one folder inside installs')
writeFileSync(join(project, 'empty.zip'), '')
execFileSync('zip', ['-q', join(project, 'nopet.zip'), join(zipSource, 'inner', 'spritesheet.webp')])
eq((await install('--pets-dir', dest, join(project, 'nopet.zip'))).code, 1, 'a zip without pet.json is refused')
eq((await install('--pets-dir', dest, join(project, 'empty.zip'))).code, 1, 'a broken zip is refused')

// a registry, served locally
const registry = createServer((request, response) => {
  const url = new URL(request.url, 'http://x')
  const send = (status, type, body) => { response.writeHead(status, { 'content-type': type }); response.end(body) }
  const match = /^\/api\/pets\/([^/]+)$/.exec(url.pathname)
  if (match && match[1] === 'remote-whale') {
    return send(200, 'application/json', JSON.stringify({ pet: {
      id: 'remote-whale', displayName: 'Remote Whale', description: 'from the registry', spritesheetPath: 'spritesheet.webp',
      spriteVersionNumber: 1, kind: 'animal', spritesheetUrl: `http://127.0.0.1:${registry.address().port}/assets/remote-whale.webp`,
    } }))
  }
  if (match && match[1] === 'remote-v2') {
    return send(200, 'application/json', JSON.stringify({ pet: {
      id: 'remote-v2', displayName: 'Remote V2', spritesheetPath: 'spritesheet.webp', spriteVersionNumber: 2,
      spritesheetUrl: `http://127.0.0.1:${registry.address().port}/assets/remote-v2.webp`,
    } }))
  }
  if (match && match[1] === 'remote-http') {
    return send(200, 'application/json', JSON.stringify({ pet: { id: 'remote-http', spritesheetPath: 'spritesheet.webp', spritesheetUrl: 'http://example.com/x.webp' } }))
  }
  if (url.pathname === '/assets/remote-whale.webp') return send(200, 'image/webp', V1)
  if (url.pathname === '/assets/remote-v2.webp') return send(200, 'image/webp', V2)
  if (url.pathname === '/not-json') return send(200, 'text/html', '<html>')
  return send(404, 'application/json', '{"error":"not found"}')
})
await new Promise((resolveListen) => registry.listen(0, '127.0.0.1', resolveListen))
const base = `http://127.0.0.1:${registry.address().port}`

result = await install('--pets-dir', dest, '--registry', base, 'remote-whale')
ok(result.code === 0, 'a registry id installs')
const remote = JSON.parse(readFileSync(join(folderOf('remote-whale'), 'pet.json'), 'utf8'))
eq([remote.displayName, remote.description, remote.kind, remote.spriteVersionNumber], ['Remote Whale', 'from the registry', 'animal', 1], 'with the registry metadata')
eq(remote.source, `${base}/#/pets/remote-whale`, 'and the page it came from')
eq(readFileSync(join(folderOf('remote-whale'), 'spritesheet.webp')).equals(V1), true, 'and the atlas bytes')
result = await install('--pets-dir', dest, '--registry', base, `${base}/#/pets/remote-v2`)
ok(result.code === 0 && existsSync(folderOf('remote-v2')), 'a registry page URL installs')
eq(JSON.parse(readFileSync(join(folderOf('remote-v2'), 'pet.json'), 'utf8')).look.rows, [9, 10], 'a registry v2 pet looks')
result = await install('--pets-dir', dest, '--registry', base, 'nobody')
ok(result.code === 1 && /no pet "nobody"/.test(result.out), 'an unknown id says so')
result = await install('--pets-dir', dest, '--registry', base, 'remote-http')
ok(result.code === 1 && /plain http/.test(result.out), 'an atlas over plain http is refused')
result = await install('--pets-dir', dest, '--registry', 'http://127.0.0.1:1', 'whatever')
ok(result.code === 1 && /cannot reach/.test(result.out), 'an unreachable registry is explained')
result = await install('--pets-dir', dest, '--registry', base, 'bad id!')
ok(result.code === 1 && /not a pet id/.test(result.out), 'an odd id is refused before any request')
registry.close()

// installed pets are served by the host from the user store
for (const id of ['zeta-v1', 'remote-whale', 'zippy']) {
  rmSync(join(userPets, id), { recursive: true, force: true })
  execFileSync('cp', ['-R', folderOf(id), join(userPets, id)])
}
const after = (await (await call('/api/dsh-codex-pets/pets')).json()).pets.map((p) => p.id)
for (const id of ['zeta-v1', 'remote-whale', 'zippy']) ok(after.includes(id), `an installed pet (${id}) shows in the gallery with no registration`)
ok(after.find((id) => id === 'indexed') === 'indexed', 'the bundled pet still leads')
const zippy = (await (await call('/api/dsh-codex-pets/pets')).json()).pets.find((p) => p.id === 'zippy')
eq(zippy.bundled, false, 'a user install is not bundled')
eq(zippy.look.rows, [9, 10], 'and carries its look rows')
eq((await sheetOf('remote-whale')).status, 200, 'and its atlas is served')

eq(stagings(), stagingsBefore, 'no staging folder is left in the temp directory')
rmSync(project, { recursive: true, force: true })
console.log(`\ncodex compat: ${checks} checks passed`)
