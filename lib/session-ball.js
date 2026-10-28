/**
 * The session ball beside the pet: which sessions it lists, and the one-line
 * messages the host and the helper exchange about them.
 *
 * Ranking is pure so it can be tested without a DSH process. The host fills
 * the records from the session services; the helper only draws the result.
 */

export const SESSION_LIMIT_MAX = 10
const DEFAULT_LIMIT = 5

/** A session id the helper is allowed to hand back. */
export function isSessionId(value) {
  return typeof value === 'string' && /^[\w.:-]{1,200}$/.test(value)
}

/** 1…10, and the default when the setting is missing or nonsense. */
export function clampSessionLimit(value) {
  const number = Math.round(Number(value))
  if (!Number.isFinite(number)) return DEFAULT_LIMIT
  return Math.min(SESSION_LIMIT_MAX, Math.max(1, number))
}

/**
 * The sessions the ball lists: the most recently touched ones, newest first.
 *
 * Order is the last interaction, full stop: a session just prompted leads even
 * while other sessions are still working, so waking an old session moves it to
 * the top at once. Running is reported as the row's status, not used to
 * reorder; otherwise every running session would tie at "now" and the list
 * would fall back to id order instead of recency.
 *
 * A delegated subagent is left out: `origin: 'subagent'` or a positive
 * `delegationDepth`. A child that the user started and drove themselves (a
 * side thread or a seeded fork, `delegationDepth: 0`) is a session in its own
 * right and stays. Parentage alone is not a reason to hide a session.
 * A blank session (created, never sent to) is left out too, unless it is
 * running right now.
 *
 * Each record is `{ id, createdAt, origin?, delegationDepth?, blank?, lastPromptAt?, running? }`.
 * Returns `{ id, status }` with `status` of `running` or `idle`.
 */
export function rankSessions(records, { limit = DEFAULT_LIMIT } = {}) {
  const ranked = []
  for (const record of records ?? []) {
    if (record === null || typeof record !== 'object') continue
    if (!isSessionId(record.id)) continue
    if (record.origin === 'subagent' || Number(record.delegationDepth) > 0) continue
    const running = record.running === true
    if (record.blank === true && !running) continue
    let at = Number(record.createdAt)
    if (!Number.isFinite(at)) at = 0
    if (typeof record.lastPromptAt === 'number' && Number.isFinite(record.lastPromptAt)) {
      at = Math.max(at, record.lastPromptAt)
    }
    ranked.push({ id: record.id, at, running })
  }
  ranked.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return ranked.slice(0, clampSessionLimit(limit)).map((item) => ({
    id: item.id,
    status: item.running ? 'running' : 'idle',
  }))
}

/**
 * The session-list metadata for one listed record, from the freshest source.
 *
 * `cachedSnapshot` only serves cells that something already materialized, and
 * a session resumed from cold has none: without this fallback its
 * `lastPromptAt` is missing, it sorts by creation time, and waking it up moves
 * nothing. `snapshot` materializes the cell (folding history once), which is
 * what makes a just-resumed session lead the list. A cold session has no
 * Session object at all, so its durable checkpoint is the best source there is.
 *
 * Returns `{ blank, lastPromptAt }` or undefined; a broken projection only
 * means the order falls back to creation time, never an exception.
 */
export function sessionMetadata(services, header, live) {
  if (live != null && services?.projections !== undefined) {
    try {
      const cached = services.projections.cachedSnapshot?.(live)?.values?.sessionListMetadata
      if (cached !== undefined) return cached
    } catch { /* a read that fails must not block the materializing one */ }
    try {
      const fresh = services.projections.snapshot?.(live, ['sessionListMetadata'])?.values?.sessionListMetadata
      if (fresh !== undefined) return fresh
    } catch { /* the durable row still names the last prompt */ }
  }
  try {
    return services?.cache?.cachedSnapshot?.(header)?.values?.sessionListMetadata
  } catch {
    return undefined
  }
}

/**
 * One projection file, as the ball's ranker wants it.
 *
 * The files are large and only four fields matter: when the session was
 * created, when it was last talked to, whether it is still blank, and its
 * title. Those sit under `identity` and `rows.*.val`.
 */
export function shapeCachedText(id, text) {
  if (!isSessionId(id) || typeof text !== 'string') return null
  const created = /"createdAt"\s*:\s*(-?\d+)/.exec(text)
  const metaAt = text.indexOf('"sessionListMetadata"')
  const meta = metaAt < 0 ? '' : text.slice(metaAt, metaAt + 500)
  const blank = /"blank"\s*:\s*(true|false)/.exec(meta)
  const prompt = /"lastPromptAt"\s*:\s*(-?\d+)/.exec(meta)
  const titleAt = text.indexOf('"title"')
  let title = ''
  if (titleAt >= 0) {
    const match = /"val"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(text.slice(titleAt, titleAt + 800))
    if (match !== null) {
      try {
        title = JSON.parse(`"${match[1]}"`)
      } catch {
        title = ''
      }
    }
  }
  const rowsAt = text.indexOf('"rows"')
  const head = text.slice(0, rowsAt < 0 ? 800 : rowsAt)
  const cwd = /"cwd"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(head)
  let path = ''
  if (cwd !== null) {
    try {
      path = JSON.parse(`"${cwd[1]}"`)
    } catch {
      path = ''
    }
  }
  return {
    id,
    createdAt: created === null ? undefined : Number(created[1]),
    lastPromptAt: prompt === null ? undefined : Number(prompt[1]),
    blank: blank?.[1] === 'true',
    title: typeof title === 'string' ? title : '',
    cwd: typeof path === 'string' ? path : '',
  }
}

