/**
 * One pet window per user. A lock file holds the owner's pid; a file whose
 * owner is gone is taken over. A plugin reload can overlap the previous
 * window's shutdown, so a live owner is waited for briefly before giving up.
 */
import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Resolves to a release function, or null when another window keeps the lock. */
export async function acquireLock(path, { waitMs = 3000, pid = process.pid } = {}) {
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      const fd = openSync(path, 'wx')
      writeSync(fd, String(pid))
      closeSync(fd)
      return () => {
        try {
          if (readFileSync(path, 'utf8') === String(pid)) rmSync(path, { force: true })
        } catch {}
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') return null
    }
    let owner = 0
    try {
      owner = Number(readFileSync(path, 'utf8'))
    } catch {
      owner = 0
    }
    if (!Number.isInteger(owner) || owner <= 0 || !alive(owner) || owner === pid) {
      rmSync(path, { force: true })
      continue
    }
    if (Date.now() >= deadline) return null
    await sleep(100)
  }
}
