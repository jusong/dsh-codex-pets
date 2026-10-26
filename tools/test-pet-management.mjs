/**
 * Tests for installing and deleting pets from the settings page: the host's
 * install / remove / codex-pets / import-codex routes and the store they use.
 *
 * Hermetic: the plugin is copied into a temp project, the registry is a local
 * HTTP server, `CODEX_HOME` points at a temp folder, and the atlases are
 * header-only stand-ins with a tag appended so that different pets have
 * different bytes.
 *
 *   node tools/test-pet-management.mjs
 */
import assert from 'node:assert/strict'
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

// -- the world ---------------------------------------------------------------
const base = mkdtempSync(join(tmpdir(), 'dsh-pet-manage-'))
const project = join(base, 'project')
const pets = join(project, 'pets')
const codex = join(base, 'codex-home')
const codexPets = join(codex, 'pets')
mkdirSync(join(project, 'lib'), { recursive: true })
mkdirSync(pets)
mkdirSync(codexPets, { recursive: true })
for (const file of ['index.js', 'codex-pet.js', 'pet-store.js', 'session-ball.js']) copyFileSync(join(ROOT, 'lib', file), join(project, 'lib', file))
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

// What Codex has: a new pet, the same art as beta, a different pet named like
// beta, a broken one, and one whose folder name needs tidying.
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

process.env.DSH_PET_REGISTRY = registryUrl
process.env.CODEX_HOME = codex

const store = await import(pathToFileURL(join(project, 'lib', 'pet-store.js')).href)
const host = await import(pathToFileURL(join(project, 'lib', 'index.js')).href)
const routes = new Map()
host.apply({
  logger: { info() {}, warn() {}, debug() {} },
  inject(_names, callback) {
    callback({ effect(fn) { fn(); return () => {} }, connection: { fetch: { register: (route) => routes.set(route.path, route) } } })
  },
  effect() {},
  on: () => () => {},
}, { pet: 'alpha', size: 180 })

