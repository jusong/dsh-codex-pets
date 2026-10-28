/**
 * The session ball: which sessions it lists, the line the helper is sent,
 * and the "open this session" signal the page waits on.
 *
 *   node tools/test-session-ball.mjs
 */
import assert from 'node:assert/strict'
import { helperAction } from '../lib/helper-actions.js'
import { formatShortcut, shortcutFromKeyboard } from '../lib/shortcut.js'
import { clampSessionLimit, createFocusBus, parseAskLine, rankSessions, sessionMetadata, sessionsLine, shapeCachedRecord, shapeCachedText, titleOf, withWorkspace, workspaceTitle, workspacesLine } from '../lib/session-ball.js'

let checks = 0
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks += 1 }

eq(clampSessionLimit(undefined), 5, 'a missing limit is 5')
eq(clampSessionLimit(0), 1, 'zero becomes 1')
eq(clampSessionLimit(11), 10, 'eleven becomes 10')
eq(clampSessionLimit(7.4), 7, 'a fraction rounds')

const records = [
  { id: 'old', createdAt: 100, lastPromptAt: 200 },
  { id: 'new', createdAt: 50, lastPromptAt: 900 },
  { id: 'subagent', createdAt: 9999, origin: 'subagent', delegationDepth: 1, lastPromptAt: 9999 },
  { id: 'side-thread', createdAt: 300, parentSession: 'new', delegationDepth: 0, lastPromptAt: 600 },
  { id: 'blank', createdAt: 800, blank: true },
  { id: 'busy-blank', createdAt: 10, blank: true, running: true },
  { id: 'nope id', createdAt: 99999 },
  { id: 'idle-recent', createdAt: 1, lastPromptAt: 500 },
]
eq(rankSessions(records, { limit: 10 }).map((item) => item.id),
  ['new', 'side-thread', 'idle-recent', 'old', 'busy-blank'],
  'last interaction first; subagents, blank sessions and bad ids are left out, side threads stay')
eq(rankSessions(records, { limit: 10 }).map((item) => item.status),
  ['idle', 'idle', 'idle', 'idle', 'running'],
  'only a running session is marked running, and busy does not reorder')
eq(rankSessions(records, { limit: 2 }).map((item) => item.id),
  ['new', 'side-thread'],
  'the limit cuts the list after the ranking')
eq(rankSessions([
  { id: 'seeded-child', createdAt: 10, parentSession: 'parent', delegationDepth: 0, lastPromptAt: 900 },
  { id: 'recent', createdAt: 800, lastPromptAt: 850 },
], { limit: 5 }).map((item) => item.id),
  ['seeded-child', 'recent'],
  'a seeded side/fork session is user-facing and keeps its own place')
eq(rankSessions([
  { id: 'delegated', parentSession: 'parent', origin: 'subagent', delegationDepth: 1, createdAt: 900 },
  { id: 'nested', parentSession: 'parent', delegationDepth: 2, createdAt: 900 },
  { id: 'top', createdAt: 10, lastPromptAt: 500 },
], { limit: 5 }).map((item) => item.id),
  ['top'],
  'delegated subagents stay out, with or without the origin label')
eq(rankSessions([
  { id: 'running-old', createdAt: 100, lastPromptAt: 200, running: true },
  { id: 'just-touched', createdAt: 10, lastPromptAt: 900 },
], { limit: 5 }).map((item) => item.id),
  ['just-touched', 'running-old'],
  'a session woken later leads even while another one is running')
eq(rankSessions([{ id: 'a', createdAt: 5 }, { id: 'b', createdAt: 5, lastPromptAt: 1 }], { limit: 5 }).map((i) => i.id),
  ['a', 'b'],
  'without a later prompt, creation time is the order, and a tie breaks by id')

// A resumed session has no materialized projection cell. Reading it has to
// make one, otherwise its old createdAt keeps it off the list forever.
const resumedServices = {
  projections: {
    cachedSnapshot: () => undefined,
    snapshot: () => ({ values: { sessionListMetadata: { blank: false, lastPromptAt: 900 } } }),
  },
  cache: { cachedSnapshot: () => ({ values: { sessionListMetadata: { blank: false, lastPromptAt: 1 } } }) },
}
const resumed = sessionMetadata(resumedServices, { id: 'session-a', createdAt: 10 }, {})
eq(resumed, { blank: false, lastPromptAt: 900 },
  'a resumed session takes the just-materialized prompt, not its old checkpoint')
