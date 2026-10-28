/**
 * The host and the window together, with nothing mocked but DSH itself.
 *
 * Mounts the real `lib/index.js` as DSH Desktop would (ELECTRON_RUN_AS_NODE=1),
 * lets it start the real pet window in the real Electron, and checks the
 * parts that only show up with two processes: the window comes up, stops with
 * the host, and goes away when the host is killed outright.
 *
 * Electron is not downloaded here. If the machine has not fetched it yet
 * (`~/.dsh/dsh-codex-pets-runtime`) the test says so and passes.
 *
 *   node tools/test-host-window.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const realRuntime = join(homedir(), '.dsh', 'dsh-codex-pets-runtime')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function until(check, ms, what) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}

// ---- the child: a pretend DSH that mounts the plugin ------------------------

if (process.argv[2] === 'child') {
  const { apply } = await import('../lib/index.js')
  const disposers = []
  const registry = { list: () => [{ id: 'w1', title: 'default-workspace' }] }
  const ctx = {
    logger: { info: () => {}, warn: (m) => console.error(m), debug: () => {} },
    inject: () => {},
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    on: () => () => {},
    get: (name) => (name === 'workspaceRegistry' ? registry : undefined),
  }
  apply(ctx, { pet: 'deepseek-whale', size: 100, shortcut: '' })
  process.on('message', (message) => {
    if (message === 'stop') {
      for (const dispose of disposers) dispose()
      process.exit(0)
    }
  })
  process.send?.('mounted')
  setInterval(() => {}, 1000)
} else {
  // ---- the test ---------------------------------------------------------------

  if (process.platform !== 'darwin' || !existsSync(join(realRuntime, 'electron'))) {
    console.log('skipped: Electron is not fetched on this machine yet (start the plugin once, or run the runtime fetch)')
    process.exit(0)
  }
  const found = existsSync(join(realRuntime, 'electron', '43.3.0-darwin-arm64', 'Electron.app'))
  if (!found) {
    console.log('skipped: Electron 43.3.0 is not in the runtime folder')
    process.exit(0)
  }

  // A home of its own, so the test never touches the real lock or state files.
  const home = mkdtempSync(join(tmpdir(), 'dsh-host-window-'))
  mkdirSync(join(home, '.dsh'), { recursive: true })
  symlinkSync(realRuntime, join(home, '.dsh', 'dsh-codex-pets-runtime'))
  const lock = join(home, '.dsh', 'dsh-codex-pets.pid')
  const state = join(home, '.dsh', 'dsh-codex-pets-state.json')

  async function launch() {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'child'], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, HOME: home, ELECTRON_RUN_AS_NODE: '1', DSH_CODEX_PETS_USER_DIR: join(home, 'pets') },
    })
    await until(() => new Promise((resolve) => child.once('message', () => resolve(true))), 10000, 'the host to mount')
    const windowPid = await until(() => {
      if (!existsSync(lock)) return null
      const pid = Number(readFileSync(lock, 'utf8').trim().split(/\s+/)[0])
      return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : null
    }, 30000, 'the pet window to take its lock')
    return { child, windowPid }
  }

  // 1. The window comes up, and a polite stop takes it down and frees the lock.
  let { child, windowPid } = await launch()
  assert.notEqual(windowPid, child.pid, 'the window is a process of its own')
  child.send('stop')
  await until(() => !alive(windowPid), 8000, 'the window to stop with the host')
  await until(() => !existsSync(lock) || readFileSync(lock, 'utf8').trim() === '', 5000, 'the lock to be released')
  console.log(`ok  window ${windowPid} came up and stopped with the host`)
  await until(() => !alive(child.pid), 5000, 'the host to exit')

  // 2. A host that is killed outright (no cleanup) must not leave a pet behind.
  ;({ child, windowPid } = await launch())
  child.kill('SIGKILL')
  await until(() => !alive(windowPid), 10000, 'the window to notice the host is gone')
  console.log(`ok  window ${windowPid} left after the host was killed`)

  // 3. The state file, when written, is the new shape.
  if (existsSync(state)) {
    const saved = JSON.parse(readFileSync(state, 'utf8'))
    assert.equal(saved.v, 2, 'the position is saved as the pet centre')
  }
  console.log('host window test: all assertions passed')
}
