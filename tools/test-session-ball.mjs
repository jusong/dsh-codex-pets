/**
 * The session ball: which sessions it lists, the line the helper is sent,
 * and the "open this session" signal the page waits on.
 *
 *   node tools/test-session-ball.mjs
 */
import assert from 'node:assert/strict'
import { clampSessionLimit, createFocusBus, rankSessions, sessionsLine, shapeCachedRecord, shapeCachedText, titleOf } from '../lib/session-ball.js'

let checks = 0
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks += 1 }

eq(clampSessionLimit(undefined), 5, 'a missing limit is 5')
eq(clampSessionLimit(0), 1, 'zero becomes 1')
eq(clampSessionLimit(11), 10, 'eleven becomes 10')
eq(clampSessionLimit(7.4), 7, 'a fraction rounds')

const now = 1_000_000
const records = [
  { id: 'old', createdAt: 100, lastPromptAt: 200 },
  { id: 'new', createdAt: 50, lastPromptAt: 900 },
  { id: 'child', createdAt: 9999, parentSession: 'new', lastPromptAt: 9999 },
  { id: 'blank', createdAt: 800, blank: true },
  { id: 'busy-blank', createdAt: 10, blank: true, running: true },
  { id: 'nope id', createdAt: 99999 },
  { id: 'idle-recent', createdAt: 1, lastPromptAt: 500 },
]
eq(rankSessions(records, { limit: 10, now }).map((item) => item.id),
  ['busy-blank', 'new', 'idle-recent', 'old'],
  'running first, then last interaction; children, blank and bad ids are left out')
eq(rankSessions(records, { limit: 10, now }).map((item) => item.status),
  ['running', 'idle', 'idle', 'idle'],
  'only a running session is marked running')
eq(rankSessions(records, { limit: 2, now }).map((item) => item.id),
  ['busy-blank', 'new'],
  'the limit cuts the list')
eq(rankSessions([{ id: 'a', createdAt: 5 }, { id: 'b', createdAt: 5, lastPromptAt: 1 }], { limit: 5, now: 0 }).map((i) => i.id),
  ['a', 'b'],
  'without a later prompt, creation time is the order, and a tie breaks by id')

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