/** The same fields off an already-parsed projection record. */
export function shapeCachedRecord(id, data) {
  if (!isSessionId(id) || data === null || typeof data !== 'object') return null
  const record = data.record
  if (record === null || typeof record !== 'object') return null
  const rows = record.rows
  const meta = rows?.sessionListMetadata?.val
  const title = rows?.title?.val
  return {
    id,
    createdAt: record.identity?.createdAt,
    lastPromptAt: typeof meta?.lastPromptAt === 'number' ? meta.lastPromptAt : undefined,
    blank: meta?.blank === true,
    title: typeof title === 'string' ? title : '',
    cwd: typeof record.identity?.cwd === 'string' ? record.identity.cwd : '',
  }
}

/**
 * The workspace a session's directory belongs to.
 *
 * A session inside a nested workspace matches that one, not the parent
 * directory that happens to be a workspace too. The stored title is returned
 * as-is; the helper turns `default-workspace` into the localized name.
 */
export function workspaceTitle(workspaces, cwd) {
  if (typeof cwd !== 'string' || cwd === '') return ''
  const normalized = cwd.replace(/\/+$/, '')
  let best = ''
  let bestLen = -1
  for (const item of workspaces ?? []) {
    if (item === null || typeof item !== 'object') continue
    const path = typeof item.path === 'string' ? item.path.replace(/\/+$/, '') : ''
    if (path === '') continue
    if (normalized === path || normalized.startsWith(path + '/')) {
      if (path.length > bestLen) {
        bestLen = path.length
        best = typeof item.title === 'string' ? item.title : ''
      }
    }
  }
  return best.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80)
}

/** Attach each ranked row to the workspace its directory belongs to. */
export function withWorkspace(items, records, workspaces) {
  const cwdOf = new Map()
  for (const record of records ?? []) {
    if (!isSessionId(record?.id)) continue
    cwdOf.set(record.id, typeof record.cwd === 'string' ? record.cwd : '')
  }
  return (items ?? []).map((item) => ({
    ...item,
    workspace: workspaceTitle(workspaces, cwdOf.get(item.id) ?? ''),
  }))
}

/** One title snapshot from `readTitleSnapshots`, as the text the ball shows. */
export function titleOf(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object' || snapshot.status === 'rejected') return ''
  const raw = snapshot.value?.title ?? snapshot.title
  const text = typeof raw === 'string' ? raw : raw?.title
  if (typeof text !== 'string') return ''
  return text.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80)
}

/** The stdin line that lists every workspace the pet's menu can start in. */
export function workspacesLine(items) {
  const safe = []
  for (const item of items ?? []) {
    if (!isSessionId(item?.id)) continue
    const title = typeof item.title === 'string' ? item.title.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80) : ''
    safe.push({ id: item.id, title })
  }
  return `workspaces ${JSON.stringify(safe)}\n`
}

/**
 * The helper's "start a session here" line: `ask` plus one JSON object.
 * A bad id or a blank question is ignored, so a stray line cannot open a session.
 */
export function parseAskLine(line) {
  if (typeof line !== 'string' || !line.startsWith('ask ')) return null
  let body
  try {
    body = JSON.parse(line.slice(4))
  } catch {
    return null
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  if (!isSessionId(body.workspaceId) || typeof body.text !== 'string') return null
  const text = body.text.trim()
  if (text === '') return null
  return { workspaceId: body.workspaceId, text: text.slice(0, 8000) }
}

/** The stdin line that tells the helper what to draw. One line, always. */
export function sessionsLine(items) {
  const safe = []
  for (const item of items ?? []) {
    if (!isSessionId(item?.id)) continue
    safe.push({
      id: item.id,
      title: typeof item.title === 'string' ? item.title.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80) : '',
      status: item.status === 'running' ? 'running' : 'idle',
      workspace: typeof item.workspace === 'string' ? item.workspace.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80) : '',
    })
  }
  return `sessions ${JSON.stringify(safe)}\n`
}

/**
 * The "open this session" and "open the settings page" signals between the
 * helper and the page.
 *
 * The helper says so through stdout; the page waits on a route. A wait that
 * nobody answers comes back empty, so a reload never re-opens the session that
 * was opened last time. A settings request is one-shot: the wait that receives
 * it consumes it, so a later reload does not pop the dialog again.
 */
export function createFocusBus() {
  let seq = 0
  let id = ''
  let settings = false
  let waiters = []
  const take = () => {
    const value = { seq, id, settings }
    settings = false
    return value
  }
  const notify = () => {
    if (waiters.length === 0) return
    const value = take()
    const pending = waiters
    waiters = []
    for (const wake of pending) wake(value)
  }
  return {
    publish(next) {
      if (!isSessionId(next)) return false
      seq += 1
      id = next
      settings = false
      notify()
      return true
    },
    publishSettings() {
      seq += 1
      id = ''
      settings = true
      notify()
      return true
    },
    current() {
      return { seq, id, settings }
    },
    wait(since, timeoutMs = 20000) {
      const seen = Number(since) || 0
      if (seq > seen) return Promise.resolve(take())
      return new Promise((resolve) => {
        const wake = (value) => {
          clearTimeout(timer)
          resolve(value)
        }
        const timer = setTimeout(() => {
          waiters = waiters.filter((item) => item !== wake)
          resolve({ seq, id: '', settings: false })
        }, timeoutMs)
        waiters.push(wake)
      })
    },
  }
}
