/**
 * Host-side check for the dsh-pet plugin.
 *
 * Loads the real `lib/index.js` with a stub DSH context, mounts the plugin,
 * and then calls the very Fetch routes the settings page uses. Nothing here
 * is mocked: the gallery is read from `pets/index.json`, the manifests from
 * `pets/<id>/pet.json`, and the bytes come off disk.
 *
 *   node tools/check-host.mjs
 */
import { apply } from '../lib/index.js'
import assert from 'node:assert/strict'

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

apply(ctx, { pet: 'hoots', size: 180 })

assert.equal(routes.size, 3, 'the plugin registers three Fetch routes')
for (const path of ['/api/dsh-pet/pets', '/api/dsh-pet/sprite', '/api/dsh-pet/preview']) {
  assert.ok(routes.has(path), `route ${path} is registered`)
}

// ---- the gallery ---------------------------------------------------------

const gallery = await routes.get('/api/dsh-pet/pets').fetch(new Request('http://x/api/dsh-pet/pets'))
assert.equal(gallery.status, 200, 'the gallery answers 200')
const payload = await gallery.json()
const pets = payload.pets

console.log('current:', JSON.stringify(payload.current))
console.log('gallery:')
for (const pet of pets) {
  console.log(`  ${pet.id.padEnd(12)} ${String(pet.name).padEnd(12)} size=${pet.size} grid=${pet.grid.columns}x${pet.grid.rows} look=${pet.look ? 'yes' : 'no'}`)
}

assert.equal(pets.length, 9, 'the gallery holds the nine Codex pets')
assert.ok(pets.some((pet) => pet.id === 'hoots'), 'hoots is in the gallery')
assert.ok(!pets.some((pet) => pet.id === 'whale'), 'the whale is gone')
assert.deepEqual(
  pets.map((pet) => pet.id),
  ['codex', 'dewey', 'fireball', 'hoots', 'rocky', 'seedy', 'stacky', 'bsod', 'null-signal'],
  'the gallery order follows the Codex app',
)
for (const pet of pets) {
  assert.equal(pet.grid.columns, 8, `${pet.id} has 8 columns`)
  assert.equal(pet.grid.rows, 11, `${pet.id} has 11 rows`)
  assert.ok(pet.look, `${pet.id} carries the look rows`)
}

// ---- the sprite and the preview -----------------------------------------

const sprite = await routes.get('/api/dsh-pet/sprite').fetch(new Request('http://x/api/dsh-pet/sprite?id=hoots'))
assert.equal(sprite.status, 200, 'the hoots sprite answers 200')
assert.equal(sprite.headers.get('content-type'), 'image/webp', 'the sprite is a webp')
const sheet = new Uint8Array(await sprite.arrayBuffer())
assert.equal(sheet.byteLength, 2447958, 'the hoots atlas is the official v8 sheet')

const preview = await routes.get('/api/dsh-pet/preview').fetch(new Request('http://x/api/dsh-pet/preview?id=hoots'))
assert.equal(preview.status, 200, 'the hoots preview answers 200')
assert.equal(preview.headers.get('content-type'), 'image/png', 'the preview is a png')
assert.ok((await preview.arrayBuffer()).byteLength > 1000, 'the preview has content')

const missing = await routes.get('/api/dsh-pet/sprite').fetch(new Request('http://x/api/dsh-pet/sprite?id=whale'))
assert.equal(missing.status, 404, 'a removed pet answers 404')

console.log('\nhost check: all assertions passed')
