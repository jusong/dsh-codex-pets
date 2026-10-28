/**
 * Tests for installing and deleting pets from the settings page: the host's
 * install / remove / reorder / codex-pets / import-codex routes and the store.
 *
 * Hermetic: the plugin is copied into a temp project, the registry is a local
 * HTTP server, `CODEX_HOME` and `DSH_CODEX_PETS_USER_DIR` point at temp folders, and
 * the atlases are header-only stand-ins with a tag appended so that different
 * pets have different bytes.
 *
 *   node tools/test-pet-management.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let checks = 0
const ok = (condition, message) => { assert.ok(condition, message); checks += 1 }
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks += 1 }

function webpVP8X(width, height, tag) {
  const body = Buffer.alloc(18)
  body.write('VP8X', 0, 'latin1')
  body.writeUInt32LE(10, 4)
  body.writeUIntLE(width - 1, 12, 3)
  body.writeUIntLE(height - 1, 15, 3)
  const header = Buffer.alloc(12)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(4 + body.length, 4)
  header.write('WEBP', 8, 'latin1')
  return Buffer.concat([header, body, Buffer.alloc(16), Buffer.from(tag)])
}
const v1 = (tag) => webpVP8X(1536, 1872, tag)
const v2 = (tag) => webpVP8X(1536, 2288, tag)

/** A minimal asar: the 16-byte pickle header, the JSON index, then the files. */
function asarWith(files) {
  const header = { files: {} }
  const chunks = []
  let offset = 0
  for (const [path, bytes] of Object.entries(files)) {
    const parts = path.split('/').filter(Boolean)
    let node = header
    for (const part of parts.slice(0, -1)) {
      node.files[part] ??= { files: {} }
      node = node.files[part]
    }
    node.files[parts.at(-1)] = { size: bytes.length, offset: `${offset}` }
    chunks.push(bytes)
    offset += bytes.length
  }
  const json = Buffer.from(JSON.stringify(header))
  const head = Buffer.alloc(16)
  head.writeUInt32LE(4, 0)
  head.writeUInt32LE(8 + json.length, 4)
  head.writeUInt32LE(4 + json.length, 8)
  head.writeUInt32LE(json.length, 12)
  return Buffer.concat([head, json, ...chunks])
}

// -- the world ---------------------------------------------------------------
const base = mkdtempSync(join(tmpdir(), 'dsh-codex-pets-manage-'))
const project = join(base, 'project')
const pets = join(project, 'pets')
const userPets = join(base, 'user-pets')
const codex = join(base, 'codex-home')
const codexPets = join(codex, 'pets')
mkdirSync(join(project, 'lib'), { recursive: true })
mkdirSync(pets)
mkdirSync(userPets)
mkdirSync(codexPets, { recursive: true })
for (const file of ['index.js', 'codex-pet.js', 'pet-store.js', 'session-ball.js', 'helper-actions.js']) {
  copyFileSync(join(ROOT, 'lib', file), join(project, 'lib', file))
}
symlinkSync(join(ROOT, 'node_modules'), join(project, 'node_modules'))

function putPet(dir, id, name, sheet, extra = {}) {
  mkdirSync(join(dir, id), { recursive: true })
  writeFileSync(join(dir, id, 'pet.json'), JSON.stringify({ id, displayName: name, spritesheetPath: 'spritesheet.webp', ...extra }))
  writeFileSync(join(dir, id, 'spritesheet.webp'), sheet)
}
const ALPHA = v2('alpha-local')
const BETA = v1('beta-local')
putPet(pets, 'alpha', 'Alpha', ALPHA, { spriteVersionNumber: 2 })
putPet(pets, 'beta', 'Beta', BETA)
putPet(pets, 'gamma', 'Gamma', v1('gamma-local'))
writeFileSync(join(pets, 'index.json'), JSON.stringify([
  { id: 'alpha', name: 'Alpha' },
  { id: 'beta', name: 'Beta' },
  { id: 'gamma', name: 'Gamma' },
], null, 2))

const appAsar = join(base, 'chatgpt', 'app.asar')
mkdirSync(dirname(appAsar), { recursive: true })
writeFileSync(appAsar, asarWith({
  '/webview/assets/codex-spritesheet-v6-51045ae208c0.webp': v2('official-codex'),
  '/webview/assets/bsod-spritesheet-v5-cc54136ce042.webp': v1('official-bsod'),
  '/webview/assets/alpha-spritesheet-v1-aaaaaaaaaaaa.webp': v1('official-alpha'),
  '/webview/assets/hoots-spritesheet-v8-bbbbbbbbbbbb.webp': BETA,
  '/webview/assets/unrelated-asset-v1-cccccccccccc.webp': Buffer.from('not an atlas at all'),
}))