const get = async (path) => { const r = await routes.get(path).fetch(new Request(`http://x${path}`)); return { status: r.status, body: await r.json() } }
const post = async (path, body) => {
  const r = await routes.get(path).fetch(new Request(`http://x${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
  }))
  return { status: r.status, body: await r.json() }
}
const ids = async () => (await get('/api/dsh-pet/pets')).body.pets.map((p) => p.id)
const stagings = () => readdirSync(tmpdir()).filter((name) => name.startsWith('dsh-pet-install-')).length
const stagingsBefore = stagings()

// ---------------------------------------------------------------------------
console.log('routes')
for (const path of ['install', 'remove', 'codex-pets', 'import-codex']) ok(routes.has(`/api/dsh-pet/${path}`), `${path} route is registered`)
for (const path of ['install', 'remove', 'import-codex']) eq(routes.get(`/api/dsh-pet/${path}`).methods, ['POST'], `${path} accepts POST only`)
eq(routes.get('/api/dsh-pet/codex-pets').methods, ['GET'], 'codex-pets is a GET')

// ---------------------------------------------------------------------------
console.log('store: reading what people paste')
const { registryIdOf, uniqueId } = store
eq(registryIdOf('deepseek', registryUrl), 'deepseek', 'a bare id')
eq(registryIdOf('  deepseek \n', registryUrl), 'deepseek', 'an id with whitespace around it')
eq(registryIdOf(`${registryUrl}/#/pets/deepseek`, registryUrl), 'deepseek', 'a hash page link')
eq(registryIdOf(`${registryUrl}/pets/deepseek`, registryUrl), 'deepseek', 'a path page link')
eq(registryIdOf(`${registryUrl}/#/pets/deepseek?ref=x`, registryUrl), 'deepseek', 'a link with a query')
eq(registryIdOf('https://codex-pets.net/#/pets/deepseek'), 'deepseek', 'the real site')
eq(registryIdOf('https://evil.example/#/pets/deepseek', registryUrl), null, 'another site is not the registry')
eq(registryIdOf(`${registryUrl}/pets/deepseek/download`, registryUrl), null, 'a download link is not a page')
eq(registryIdOf('', registryUrl), null, 'empty')
eq(registryIdOf(undefined, registryUrl), null, 'undefined')
eq(registryIdOf('../../etc/passwd', registryUrl), null, 'a path is not an id')
eq(registryIdOf('two words', registryUrl), null, 'words are not an id')
eq(uniqueId(pets, 'fresh'), 'fresh', 'a free name stays')
eq(uniqueId(pets, 'alpha'), 'alpha-2', 'a taken name gets -2')

// ---------------------------------------------------------------------------
console.log('install')
let r = await post('/api/dsh-pet/install', { source: 'remote-whale' })
eq([r.status, r.body.ok, r.body.already, r.body.pet.id, r.body.pet.name, r.body.pet.version], [200, true, false, 'remote-whale', 'Remote Whale', 1], 'an id installs')
ok((await ids()).includes('remote-whale'), 'and shows in the gallery')
const written = JSON.parse(readFileSync(join(pets, 'remote-whale', 'pet.json'), 'utf8'))
eq(written.source, `${registryUrl}/#/pets/remote-whale`, 'with the page it came from')
ok(readFileSync(join(pets, 'remote-whale', 'spritesheet.webp')).equals(remoteSheets['remote-whale'].bytes), 'and the atlas bytes')

r = await post('/api/dsh-pet/install', { source: `${registryUrl}/#/pets/remote-whale` })
eq([r.status, r.body.already, r.body.pet.id], [200, true, 'remote-whale'], 'the same pet again, by its page link, is recognised')
ok(!(await ids()).includes('remote-whale-2'), 'and installed only once')

r = await post('/api/dsh-pet/install', { source: 'twin-of-alpha' })
eq([r.status, r.body.already, r.body.pet.id], [200, true, 'alpha'], 'a pet with art that is already installed is recognised under its other name')
ok(!(await ids()).includes('twin-of-alpha'), 'and not installed again')

r = await post('/api/dsh-pet/install', { source: 'alpha' })
eq([r.status, r.body.already, r.body.pet.id], [200, false, 'alpha-2'], 'a different pet with a taken name is installed under a free one')
ok(readFileSync(join(pets, 'alpha', 'spritesheet.webp')).equals(ALPHA), 'and the pet that held the name is untouched')
eq((await get('/api/dsh-pet/pets')).body.pets.find((p) => p.id === 'alpha-2').name, 'Another Alpha', 'with its own name')

r = await post('/api/dsh-pet/install', { source: 'nobody' })
eq([r.status, r.body.error.code], [404, 'not-found'], 'an unknown id is 404 not-found')
r = await post('/api/dsh-pet/install', { source: 'bad-pet' })
eq([r.status, r.body.error.code], [400, 'invalid-pet'], 'something that is not an atlas is refused')
ok(!existsSync(join(pets, 'bad-pet')), 'and leaves nothing behind')
for (const source of ['', '   ', 'two words', 'https://evil.example/#/pets/x', `${registryUrl}/pets/x/download`, '../../etc', 42, null]) {
  r = await post('/api/dsh-pet/install', { source })
  eq([r.status, r.body.error.code], [400, 'invalid-source'], `source ${JSON.stringify(source)} is refused`)
}
r = await post('/api/dsh-pet/install', 'not json at all')
eq([r.status, r.body.error.code], [400, 'invalid-source'], 'a body that is not JSON is refused')
r = await post('/api/dsh-pet/install', [1, 2])
eq([r.status, r.body.error.code], [400, 'invalid-source'], 'a JSON array is refused')

const both = await Promise.all([post('/api/dsh-pet/install', { source: 'remote-v2' }), post('/api/dsh-pet/install', { source: 'remote-v2' })])
eq(both.map((x) => x.status), [200, 200], 'two installs at once both answer')
eq(both.map((x) => x.body.already).sort(), [false, true], 'one installs, the other sees it already there')
eq((await ids()).filter((id) => id.startsWith('remote-v2')), ['remote-v2'], 'exactly one copy exists')
eq(readdirSync(pets).filter((name) => name.startsWith('.')), [], 'no half-written folder is left in pets/')

// ---------------------------------------------------------------------------
console.log('delete')
r = await post('/api/dsh-pet/remove', { id: 'alpha' })
eq([r.status, r.body.error.code], [409, 'active'], 'the pet in use cannot be deleted')
ok(existsSync(join(pets, 'alpha', 'pet.json')), 'and is still there')

r = await post('/api/dsh-pet/remove', { id: 'beta' })
eq([r.status, r.body.ok, r.body.id], [200, true, 'beta'], 'another pet is deleted')
ok(!existsSync(join(pets, 'beta')), 'its folder is gone')
ok(!(await ids()).includes('beta'), 'and so is its gallery entry')
r = await post('/api/dsh-pet/remove', { id: 'beta' })
eq([r.status, r.body.error.code], [404, 'not-installed'], 'deleting it twice says it is gone')

for (const id of ['', '../project', '..', 'a/b', 'Beta', 'with space', '.hidden', 7, null]) {
  r = await post('/api/dsh-pet/remove', { id })
  eq([r.status, r.body.error.code], [400, 'invalid-id'], `id ${JSON.stringify(id)} is refused`)
}
ok(existsSync(join(project, 'lib', 'index.js')) && existsSync(pets), 'nothing outside a pet folder was touched')

mkdirSync(join(pets, 'not-a-pet'))
writeFileSync(join(pets, 'not-a-pet', 'precious.txt'), 'keep')
r = await post('/api/dsh-pet/remove', { id: 'not-a-pet' })
eq([r.status, r.body.error.code], [404, 'not-installed'], 'a folder without pet.json is not deleted')
ok(existsSync(join(pets, 'not-a-pet', 'precious.txt')), 'and its files are kept')

const outside = join(base, 'outside')
mkdirSync(outside)
writeFileSync(join(outside, 'keep.txt'), 'keep')
symlinkSync(outside, join(pets, 'linked'))
r = await post('/api/dsh-pet/remove', { id: 'linked' })
eq([r.status, r.body.ok], [200, true], 'a symlinked pet can be removed')
ok(!existsSync(join(pets, 'linked')) && existsSync(join(outside, 'keep.txt')), 'by unlinking it, never following it')

r = await post('/api/dsh-pet/remove', { id: 'remote-whale' })
eq(r.status, 200, 'an installed pet is deleted too')
r = await post('/api/dsh-pet/install', { source: 'remote-whale' })
eq([r.status, r.body.already, r.body.pet.id], [200, false, 'remote-whale'], 'and can be installed again afterwards')
r = await post('/api/dsh-pet/remove', { id: 'remote-whale' })

// ---------------------------------------------------------------------------
console.log('import from Codex')
let list = (await get('/api/dsh-pet/codex-pets')).body.pets
const status = Object.fromEntries(list.map((p) => [p.folder, p.status]))
eq(status, { 'Mixed Case': 'ready', 'beta-copy': 'ready', broken: 'failed', gamma: 'taken', wangcai: 'ready' }, 'each Codex pet says what importing it would do (beta was deleted above, so its twin is new)')
eq(list.find((p) => p.folder === 'Mixed Case').id, 'mixed-case', 'a folder name is tidied into an id')
eq(list.find((p) => p.folder === 'wangcai').version, 2, 'with its atlas version')

// bring beta back in the same art, so beta-copy is a duplicate
putPet(pets, 'beta', 'Beta', BETA)
list = (await get('/api/dsh-pet/codex-pets')).body.pets
eq(list.find((p) => p.folder === 'beta-copy').status, 'installed', 'the same art under another name counts as installed')
eq(list.find((p) => p.folder === 'beta-copy').installedAs, 'beta', 'and says which')

r = await post('/api/dsh-pet/import-codex', {})
eq(r.status, 200, 'import answers 200')
eq(r.body.installed.map((p) => p.id).sort(), ['mixed-case', 'wangcai'], 'the new pets are imported')
eq(r.body.skipped.map((p) => `${p.reason}:${p.name}`).sort(), ['installed:Beta Copy', 'taken:Not Gamma'], 'duplicates and taken names are skipped')
eq(r.body.failed.map((p) => [p.folder, p.code]), [['broken', 'invalid-pet']], 'a broken pet is reported, and does not stop the rest')
const idsAfter = await ids()
ok(idsAfter.includes('wangcai') && idsAfter.includes('mixed-case'), 'imported pets are in the gallery')
eq((await get('/api/dsh-pet/pets')).body.pets.find((p) => p.id === 'wangcai').look.rows, [9, 10], 'a v2 pet keeps its look rows')
ok(readFileSync(join(pets, 'gamma', 'spritesheet.webp')).equals(v1('gamma-local')), 'a pet that held the name was not replaced')
ok(existsSync(join(codexPets, 'wangcai', 'pet.json')) && existsSync(join(codexPets, 'Mixed Case', 'pet.json')), 'Codex\'s own folders are untouched')

r = await post('/api/dsh-pet/import-codex', {})
eq(r.body.installed, [], 'importing again installs nothing')
eq(r.body.skipped.length, 4, 'and skips what is there')
eq((await ids()).length, idsAfter.length, 'and the gallery does not change')

process.env.CODEX_HOME = join(base, 'no-such-codex')
eq((await get('/api/dsh-pet/codex-pets')).body.pets, [], 'with no Codex folder there is nothing to list')
r = await post('/api/dsh-pet/import-codex', {})
eq([r.status, r.body.installed, r.body.skipped, r.body.failed], [200, [], [], []], 'and importing is a no-op')
process.env.CODEX_HOME = codex

// ---------------------------------------------------------------------------
console.log('registry unreachable')
registry.close()
r = await post('/api/dsh-pet/install', { source: 'remote-v2-again' })
eq([r.status, r.body.error.code], [502, 'unreachable'], 'a registry that is down is 502 unreachable')

eq(stagings(), stagingsBefore, 'no staging folder is left in the temp directory')
rmSync(base, { recursive: true, force: true })
console.log(`\npet management: ${checks} checks passed`)
