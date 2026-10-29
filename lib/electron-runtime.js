/**
 * The Electron the floating pet runs in.
 *
 * The plugin ships no compiled code. The pet window is a small Electron app
 * (`electron/`), and Electron itself is fetched once, on first start, from
 * the official release (or a mirror) into the user's own directory. Nothing
 * here needs the user to configure anything:
 *
 * - The expected SHA-256 of each build is pinned below, so it does not matter
 *   who serves the bytes. A mirror that changes one byte fails the check.
 * - Several sources are tried in turn. A source that does not connect, or
 *   stops sending, is dropped after a few seconds and the next one is tried.
 * - A zip dropped into `<dir>/drop/` (offline machines, company networks) is
 *   used instead of downloading, once its hash matches.
 *
 * Only macOS is wired in. Another platform adds a row to `TARGETS` and an
 * `extract` that knows its archive; nothing else in this file is
 * platform-specific.
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs'
import { join } from 'node:path'

/** The Electron this plugin was tested with. Changing it means changing the hashes. */
export const ELECTRON_VERSION = '43.3.0'

/**
 * One row per `platform-arch`. `sha256` is the hash of the official zip,
 * from the release's `SHASUMS256.txt`.
 */
export const TARGETS = {
  'darwin-arm64': {
    file: `electron-v${ELECTRON_VERSION}-darwin-arm64.zip`,
    sha256: 'ee939d1564d83d61032b3b3cb23af4e46005a4900c91f0695f7ed793f0ce6e83',
    executable: ['Electron.app', 'Contents', 'MacOS', 'Electron'],
    extract: 'ditto',
  },
  'darwin-x64': {
    file: `electron-v${ELECTRON_VERSION}-darwin-x64.zip`,
    sha256: '7347bbd5fb529eea64f9c2d148bb1c19222d98946ff234ffe27953a1bbcb9dae',
    executable: ['Electron.app', 'Contents', 'MacOS', 'Electron'],
    extract: 'ditto',
  },
}

/** Where the zip comes from, in the order they are tried. */
export function defaultBases(version = ELECTRON_VERSION) {
  return [
    `https://github.com/electron/electron/releases/download/v${version}`,
    `https://cdn.npmmirror.com/binaries/electron/v${version}`,
  ]
}

