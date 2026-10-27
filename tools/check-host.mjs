/**
 * Host-side check for the dsh-codex-pets plugin.
 *
 * Loads the real `lib/index.js` with a stub DSH context, mounts the plugin,
 * and then calls the very Fetch routes the settings page uses. Nothing here
 * is mocked: the gallery is read from `pets/index.json`, the manifests from
 * `pets/<id>/pet.json`, and the bytes come off disk.
 *
 * Uses an empty `DSH_CODEX_PETS_USER_DIR` so startup does not migrate loose folders
 * out of the package tree (developer checkouts often keep extras there).
 *
 *   node tools/check-host.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_CODEX_PETS_USER_DIR = mkdtempSync(join(tmpdir(), 'dsh-codex-pets-check-user-'))

const { apply } = await import('../lib/index.js')

const routes = new Map()

/** A stub context that records the routes the plugin registers. */
const ctx = {
  logger: { info() {}, warn() {}, debug() {} },
  inject(names, callback) {
    callback({
      effect(fn) {
        fn()
        return () => {}
      },
      connection: {
        fetch: {
          register(route) {
            routes.set(route.path, route)
          },
        },
      },
    })
  },
  effect() {},
  on() {
    return () => {}
  },
}

apply(ctx, { pet: 'deepseek-whale', size: 180 })

assert.equal(routes.size, 9, 'the plugin registers nine Fetch routes')
for (const path of [
  '/api/dsh-codex-pets/pets',
  '/api/dsh-codex-pets/sprite',
  '/api/dsh-codex-pets/preview',
  '/api/dsh-codex-pets/install',
  '/api/dsh-codex-pets/remove',
  '/api/dsh-codex-pets/reorder',
  '/api/dsh-codex-pets/codex-pets',
  '/api/dsh-codex-pets/import-codex',
  '/api/dsh-codex-pets/focus',
]) {
  assert.ok(routes.has(path), `route ${path} is registered`)
}

// ---- the gallery ---------------------------------------------------------

const gallery = await routes.get('/api/dsh-codex-pets/pets').fetch(new Request('http://x/api/dsh-codex-pets/pets'))
assert.equal(gallery.status, 200, 'the gallery answers 200')
const payload = await gallery.json()
const pets = payload.pets

console.log('current:', JSON.stringify(payload.current))
assert.equal(payload.current.visible, true, 'the pet shows unless the profile hides it')
assert.equal(payload.current.sessions, true, 'the session ball is on by default')
assert.equal(payload.current.sessionMotion, true, 'the pet reacts to tasks by default')
console.log('gallery:')
for (const pet of pets) {
  const flag = pet.bundled ? 'bundled' : 'user'
  console.log(`  ${pet.id.padEnd(12)} ${String(pet.name).padEnd(12)} ${flag.padEnd(8)} size=${pet.size} grid=${pet.grid.columns}x${pet.grid.rows} look=${pet.look ? 'yes' : 'no'}`)
}

// The pets `pets/index.json` ships, in order. The first one that exists on
// disk is the default pet.
const SHIPPED = ['deepseek-whale']
assert.deepEqual(
  pets.filter((pet) => pet.bundled).map((pet) => pet.id),
  SHIPPED.filter((id) => existsSync(join('pets', id, 'pet.json'))),
  'bundled pets follow index.json',
)
for (const pet of pets.filter((entry) => entry.bundled)) {
  // The shipped pet is a v1 atlas: nine animation rows and no gaze rows,
  // which is the only shape that carries a `look`.
  const v2 = pet.version === 2
  assert.equal(pet.grid.columns, 8, `${pet.id} has 8 columns`)
  assert.equal(pet.grid.rows, v2 ? 11 : 9, `${pet.id} has the rows of its v${pet.version} atlas`)
  assert.equal(Boolean(pet.look), v2, `${pet.id} carries the look rows only on a v2 atlas`)
  assert.equal(pet.bundled, true, `${pet.id} is flagged as bundled`)
}

// ---- the sprite and the preview -----------------------------------------

const sprite = await routes.get('/api/dsh-codex-pets/sprite').fetch(new Request('http://x/api/dsh-codex-pets/sprite?id=deepseek-whale'))
assert.equal(sprite.status, 200, 'the shipped sprite answers 200')
assert.equal(sprite.headers.get('content-type'), 'image/webp', 'the sprite is a webp')
const sheet = new Uint8Array(await sprite.arrayBuffer())
assert.ok(sheet.byteLength > 1000, 'the atlas has content')

const preview = await routes.get('/api/dsh-codex-pets/preview').fetch(new Request('http://x/api/dsh-codex-pets/preview?id=deepseek-whale'))
assert.equal(preview.status, 200, 'the preview answers 200')
assert.equal(preview.headers.get('content-type'), 'image/png', 'the preview is a png')
assert.ok((await preview.arrayBuffer()).byteLength > 1000, 'the preview has content')

const missing = await routes.get('/api/dsh-codex-pets/sprite').fetch(new Request('http://x/api/dsh-codex-pets/sprite?id=hoots'))
assert.equal(missing.status, 404, 'a removed pet answers 404')

console.log('\nhost check: all assertions passed')
