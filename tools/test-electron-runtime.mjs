/**
 * The Electron runtime manager, against a local server and a fake build:
 * hashes are checked, a bad or stalled source falls through to the next one,
 * a dropped-in zip works offline, and nothing is fetched twice.
 *
 *   node tools/test-electron-runtime.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TARGETS, createRuntimeManager, defaultBases, sourceUrl } from '../lib/electron-runtime.js'

let checks = 0
const ok = (condition, message) => {
  assert.ok(condition, message)
  checks += 1
}
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks += 1
}

const work = mkdtempSync(join(tmpdir(), 'dsh-runtime-test-'))
const FILE = 'electron-vTEST-darwin-arm64.zip'

// A zip that looks like an Electron build: Electron.app/Contents/MacOS/Electron.
const stage = join(work, 'stage')
mkdirSync(join(stage, 'Electron.app', 'Contents', 'MacOS'), { recursive: true })
writeFileSync(join(stage, 'Electron.app', 'Contents', 'MacOS', 'Electron'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
const zip = join(work, FILE)
execFileSync('/usr/bin/ditto', ['-c', '-k', stage, zip])
const bytes = readFileSync(zip)
const digest = createHash('sha256').update(bytes).digest('hex')
const targets = {
  'darwin-arm64': { file: FILE, sha256: digest, executable: ['Electron.app', 'Contents', 'MacOS', 'Electron'], extract: 'ditto' },
}

const hits = []
const server = createServer((request, response) => {
  // The speed probe asks with a Range header; only real downloads are counted.
  if (request.headers.range === undefined) hits.push(request.url)
  if (request.url.startsWith('/slow/')) {
    setTimeout(() => {
      response.writeHead(200, { 'content-length': bytes.length })
      response.end(bytes)
    }, 900)
  } else if (request.url.startsWith('/good/')) {
    response.writeHead(200, { 'content-length': bytes.length })
    response.end(bytes)
  } else if (request.url.startsWith('/tampered/')) {
    const copy = Buffer.from(bytes)
    copy[copy.length - 1] ^= 0xff
    response.writeHead(200, { 'content-length': copy.length })
    response.end(copy)
  } else if (request.url.startsWith('/stall/')) {
    // Says it will send something, then never does.
    response.writeHead(200, { 'content-length': bytes.length })
    response.write(bytes.subarray(0, 10))
  } else {
    response.writeHead(404)
    response.end()
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const fresh = (name, bases, extra = {}) => createRuntimeManager({
  dir: join(work, name), platform: 'darwin', arch: 'arm64', targets, version: 'TEST', bases, stallMs: 400, connectMs: 400, probeMs: 1500, ...extra,
})

try {
  // -- pure helpers -------------------------------------------------------
  eq(sourceUrl('https://m.example/electron/v1/', 'a.zip'), 'https://m.example/electron/v1/a.zip', 'directory base')
  eq(sourceUrl('https://m.example/x/custom.zip', 'a.zip'), 'https://m.example/x/custom.zip', 'full zip link kept')
  eq(sourceUrl('ftp://nope', 'a.zip'), null, 'only http(s)')
  eq(sourceUrl('', 'a.zip'), null, 'empty base')
  ok(defaultBases('9.9.9').every((item) => item.includes('v9.9.9')), 'default bases carry the version')
  for (const [name, row] of Object.entries(TARGETS)) {
    ok(/^[0-9a-f]{64}$/.test(row.sha256), `${name} has a pinned sha256`)
    ok(row.file.includes(name.split('-')[1]), `${name} file names its arch`)
  }

  // -- the plain download -------------------------------------------------
  hits.length = 0
  const a = fresh('a', [`${base}/good`])
  eq(a.snapshot().status, 'idle', 'starts idle')
  const seen = []
  a.subscribe((s) => seen.push(s.status))
  const exe = await a.ensure()
  ok(exe !== null && existsSync(exe), 'download installs the executable')
  eq(a.snapshot().status, 'ready', 'ready after download')
  ok(seen.includes('downloading') && seen.includes('extracting'), 'progress states are reported')
  eq(a.executable(), exe, 'executable() once installed')
  eq(hits.length, 1, 'one request')
  hits.length = 0
  await fresh('a', [`${base}/good`]).ensure()
  eq(hits.length, 0, 'an installed runtime is not fetched again')

  // -- a tampered mirror is refused; the next source is used --------------
  hits.length = 0
  const b = fresh('b', [`${base}/tampered`, `${base}/good`])
  ok((await b.ensure()) !== null, 'falls through a source with the wrong bytes')
  eq(b.snapshot().attempts.length, 1, 'the bad source is recorded')
  ok(b.snapshot().attempts[0].error.includes('sha256'), 'and says the hash was wrong')
  eq(hits.length, 2, 'both sources asked')

  // -- a clearly faster source is tried first ------------------------------
  hits.length = 0
  const fast = fresh('fast', [`${base}/slow`, `${base}/good`])
  ok((await fast.ensure()) !== null, 'installs when the first listed source is slow')
  eq(hits, ['/good/' + FILE], 'the faster source was the one downloaded from')
  hits.length = 0
  const unranked = fresh('unranked', [`${base}/slow`, `${base}/good`], { rank: false })
  await unranked.ensure()
  ok(hits[0].startsWith('/slow/'), 'ranking can be switched off')

  // -- a 404 and a stall both fall through --------------------------------
  const c = fresh('c', [`${base}/missing`, `${base}/stall`, `${base}/good`], { rank: false })
  const started = Date.now()
  ok((await c.ensure()) !== null, 'falls through 404 and a stalled source')
  ok(Date.now() - started < 5000, 'a stalled source is given up on quickly')
  eq(c.snapshot().attempts.length, 2, 'two failed attempts recorded')

  // -- everything fails -> failed, and retry can recover -------------------
  const d = fresh('d', [`${base}/missing`, `${base}/tampered`], { rank: false })
  eq(await d.ensure(), null, 'null when every source fails')
  eq(d.snapshot().status, 'failed', 'status failed')
  eq(d.snapshot().installed, false, 'a failed download is not installed')
  eq(d.snapshot().attempts.length, 2, 'every attempt listed')
  ok(!existsSync(join(work, 'd', `${FILE}.${process.pid}.part`)), 'no partial file left behind')
  ok(!existsSync(join(work, 'd', '.lock')), 'the lock is released after a failure')
  d.setCustomSource(`${base}/good`)
  ok((await d.retry()) !== null, 'retry works once a custom source is set')

  // -- a custom source goes first -----------------------------------------
  hits.length = 0
  const e = fresh('e', [`${base}/missing`])
  ok(e.setCustomSource(`${base}/good/${FILE}`), 'custom source accepted')
  ok(!e.setCustomSource('not a url'), 'a non-url is refused')
  ok((await e.ensure()) !== null, 'installs from the custom source')
  eq(hits[0], `/good/${FILE}`, 'custom source asked first')
  eq(fresh('e', []).snapshot().custom, `${base}/good/${FILE}`, 'custom source is remembered')

  // -- an offline zip in drop/ ---------------------------------------------
  hits.length = 0
  const f = fresh('f', [`${base}/missing`])
  mkdirSync(join(work, 'f', 'drop'), { recursive: true })
  copyFileSync(zip, join(work, 'f', 'drop', FILE))
  ok((await f.ensure()) !== null, 'installs from drop/')
  eq(hits.length, 0, 'no network when a zip was dropped in')
  const g = fresh('g', [`${base}/good`])
  mkdirSync(join(work, 'g', 'drop'), { recursive: true })
  writeFileSync(join(work, 'g', 'drop', FILE), 'not the real zip')
  ok((await g.ensure()) !== null, 'a wrong drop-in is ignored, and the download is used')
  ok(g.snapshot().attempts.some((item) => item.error.includes('sha256')), 'and the bad drop-in is recorded')

  // -- callers share one run ----------------------------------------------
  hits.length = 0
  const h = fresh('h', [`${base}/good`])
  const [x, y] = await Promise.all([h.ensure(), h.ensure()])
  eq(x, y, 'concurrent callers get the same answer')
  eq(hits.length, 1, 'and only one download')

  // -- another process holds the lock ---------------------------------------
  const i = fresh('i', [`${base}/good`])
  mkdirSync(join(work, 'i', '.lock'), { recursive: true })
  writeFileSync(join(work, 'i', '.lock', 'pid'), '99999999')
  ok((await i.ensure()) !== null, 'a lock left by a dead process is taken over')

  // -- an unsupported platform ---------------------------------------------
  const j = createRuntimeManager({ dir: join(work, 'j'), platform: 'win32', arch: 'x64', targets })
  eq(j.snapshot().status, 'unsupported', 'no build for this platform')
  eq(await j.ensure(), null, 'ensure() is null there')

  // -- old versions are cleaned up -------------------------------------------
  mkdirSync(join(work, 'k', '1.0.0-darwin-arm64'), { recursive: true })
  const k = fresh('k', [`${base}/good`])
  await k.ensure()
  ok(!existsSync(join(work, 'k', '1.0.0-darwin-arm64')), 'an older version is removed')
  ok(existsSync(join(work, 'k', 'TEST-darwin-arm64')), 'the current one stays')

  // -- a subscriber that asks again must not turn ready into failed --------
  const re = fresh('reenter', [`${base}/good`])
  let reasks = 0
  re.subscribe((state) => {
    if (state.status !== 'ready') return
    reasks += 1
    if (reasks < 8) re.ensure()
  })
  ok((await re.ensure()) !== null, 'still installs when a listener asks again')
  eq(re.snapshot().status, 'ready', 're-entry does not record a failed download')
  ok(reasks < 8, 're-entry does not recurse')

  // -- files appearing after a failure clear the error without a download --
  cpSync(join(work, 'a', 'TEST-darwin-arm64'), join(work, 'd', 'TEST-darwin-arm64'), { recursive: true })
  hits.length = 0
  eq(d.refresh().status, 'ready', 'a local runtime clears the failed status')
  eq(d.snapshot().installed, true, 'and is reported installed')
  eq(d.refresh().error, '', 'the download error is gone')
  ok((await d.ensure()) !== null, 'ensure uses the local runtime')
  eq(hits.length, 0, 'and does not download it again')
} finally {
  server.closeAllConnections?.()
  server.close()
  rmSync(work, { recursive: true, force: true })
}

console.log(`electron runtime: ${checks} checks passed`)