eq(rankSessions([
  { id: 'session-a', createdAt: 10, ...resumed },
  { id: 'session-b', createdAt: 800, lastPromptAt: 850 },
], { limit: 5 }).map((item) => item.id)[0], 'session-a',
  'so a session woken after a long time leads the list')

let folds = 0
const materialized = { blank: false, lastPromptAt: 700 }
const warmServices = {
  projections: {
    cachedSnapshot: () => ({ values: { sessionListMetadata: materialized } }),
    snapshot: () => { folds += 1; return { values: {} } },
  },
}
eq(sessionMetadata(warmServices, { id: 'session-w' }, {}), materialized, 'a materialized cell is used as it is')
eq(folds, 0, 'without folding the log again')

eq(sessionMetadata({
  cache: { cachedSnapshot: () => ({ values: { sessionListMetadata: { blank: false, lastPromptAt: 400 } } }) },
}, { id: 'session-c', createdAt: 5 }, undefined), { blank: false, lastPromptAt: 400 },
  'a cold session reads its durable checkpoint')

eq(sessionMetadata({
  projections: { cachedSnapshot() { throw new Error('cell') }, snapshot() { throw new Error('fold') } },
  cache: { cachedSnapshot() { throw new Error('row') } },
}, { id: 'session-d' }, {}), undefined, 'a broken projection never breaks the list')

eq(titleOf({ status: 'fulfilled', value: { title: { title: 'Say hello' } } }), 'Say hello', 'a folded title')
eq(titleOf({ status: 'fulfilled', value: {} }), '', 'a session with no title')
eq(titleOf({ status: 'rejected', reason: new Error('x') }), '', 'a failed fold')
eq(titleOf({ status: 'fulfilled', value: { title: { title: 'a\nb\tc' } } }), 'a b c', 'newlines do not survive into the one-line protocol')

eq(sessionsLine([{ id: 'abc', title: 'Say hello', status: 'running' }]),
  'sessions [{"id":"abc","title":"Say hello","status":"running","workspace":""}]\n',
  'one stdin line')
eq(sessionsLine([{ id: 'abc', title: 'Say hello', status: 'idle', workspace: 'default-workspace' }]),
  'sessions [{"id":"abc","title":"Say hello","status":"idle","workspace":"default-workspace"}]\n',
  'a session line keeps the workspace it belongs to')
eq(sessionsLine([]), 'sessions []\n', 'an empty list is still one line')
eq(sessionsLine([{ id: 'bad id', title: 'x', status: 'running' }]), 'sessions []\n', 'an id the helper cannot quote is dropped')

eq(workspacesLine([{ id: 'ws-1', title: 'default-workspace' }]),
  'workspaces [{"id":"ws-1","title":"default-workspace"}]\n',
  'the menu gets one workspace line')
eq(workspacesLine([{ id: 'bad id', title: 'x' }]), 'workspaces []\n', 'a workspace id with a space is dropped')
eq(parseAskLine('ask {"workspaceId":"ws-1","text":"  hello\\n"}'),
  { workspaceId: 'ws-1', text: 'hello' },
  'a submitted question is the trimmed text')
eq(parseAskLine('ask {"workspaceId":"bad id","text":"hello"}'), null, 'a bad workspace id is not a question')
eq(parseAskLine('ask {"workspaceId":"ws-1","text":"   "}'), null, 'a blank question is not sent')
eq(parseAskLine('open ws-1'), null, 'another helper line is not a question')

eq(helperAction('activate'), { type: 'activate' }, 'a pet click activates DSH')
eq(helperAction('open session-1'), { type: 'open', id: 'session-1' }, 'a session row activates DSH and opens that session')
eq(helperAction('ask {"workspaceId":"ws-1","text":"hello"}'),
  { type: 'ask', workspaceId: 'ws-1', text: 'hello' },
  'a submitted question stays a background ask')
eq(helperAction('open bad id'), null, 'a malformed open command is ignored')
eq(helperAction('settings'), { type: 'settings' }, 'settings is its own action, not a new session')
eq(helperAction('ask {"workspaceId":"ws-1","text":"settings"}')?.type, 'ask', 'a question is never the settings page')