putPet(codexPets, 'wangcai', 'Wangcai', v2('wangcai'), { spriteVersionNumber: 2 })
putPet(codexPets, 'beta-copy', 'Beta Copy', BETA)
putPet(codexPets, 'gamma', 'Not Gamma', v1('different-gamma'))
mkdirSync(join(codexPets, 'broken'))
writeFileSync(join(codexPets, 'broken', 'pet.json'), '{ nope')
putPet(codexPets, 'Mixed Case', 'Mixed', v1('mixed'))
mkdirSync(join(codexPets, 'no-manifest'))

const remoteSheets = {
  'remote-whale': { name: 'Remote Whale', bytes: v1('remote-whale'), version: 1 },
  'remote-v2': { name: 'Remote V2', bytes: v2('remote-v2'), version: 2 },
  'twin-of-alpha': { name: 'Twin', bytes: ALPHA, version: 2 },
  alpha: { name: 'Another Alpha', bytes: v1('alpha-remote'), version: 1 },
  'huge-pet': { name: 'Huge', bytes: v1('x'), version: 1, tooLarge: true },
  'bad-pet': { name: 'Bad', bytes: Buffer.from('this is not an image, not even close'), version: 1 },
}
const registry = createServer((request, response) => {
  const url = new URL(request.url, 'http://x')
  const send = (status, type, body) => { response.writeHead(status, { 'content-type': type }); response.end(body) }
  const meta = /^\/api\/pets\/([^/]+)$/.exec(url.pathname)
  if (meta) {
    const entry = remoteSheets[meta[1]]
    if (!entry) return send(404, 'application/json', '{"error":"not found"}')
    return send(200, 'application/json', JSON.stringify({ pet: {
      id: meta[1], displayName: entry.name, spritesheetPath: 'spritesheet.webp', spriteVersionNumber: entry.version,
      spritesheetUrl: `http://127.0.0.1:${registry.address().port}/assets/${meta[1]}.webp`,
    } }))
  }
  const asset = /^\/assets\/([^/]+)\.webp$/.exec(url.pathname)
  if (asset && remoteSheets[asset[1]]) return send(200, 'image/webp', remoteSheets[asset[1]].bytes)
  return send(404, 'text/plain', 'no')
})
await new Promise((resolve) => registry.listen(0, '127.0.0.1', resolve))
const registryUrl = `http://127.0.0.1:${registry.address().port}`

process.env.DSH_CODEX_PETS_REGISTRY = registryUrl
process.env.CODEX_HOME = codex
process.env.DSH_CODEX_PETS_USER_DIR = userPets
process.env.DSH_CODEX_PETS_CODEX_ASAR = appAsar

const store = await import(pathToFileURL(join(project, 'lib', 'pet-store.js')).href)
const host = await import(pathToFileURL(join(project, 'lib', 'index.js')).href)
const routes = new Map()
// The pet on the desktop; a `.get()` ref, so a test can change it mid-run.
let currentPet = 'alpha'
host.apply({
  logger: { info() {}, warn() {}, debug() {} },
  inject(_names, callback) {
    callback({ effect(fn) { fn(); return () => {} }, connection: { fetch: { register: (route) => routes.set(route.path, route) } } })
  },
  effect() {},
  on: () => () => {},
}, { pet: { get: () => currentPet }, size: 180 })

