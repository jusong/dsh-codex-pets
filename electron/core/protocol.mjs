/**
 * The lines the host writes on the window's stdin, one per line:
 *
 *   activate | size N | motion on|off | chrome on|off | shortcut "<json>"
 *   sessions [<json>] | workspaces [<json>]
 *
 * Anything that does not parse is ignored (null), so a newer host talking to
 * an older window can never break it.
 */

/** A session or workspace id: short, one word, no line breaks. */
export function isWireId(value) {
  return typeof value === 'string' && value !== '' && value.length <= 200 && !/[\n ]/.test(value)
}

function parseArray(text) {
  try {
    const value = JSON.parse(text)
    return Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

export function parseCommand(line) {
  if (typeof line !== 'string') return null
  if (line === 'activate') return { type: 'activate' }
  if (line === 'motion on' || line === 'motion off') return { type: 'motion', on: line.endsWith(' on') }
  if (line === 'chrome on' || line === 'chrome off') return { type: 'chrome', on: line.endsWith(' on') }
  if (line.startsWith('size ')) {
    const value = Number(line.slice(5).trim())
    return Number.isFinite(value) ? { type: 'size', value } : null
  }
  if (line.startsWith('shortcut ')) {
    try {
      const value = JSON.parse(line.slice('shortcut '.length))
      return typeof value === 'string' ? { type: 'shortcut', value } : null
    } catch {
      return null
    }
  }
  if (line.startsWith('workspaces ')) {
    const rows = parseArray(line.slice('workspaces '.length))
    if (rows === null) return null
    const items = []
    for (const row of rows) {
      if (row === null || typeof row !== 'object' || !isWireId(row.id)) continue
      items.push({ id: row.id, title: (typeof row.title === 'string' ? row.title : '').replaceAll('\n', ' ') })
    }
    return { type: 'workspaces', items }
  }
  if (line.startsWith('sessions ')) {
    const rows = parseArray(line.slice('sessions '.length))
    if (rows === null) return null
    const items = []
    for (const row of rows) {
      if (row === null || typeof row !== 'object' || !isWireId(row.id)) continue
      items.push({
        id: row.id,
        title: typeof row.title === 'string' ? row.title : '',
        status: typeof row.status === 'string' ? row.status : 'idle',
        workspace: typeof row.workspace === 'string' ? row.workspace : '',
      })
    }
    return { type: 'sessions', items }
  }
  return null
}

/** Lines the window writes on stdout. */
export const out = {
  activate: () => 'activate\n',
  settings: () => 'settings\n',
  hide: () => 'hide\n',
  open: (id) => `open ${id}\n`,
  ask: (workspaceId, text) => `ask ${JSON.stringify({ workspaceId, text })}\n`,
}