eq(shortcutFromKeyboard({ code: 'KeyN', key: 'n', metaKey: true, altKey: true }), 'Command+Option+N', '⌘⌥N is recorded as a chord')
eq(shortcutFromKeyboard({ code: 'KeyN', key: 'n', metaKey: true }), undefined, 'one modifier is not a chord')
eq(shortcutFromKeyboard({ code: 'Backspace', key: 'Backspace' }), '', 'delete clears the shortcut')
eq(formatShortcut('Command+Option+N'), '⌘⌥N', 'a stored chord is shown with symbols')
eq(workspaceTitle([
  { path: '/work/default-workspace', title: 'default-workspace' },
  { path: '/work/default-workspace/dsh-pet', title: 'dsh-pet' },
], '/work/default-workspace/dsh-pet'), 'dsh-pet', 'the deepest workspace owns the session')
eq(withWorkspace(
  [{ id: 'session-1', status: 'running', title: 'Hi' }],
  [{ id: 'session-1', cwd: '/work/default-workspace' }],
  [{ path: '/work/default-workspace', title: 'default-workspace' }],
), [{ id: 'session-1', status: 'running', title: 'Hi', workspace: 'default-workspace' }],
'a ranked row picks up its workspace')

eq(shapeCachedRecord('session-1', {
  record: {
    identity: { createdAt: 50 },
    rows: {
      title: { val: 'Say hello' },
      sessionListMetadata: { val: { blank: false, lastPromptAt: 80 } },
    },
  },
}), { id: 'session-1', createdAt: 50, lastPromptAt: 80, blank: false, title: 'Say hello', cwd: '' },
'a projection file becomes one ranked record')
eq(shapeCachedRecord('session-2', { record: { rows: { sessionListMetadata: { val: { blank: true } } } } })?.blank, true,
'a blank projection stays blank')
eq(shapeCachedRecord('bad id', { record: {} }), null, 'a bad id is not a record')
eq(shapeCachedText('session-1', '{"record":{"identity":{"createdAt":50},"rows":{"title":{"val":"Say \\"hi\\""},"sessionListMetadata":{"val":{"blank":false,"lastPromptAt":80}}}}}'),
  { id: 'session-1', createdAt: 50, lastPromptAt: 80, blank: false, title: 'Say "hi"', cwd: '' },
  'the same fields can be read without parsing the whole file')
eq(shapeCachedText('session-1', '{"record":{"identity":{"cwd":"/work/default-workspace","createdAt":1},"rows":{}}}')?.cwd,
  '/work/default-workspace', 'a cached session keeps the directory it runs in')

const bus = createFocusBus()
eq(bus.publish('not an id'), false, 'a bad id is ignored')
eq(bus.current(), { seq: 0, id: '', settings: false }, 'and changes nothing')
const early = await bus.wait(0, 30)
eq(early, { seq: 0, id: '', settings: false }, 'a wait nobody answers comes back empty')
const pending = bus.wait(0, 1000)
eq(bus.publish('session-1'), true, 'a click publishes')
eq(await pending, { seq: 1, id: 'session-1', settings: false }, 'and wakes the page that is waiting')
eq(await bus.wait(1, 30), { seq: 1, id: '', settings: false }, 'the same click is not delivered again')
const again = bus.wait(1, 1000)
bus.publish('session-2')
eq(await again, { seq: 2, id: 'session-2', settings: false }, 'a later click is a new signal')
const settingsPending = bus.wait(2, 1000)
eq(bus.publishSettings(), true, 'the menu asks for the settings page')
eq(await settingsPending, { seq: 3, id: '', settings: true }, 'and wakes the page that is waiting')
eq(await bus.wait(3, 30), { seq: 3, id: '', settings: false }, 'a settings request is delivered once')
eq(bus.current(), { seq: 3, id: '', settings: false }, 'and is consumed by that delivery')
bus.publishSettings()
eq(await bus.wait(3, 1000), { seq: 4, id: '', settings: true }, 'a request with nobody waiting stays for the next page')
eq(await bus.wait(4, 30), { seq: 4, id: '', settings: false }, 'then is gone')

console.log(`\nsession ball: ${checks} checks passed`)