const get = async (path) => { const r = await routes.get(path).fetch(new Request(`http://x${path}`)); return { status: r.status, body: await r.json() } }
const post = async (path, body) => {
  const r = await routes.get(path).fetch(new Request(`http://x${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
  }))
  return { status: r.status, body: await r.json() }
}
const ids = async () => (await get('/api/dsh-codex-pets/pets')).body.pets.map((p) => p.id)
const galleryPets = async () => (await get('/api/dsh-codex-pets/pets')).body.pets
const stagings = () => readdirSync(tmpdir()).filter((name) => name.startsWith('dsh-codex-pets-install-')).length
const stagingsBefore = stagings()

// ---------------------------------------------------------------------------
console.log('routes')
for (const path of ['install', 'remove', 'reorder', 'codex-pets', 'import-codex']) ok(routes.has(`/api/dsh-codex-pets/${path}`), `${path} route is registered`)
for (const path of ['install', 'remove', 'reorder', 'import-codex']) eq(routes.get(`/api/dsh-codex-pets/${path}`).methods, ['POST'], `${path} accepts POST only`)
eq(routes.get('/api/dsh-codex-pets/codex-pets').methods, ['GET'], 'codex-pets is a GET')

// ---------------------------------------------------------------------------
console.log('store: reading what people paste')
const { registryIdOf, uniqueId } = store
eq(registryIdOf('deepseek', registryUrl), 'deepseek', 'a bare id')
eq(registryIdOf(`${registryUrl}/#/pets/deepseek`, registryUrl), 'deepseek', 'a hash page link')
eq(uniqueId([pets, userPets], 'fresh'), 'fresh', 'a free name stays')
eq(uniqueId([pets, userPets], 'alpha'), 'alpha-2', 'a taken bundled name gets -2')

eq((await galleryPets()).filter((p) => p.bundled).map((p) => p.id), ['alpha', 'beta', 'gamma'], 'bundled pets lead and are flagged')
eq((await galleryPets()).filter((p) => !p.bundled), [], 'no user pets yet')

// ---------------------------------------------------------------------------
console.log('install')
let r = await post('/api/dsh-codex-pets/install', { source: 'remote-whale' })
eq([r.status, r.body.ok, r.body.already, r.body.pet.id, r.body.pet.name, r.body.pet.version], [200, true, false, 'remote-whale', 'Remote Whale', 1], 'an id installs')
ok((await ids()).includes('remote-whale'), 'and shows in the gallery')
ok(existsSync(join(userPets, 'remote-whale', 'pet.json')), 'under the user store')
ok(!existsSync(join(pets, 'remote-whale')), 'not under the bundled tree')
const written = JSON.parse(readFileSync(join(userPets, 'remote-whale', 'pet.json'), 'utf8'))
eq(written.source, `${registryUrl}/#/pets/remote-whale`, 'with the page it came from')
eq(JSON.parse(readFileSync(join(userPets, 'pets.json'), 'utf8')), [{ id: 'remote-whale' }], 'and is last in the user index')

r = await post('/api/dsh-codex-pets/install', { source: `${registryUrl}/#/pets/remote-whale` })
eq([r.status, r.body.already, r.body.pet.id], [200, true, 'remote-whale'], 'the same pet again is recognised')

r = await post('/api/dsh-codex-pets/install', { source: 'twin-of-alpha' })
eq([r.status, r.body.already, r.body.pet.id], [200, true, 'alpha'], 'matching bundled art is recognised')

r = await post('/api/dsh-codex-pets/install', { source: 'alpha' })
eq([r.status, r.body.already, r.body.pet.id], [200, false, 'alpha-2'], 'a different pet with a taken name gets a free id')
ok(existsSync(join(userPets, 'alpha-2', 'pet.json')), 'under the user store')
ok(readFileSync(join(pets, 'alpha', 'spritesheet.webp')).equals(ALPHA), 'bundled alpha is untouched')
eq(JSON.parse(readFileSync(join(userPets, 'pets.json'), 'utf8')), [{ id: 'remote-whale' }, { id: 'alpha-2' }], 'new installs append')

r = await post('/api/dsh-codex-pets/install', { source: 'nobody' })
eq([r.status, r.body.error.code], [404, 'not-found'], 'an unknown id is 404')
r = await post('/api/dsh-codex-pets/install', { source: 'bad-pet' })
eq([r.status, r.body.error.code], [400, 'invalid-pet'], 'a bad atlas is refused')
for (const source of ['', 'two words', 'https://evil.example/#/pets/x', 42, null]) {
  r = await post('/api/dsh-codex-pets/install', { source })
  eq([r.status, r.body.error.code], [400, 'invalid-source'], `source ${JSON.stringify(source)} is refused`)
}

const both = await Promise.all([post('/api/dsh-codex-pets/install', { source: 'remote-v2' }), post('/api/dsh-codex-pets/install', { source: 'remote-v2' })])
eq(both.map((x) => x.body.already).sort(), [false, true], 'one installs, the other sees it')
eq(JSON.parse(readFileSync(join(userPets, 'pets.json'), 'utf8')).slice(-1), [{ id: 'remote-v2' }], 'remote-v2 is at the end')

// ---------------------------------------------------------------------------
console.log('pets.json')
const { readUserPets, writeUserPets, writeUserOrder } = store
writeUserPets(userPets, [{ id: 'remote-whale', note: 'keep-me' }, { id: 'alpha-2' }, { id: 'remote-v2' }])
writeUserOrder(userPets, ['remote-v2', 'alpha-2', 'remote-whale'])
eq(readUserPets(userPets), [
  { id: 'remote-v2' },
  { id: 'alpha-2' },
  { id: 'remote-whale', note: 'keep-me' },
], 'reorder by ids keeps extra fields')

// ---------------------------------------------------------------------------
console.log('reorder')
r = await post('/api/dsh-codex-pets/reorder', { ids: ['remote-v2', 'alpha-2', 'remote-whale'] })
eq([r.status, r.body.ok, r.body.ids], [200, true, ['remote-v2', 'alpha-2', 'remote-whale']], 'user pets can be reordered')
eq((await galleryPets()).filter((p) => !p.bundled).map((p) => p.id), ['remote-v2', 'alpha-2', 'remote-whale'], 'gallery follows the new order')
eq(JSON.parse(readFileSync(join(userPets, 'pets.json'), 'utf8')).find((e) => e.id === 'remote-whale').note, 'keep-me', 'host reorder keeps extra fields')
r = await post('/api/dsh-codex-pets/reorder', { ids: ['remote-whale', 'alpha'] })
eq([r.status, r.body.error.code], [409, 'bundled'], 'a bundled id cannot be in a reorder')
r = await post('/api/dsh-codex-pets/reorder', { ids: ['remote-v2', 'remote-whale'] })
eq([r.status, r.body.error.code], [400, 'invalid-order'], 'omitting a user pet is refused')

// ---------------------------------------------------------------------------
console.log('delete')
r = await post('/api/dsh-codex-pets/remove', { id: 'alpha' })
eq([r.status, r.body.error.code], [409, 'bundled'], 'a bundled pet cannot be deleted')
ok(existsSync(join(pets, 'alpha', 'pet.json')), 'and is still there')

r = await post('/api/dsh-codex-pets/remove', { id: 'alpha-2' })
eq([r.status, r.body.ok, r.body.id, r.body.next], [200, true, 'alpha-2', null], 'a user pet is deleted, and no replacement is named for one not in use')
ok(!existsSync(join(userPets, 'alpha-2')), 'its folder is gone')
eq(JSON.parse(readFileSync(join(userPets, 'pets.json'), 'utf8')), [{ id: 'remote-v2' }, { id: 'remote-whale', note: 'keep-me' }], 'and leaves the index (extra fields kept)')

r = await post('/api/dsh-codex-pets/remove', { id: 'beta' })
eq([r.status, r.body.error.code], [409, 'bundled'], 'another bundled pet is also protected')

for (const id of ['', '../project', 'Beta', 7, null]) {
  r = await post('/api/dsh-codex-pets/remove', { id })
  eq([r.status, r.body.error.code], [400, 'invalid-id'], `id ${JSON.stringify(id)} is refused`)
}

mkdirSync(join(userPets, 'not-a-pet'))
writeFileSync(join(userPets, 'not-a-pet', 'precious.txt'), 'keep')
r = await post('/api/dsh-codex-pets/remove', { id: 'not-a-pet' })
eq([r.status, r.body.error.code], [404, 'not-installed'], 'a folder without pet.json is not deleted')

const outside = join(base, 'outside')
mkdirSync(outside)
writeFileSync(join(outside, 'keep.txt'), 'keep')
symlinkSync(outside, join(userPets, 'linked'))
r = await post('/api/dsh-codex-pets/remove', { id: 'linked' })
eq([r.status, r.body.ok], [200, true], 'a symlinked user pet can be removed')
ok(!existsSync(join(userPets, 'linked')) && existsSync(join(outside, 'keep.txt')), 'by unlinking it')

r = await post('/api/dsh-codex-pets/remove', { id: 'remote-whale' })
eq(r.status, 200, 'an installed pet is deleted')
r = await post('/api/dsh-codex-pets/install', { source: 'remote-whale' })
eq([r.status, r.body.pet.id], [200, 'remote-whale'], 'and can be installed again')
eq(JSON.parse(readFileSync(join(userPets, 'pets.json'), 'utf8')).slice(-1), [{ id: 'remote-whale' }], 're-install joins the end')

// The pet on the desktop is deletable too: the answer names its replacement.
currentPet = 'remote-whale'
r = await post('/api/dsh-codex-pets/remove', { id: 'remote-whale' })
eq([r.status, r.body.ok, r.body.next], [200, true, 'alpha'], 'the pet in use is deleted, and the answer names the replacement')
ok(!existsSync(join(userPets, 'remote-whale')), 'its folder is gone')
currentPet = 'alpha'

// ---------------------------------------------------------------------------
console.log('import from Codex')
let list = (await get('/api/dsh-codex-pets/codex-pets')).body.pets
const status = Object.fromEntries(list.map((p) => [p.folder, p.status]))
eq(status, {
  'Mixed Case': 'ready', 'beta-copy': 'installed', broken: 'failed', gamma: 'taken', wangcai: 'ready',
  // shipped inside ChatGPT.app rather than installed into ~/.codex/pets
  alpha: 'taken', bsod: 'ready', codex: 'ready', hoots: 'installed',
}, 'each Codex pet says what importing would do')
eq(list.find((p) => p.folder === 'beta-copy').installedAs, 'beta', 'same art under the bundled name')
const names = Object.fromEntries(list.map((p) => [p.id, p.name]))
eq([names.codex, names.bsod, names.hoots], ['Codex', 'BSOD', 'Hoots'], 'the app pets carry their real names')
eq(list.find((p) => p.id === 'alpha').status, 'taken', 'a shipped pet whose id is taken is not offered')
eq(list.filter((p) => p.id === 'codex').length, 1, 'a pet in both places is listed once')

r = await post('/api/dsh-codex-pets/import-codex', {})
eq(r.status, 200, 'import answers 200')
eq(r.body.installed.map((p) => p.id).sort(), ['bsod', 'codex', 'mixed-case', 'wangcai'], 'the new pets are imported, app pets included')
ok(existsSync(join(userPets, 'wangcai', 'pet.json')), 'into the user store')
ok(!existsSync(join(pets, 'wangcai')), 'not into the bundled tree')
eq(JSON.parse(readFileSync(join(userPets, 'codex', 'pet.json'), 'utf8')).source, 'Codex app bundle (ChatGPT.app)',
  'an app pet records where it came from')
ok(existsSync(join(base, 'cache', 'dsh-codex-pets', 'codex-app', 'codex', 'spritesheet.webp')), 'the atlas is extracted next to the user store')
const orderAfter = JSON.parse(readFileSync(join(userPets, 'pets.json'), 'utf8')).map((e) => e.id)
ok(orderAfter.indexOf('wangcai') > orderAfter.indexOf('remote-whale'), 'imported pets append after earlier installs')

r = await post('/api/dsh-codex-pets/import-codex', {})
eq(r.body.installed, [], 'importing again installs nothing')

process.env.CODEX_HOME = join(base, 'no-such-codex')
process.env.DSH_CODEX_PETS_CODEX_ASAR = join(base, 'no-such-app.asar')
eq((await get('/api/dsh-codex-pets/codex-pets')).body.pets, [], 'with no Codex on this machine there is nothing to list')
process.env.CODEX_HOME = codex
process.env.DSH_CODEX_PETS_CODEX_ASAR = appAsar

registry.close()
r = await post('/api/dsh-codex-pets/install', { source: 'remote-v2-again' })
eq([r.status, r.body.error.code], [502, 'unreachable'], 'a registry that is down is 502')

eq(stagings(), stagingsBefore, 'no staging folder is left')

// A store left at the pre-rename path moves on the first start, pets and all.
const fakeHome = join(base, 'home')
mkdirSync(join(fakeHome, '.dsh', 'pets', 'kept'), { recursive: true })
writeFileSync(join(base, 'migrate-probe.mjs'), `
  const { migrateLegacyUserDir, userPetsDir } = await import(${JSON.stringify(pathToFileURL(join(project, 'lib', 'pet-store.js')).href)})
  process.stdout.write(JSON.stringify({ dir: userPetsDir(), first: migrateLegacyUserDir(), second: migrateLegacyUserDir() }))
`)
const migrated = JSON.parse(execFileSync(process.execPath, [join(base, 'migrate-probe.mjs')], {
  encoding: 'utf8',
  env: { ...process.env, HOME: fakeHome, DSH_CODEX_PETS_USER_DIR: '' },
}))
eq(migrated.dir, join(fakeHome, '.dsh', 'dsh-codex-pets'), 'the user store moves to the new name')
eq(migrated.first, migrated.dir, 'the old store is moved, not copied')
ok(existsSync(join(migrated.dir, 'kept')), 'with the installed pets')
eq(migrated.second, null, 'and only once')

rmSync(base, { recursive: true, force: true })
console.log(`\npet management: ${checks} checks passed`)