/** `https://host/dir`, `https://host/dir/` and a full `.zip` link all name one file. */
export function sourceUrl(base, file) {
  const text = String(base ?? '').trim()
  if (!/^https?:\/\//i.test(text)) return null
  if (/\.zip(\?.*)?$/i.test(text)) return text
  return `${text.replace(/\/+$/, '')}/${file}`
}

/** Unpack a zip into an existing directory. */
function extractZip(kind, zip, dest) {
  return new Promise((resolve, reject) => {
    if (kind !== 'ditto') {
      reject(new Error(`no extractor for ${kind}`))
      return
    }
    // `ditto` keeps the symlinks inside Electron Framework, which `unzip` can lose.
    execFile('/usr/bin/ditto', ['-x', '-k', zip, dest], (error) => (error ? reject(error) : resolve()))
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** A short human line for an error from a download attempt. */
function describe(error) {
  if (error?.name === 'TimeoutError') return 'timed out'
  const cause = error?.cause?.code ?? error?.cause?.message
  return String(cause ?? error?.message ?? error)
}

/**
 * Own the one Electron this plugin uses.
 *
 * `ensure()` resolves to the path of the Electron executable, or null when it
 * could not be had; `state` says why, for the settings page.
 */
export function createRuntimeManager(options = {}) {
  const {
    dir,
    logger,
    fetchImpl = globalThis.fetch,
    platform = process.platform,
    arch = process.arch,
    targets = TARGETS,
    version = ELECTRON_VERSION,
    bases = defaultBases(version),
    connectMs = 10_000,
    stallMs = 8_000,
    probeBytes = 512 * 1024,
    probeMs = 6_000,
    rank: ranked = true,
    extract = extractZip,
  } = options
  if (typeof dir !== 'string' || dir === '') throw new TypeError('createRuntimeManager needs a dir')

  const key = `${platform}-${arch}`
  const target = targets[key] ?? null
  const home = join(dir, `${version}-${key}`)
  const executable = target === null ? null : join(home, ...target.executable)
  const okFile = join(home, '.ok')
  const dropDir = join(dir, 'drop')
  const lockDir = join(dir, '.lock')
  const sourceFile = join(dir, 'source.json')

  const listeners = new Set()
  const state = {
    status: target === null ? 'unsupported' : 'idle',
    version,
    target: key,
    file: target?.file ?? '',
    source: '',
    received: 0,
    total: 0,
    attempts: [],
    error: '',
    dropDir,
    custom: readCustom(),
  }

  function readCustom() {
    try {
      const value = JSON.parse(readFileSync(sourceFile, 'utf8'))
      return typeof value?.source === 'string' ? value.source : ''
    } catch {
      return ''
    }
  }

  function snapshot() {
    return { ...state, installed: isInstalled(), attempts: state.attempts.map((item) => ({ ...item })) }
  }

  /**
   * The files on disk win over a remembered download failure. A failed
   * attempt must not keep saying so once the runtime is actually there,
   * or the pet never starts and Settings keeps asking for a zip.
   */
  function refresh() {
    if (isInstalled() && (state.status !== 'ready' || state.error !== '')) update({ status: 'ready', error: '' })
    return snapshot()
  }

  function update(patch) {
    Object.assign(state, patch)
    for (const listener of listeners) {
      try {
        listener(snapshot())
      } catch {}
    }
  }

  function isInstalled() {
    return executable !== null && existsSync(okFile) && existsSync(executable)
  }

  /** The user-supplied download address; empty clears it. */
  function setCustomSource(value) {
    const text = String(value ?? '').trim()
    if (text !== '' && sourceUrl(text, 'x.zip') === null) return false
    mkdirSync(dir, { recursive: true })
    writeFileSync(sourceFile, JSON.stringify({ source: text }))
    update({ custom: text })
    return true
  }

  async function acquireLock() {
    mkdirSync(dir, { recursive: true })
    const deadline = Date.now() + 15 * 60_000
    for (;;) {
      try {
        mkdirSync(lockDir)
        writeFileSync(join(lockDir, 'pid'), String(process.pid))
        return true
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
      let stale = false
      try {
        const pid = Number(readFileSync(join(lockDir, 'pid'), 'utf8'))
        stale = !Number.isInteger(pid) || pid <= 0 || !alive(pid)
        if (!stale && Date.now() - statSync(lockDir).mtimeMs > 30 * 60_000) stale = true
      } catch {
        stale = true
      }
      if (stale) {
        rmSync(lockDir, { recursive: true, force: true })
        continue
      }
      // Another process is fetching it: wait for it rather than download twice.
      if (isInstalled()) return false
      if (Date.now() > deadline) throw new Error('timed out waiting for another download')
      await sleep(500)
    }
  }

  function releaseLock() {
    rmSync(lockDir, { recursive: true, force: true })
  }

  /** Stream one URL to `file`, hashing as it goes. */
  async function download(url, file) {
    const controller = new AbortController()
    const connect = setTimeout(() => controller.abort(new DOMException('connect timeout', 'TimeoutError')), connectMs)
    let response
    try {
      response = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' })
    } finally {
      clearTimeout(connect)
    }
    if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
    const total = Number(response.headers.get('content-length')) || 0
    update({ total, received: 0 })
    const hash = createHash('sha256')
    const fd = openSync(file, 'w')
    const reader = response.body.getReader()
    let received = 0
    try {
      for (;;) {
        let timer
        const stalled = new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new DOMException('stalled', 'TimeoutError')
            controller.abort(error)
            reject(error)
          }, stallMs)
        })
        let step
        try {
          step = await Promise.race([reader.read(), stalled])
        } finally {
          clearTimeout(timer)
        }
        if (step.done) break
        hash.update(step.value)
        writeSync(fd, step.value)
        received += step.value.length
        update({ received })
      }
    } finally {
      closeSync(fd)
      reader.cancel().catch(() => {})
    }
    return hash.digest('hex')
  }

  /**
   * How long the first `probeBytes` of a file take to arrive, or Infinity.
   * Mirrors and GitHub can differ by an order of magnitude depending on where
   * the user is, and a 120 MB download is a bad place to find that out.
   */
  async function probe(url) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), probeMs)
    const started = performance.now()
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { range: `bytes=0-${probeBytes - 1}` },
      })
      if (!response.ok || response.body === null) return Infinity
      const reader = response.body.getReader()
      let got = 0
      while (got < probeBytes) {
        const step = await reader.read()
        if (step.done) break
        got += step.value.length
      }
      reader.cancel().catch(() => {})
      return performance.now() - started
    } catch {
      return Infinity
    } finally {
      clearTimeout(timer)
    }
  }

  /** The default sources, fastest first when one is clearly faster than the first listed. */
  async function rank(urls) {
    if (urls.length < 2) return urls
    const times = await Promise.all(urls.map(probe))
    let best = 0
    for (let i = 1; i < urls.length; i++) if (times[i] < times[best]) best = i
    if (best === 0 || times[best] === Infinity || times[best] * 2 > times[0] || times[0] - times[best] < 300) return urls
    logger?.info?.(`dsh-codex-pets: ${urls[best]} answers faster; trying it first`)
    return [urls[best], ...urls.filter((_, i) => i !== best)]
  }

  async function install(zip) {
    // A download that finishes late must not replace a runtime already in use.
    if (isInstalled()) return
    update({ status: 'extracting' })
    const staging = join(dir, `staging-${process.pid}`)
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    try {
      await extract(target.extract, zip, staging)
      if (!existsSync(join(staging, ...target.executable))) throw new Error('the archive has no Electron executable')
      rmSync(home, { recursive: true, force: true })
      renameSync(staging, home)
      writeFileSync(okFile, new Date().toISOString())
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }

  /** Other versions' directories are of no use once this one is in. */
  function removeOlder() {
    try {
      for (const name of readdirSync(dir)) {
        if (name === `${version}-${key}` || !/^\d+\.\d+\.\d+-[a-z0-9]+-[a-z0-9]+$/.test(name)) continue
        rmSync(join(dir, name), { recursive: true, force: true })
      }
    } catch {}
  }

  async function fromDrop() {
    const file = join(dropDir, target.file)
    if (!existsSync(file)) return false
    if (sha256File(file) !== target.sha256) {
      state.attempts.push({ source: file, error: 'sha256 does not match' })
      return false
    }
    state.source = file
    await install(file)
    return true
  }

  async function run() {
    if (target === null) {
      update({ status: 'unsupported', error: `no Electron build is configured for ${key}` })
      return null
    }
    if (isInstalled()) {
      refresh()
      return executable
    }
    update({ status: 'downloading', attempts: [], error: '', received: 0, total: 0, source: '' })
    const owned = await acquireLock()
    try {
      if (isInstalled()) {
        refresh()
        return executable
      }
      if (!owned) {
        // The lock owner is still downloading. Do not report ready, and do
        // not report failure, until that copy is actually on disk.
        update({ status: 'downloading', error: '' })
        return null
      }
      mkdirSync(dir, { recursive: true })
      try {
        if (await fromDrop()) {
          removeOlder()
          refresh()
          return executable
        }
      } catch (error) {
        state.attempts.push({ source: 'drop', error: describe(error) })
      }

      const custom = readCustom()
      const named = (list) => list.map((base) => sourceUrl(base, target.file)).filter((url) => url !== null)
      // An address the user gave stays first; the built-in ones are raced.
      const urls = [...named([custom]), ...(ranked ? await rank(named(bases)) : named(bases))]
      const part = join(dir, `${target.file}.${process.pid}.part`)
      for (const url of urls) {
        update({ status: 'downloading', source: url, received: 0, total: 0 })
        logger?.info?.(`dsh-codex-pets: downloading Electron from ${url}`)
        try {
          const digest = await download(url, part)
          if (digest !== target.sha256) throw new Error('sha256 does not match')
          await install(part)
          removeOlder()
          refresh()
          update({ custom })
          logger?.info?.(`dsh-codex-pets: Electron ${version} installed`)
          return executable
        } catch (error) {
          const message = describe(error)
          state.attempts.push({ source: url, error: message })
          logger?.warn?.(`dsh-codex-pets: ${url}: ${message}`)
        } finally {
          rmSync(part, { force: true })
        }
      }
      if (isInstalled()) {
        refresh()
        return executable
      }
      update({
        status: 'failed',
        error: 'could not download Electron from any source',
        attempts: state.attempts,
      })
      return null
    } finally {
      if (owned) releaseLock()
    }
  }

  let inflight = null

  /**
   * Make sure Electron is there. One run at a time; callers share it.
   *
   * The promise is published before `run()` does any work. `run()` reports
   * `ready` synchronously when the files are already there, and the settings
   * page (and the pet starter) listen for that. If the promise were assigned
   * only after `run()` returned, that listener would call `ensure()` again
   * on the same stack until it overflowed, and the overflow was recorded as
   * a failed download — so a runtime that was already on disk never started
   * the pet.
   */
  function ensure() {
    if (inflight !== null) return inflight
    let settle
    const promise = new Promise((resolve) => { settle = resolve })
    // Published before `run()`, so a status listener can call `ensure()`
    // without starting a second run. Cleared before the caller resumes, so
    // a later `retry()` does not receive this already-settled promise.
    inflight = promise
    const finish = (result) => {
      if (inflight === promise) inflight = null
      settle(result)
    }
    run().then((value) => {
      if (value === null && isInstalled()) {
        refresh()
        finish(executable)
        return
      }
      finish(value ?? null)
    }, (error) => {
      if (isInstalled()) {
        refresh()
        finish(executable)
        return
      }
      update({ status: 'failed', error: describe(error) })
      finish(null)
    })
    return promise
  }

  /** Try again after a failure (or after a zip was dropped in). */
  function retry() {
    return ensure()
  }

  return {
    ensure,
    retry,
    refresh,
    setCustomSource,
    executable: () => (isInstalled() ? executable : null),
    snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
