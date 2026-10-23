/**
 * Build a browser preview for a sprite pet.
 *
 * The native helper injects the manifest and the engine at document start;
 * this script produces the same thing as a plain file so a pet can be
 * checked in a browser without the macOS helper running.
 *
 *   node tools/preview-sprite-pet.mjs [pet-id]
 *
 * The result is written next to the pet as `__preview.html`; the pet's
 * directory is the base URL, so the atlas resolves exactly as it does in
 * the real panel.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const petId = process.argv[2] || 'codex'

const petDir = join(root, 'pets', petId)
const manifestPath = join(petDir, 'pet.json')
if (!existsSync(manifestPath)) {
  console.error(`no pet.json for "${petId}" at ${manifestPath}`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (typeof manifest.spritesheetPath !== 'string') {
  console.error(`pet "${petId}" is not a sprite pet (no spritesheetPath)`)
  process.exit(1)
}

let html = readFileSync(join(root, 'runtime', 'player.html'), 'utf8')

// The two scripts the helper injects at document start.
const scripts = [
  '<script src="../../runtime/pet-runtime.js"></script>',
  '<script src="../../runtime/sprite-pet.js"></script>',
].join('\n')
html = html.replace('</head>', `${scripts}\n</head>`)

// The manifest. The helper injects it as a user script; here it is a plain
// script tag. The atlas path stays relative because this page lives in the
// pet's own directory, exactly like the native player does.
const json = JSON.stringify(manifest).replace(/</g, '\\u003c')
const injected = `<script>window.__DSH_PET_MANIFEST__ = ${json};</script>`
html = html.replace('</head>', `${injected}\n</head>`)

const out = join(petDir, '__preview.html')
writeFileSync(out, html)
console.log(out)
