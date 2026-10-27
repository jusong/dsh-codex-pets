/**
 * The session ball: which sessions it lists, the line the helper is sent,
 * and the "open this session" signal the page waits on.
 *
 *   node tools/test-session-ball.mjs
 */
import assert from 'node:assert/strict'
import { clampSessionLimit, createFocusBus, rankSessions, sessionMetadata, sessionsLine, shapeCachedRecord, shapeCachedText, titleOf } from '../lib/session-ball.js'

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
  'sessions [{"id":"abc","title":"Say hello","status":"running"}]\n',
  'one stdin line')
eq(sessionsLine([]), 'sessions []\n', 'an empty list is still one line')
eq(sessionsLine([{ id: 'bad id', title: 'x', status: 'running' }]), 'sessions []\n', 'an id the helper cannot quote is dropped')

eq(shapeCachedRecord('session-1', {
  record: {
    identity: { createdAt: 50 },
    rows: {
      title: { val: 'Say hello' },
      sessionListMetadata: { val: { blank: false, lastPromptAt: 80 } },
    },
  },
}), { id: 'session-1', createdAt: 50, lastPromptAt: 80, blank: false, title: 'Say hello' },
'a projection file becomes one ranked record')
eq(shapeCachedRecord('session-2', { record: { rows: { sessionListMetadata: { val: { blank: true } } } } })?.blank, true,
'a blank projection stays blank')
eq(shapeCachedRecord('bad id', { record: {} }), null, 'a bad id is not a record')
eq(shapeCachedText('session-1', '{"record":{"identity":{"createdAt":50},"rows":{"title":{"val":"Say \\"hi\\""},"sessionListMetadata":{"val":{"blank":false,"lastPromptAt":80}}}}}'),
  { id: 'session-1', createdAt: 50, lastPromptAt: 80, blank: false, title: 'Say "hi"' },
  'the same fields can be read without parsing the whole file')

const bus = createFocusBus()
eq(bus.publish('not an id'), false, 'a bad id is ignored')
eq(bus.current(), { seq: 0, id: '' }, 'and changes nothing')
const early = await bus.wait(0, 30)
eq(early, { seq: 0, id: '' }, 'a wait nobody answers comes back empty')
const pending = bus.wait(0, 1000)
eq(bus.publish('session-1'), true, 'a click publishes')
eq(await pending, { seq: 1, id: 'session-1' }, 'and wakes the page that is waiting')
eq(await bus.wait(1, 30), { seq: 1, id: '' }, 'the same click is not delivered again')
const again = bus.wait(1, 1000)
bus.publish('session-2')
eq(await again, { seq: 2, id: 'session-2' }, 'a later click is a new signal')

console.log(`\nsession ball: ${checks} checks passed`)
