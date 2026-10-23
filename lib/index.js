/**
 * Host half of dsh-pet: spawn the native macOS helper that owns the floating
 * pet window, and stop it when the plugin unloads.
 *
 * DSH host plugins run in a Node child process (`ELECTRON_RUN_AS_NODE`), not
 * the Electron main process, so they cannot create a BrowserWindow themselves.
 * The helper is a tiny AppKit binary; this file only manages its lifecycle.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-pet'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const helper = join(root, 'bin', 'dsh-pet-macos')
const html = join(root, 'assets', 'pet.html')
const home = homedir()

function clampSize(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 150
  return Math.min(240, Math.max(96, Math.round(number)))
}

export function apply(ctx, config = {}) {
  // The helper activates the Desktop app by bundle id, so it is Desktop-only.
  const desktop = process.env.ELECTRON_RUN_AS_NODE === '1'
  if (process.platform !== 'darwin' || !desktop) {
    ctx.logger?.info?.('dsh-pet: requires DSH Desktop on macOS; skipped')
    return
  }
  if (!existsSync(helper)) {
    ctx.logger?.warn?.(`dsh-pet: native helper missing at ${helper}`)
    return
  }

  const size = clampSize(config.size)
  ctx.effect(() => {
    const child = spawn(helper, [
      '--parent-pid', String(process.pid),
      '--html', html,
      '--size', String(size),
      '--lock', join(home, '.dsh', 'dsh-pet.lock'),
      '--state', join(home, '.dsh', 'dsh-pet-state.json'),
    ], { stdio: 'ignore' })
    child.on('error', (error) => {
      ctx.logger?.warn?.(`dsh-pet: failed to start helper: ${error.message}`)
    })
    child.on('exit', (code, signal) => {
      if (code !== null && code !== 0) ctx.logger?.warn?.(`dsh-pet: helper exited (${code})`)
      else if (signal !== null && signal !== 'SIGTERM') ctx.logger?.debug?.(`dsh-pet: helper stopped (${signal})`)
    })
    return () => {
      try {
        child.kill('SIGTERM')
      } catch {}
    }
  }, 'dsh-pet: floating pet window')
}
