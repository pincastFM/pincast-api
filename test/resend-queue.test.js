// The optional resend queue, against the mock: sent, kept for later, refused for good, waiting on a
// person's link, newest first, and the batch stopping at a failure that isn't the collect's own.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { Pincast } from '../src/index.js'
import { startMock } from '../src/mock.js'
import { MemoryStore, ResendQueue } from '../src/resend-queue.js'

const KEY = `pck_test-abcdefghij_rk_${'K'.repeat(43)}` // made up for the mock; not a real key
const SET = 'central-park-trees'
const body = (id = 'test_ana', card = 'tree:2614648') => ({ card, actor: { id, source: 'anonymous' } })
const busy = { status: 500, body: { url: '/x', statusCode: 500, statusMessage: 'Server Error', message: 'down' } }

let mock
before(async () => { mock = await startMock({ key: KEY }) })
after(() => mock.close())

function make() {
  mock.reset()
  let t = 1_000_000
  const now = () => (t += 1000)
  const client = new Pincast({ key: KEY, baseUrl: mock.url, retries: 0 })
  return new ResendQueue(client, { store: new MemoryStore(), settleMs: 0, now })
}

const sent = () => mock.requests.filter((r) => r.operationId === 'postCollect')

test('a collect is kept, sent with its own Idempotency-Key, and marked sent', async () => {
  const q = make()
  const out = await q.collect(SET, body())
  assert.equal(out.result, 'sent')
  const item = await q.store.get(out.id)
  assert.equal(item.state, 'sent')
  assert.equal(item.answer.collected, true)
  assert.equal(sent()[0].headers['idempotency-key'], item.idempotencyKey)
})

test('a collect Placecard could not take stays unsent and goes out after the next one, with the same key', async () => {
  const q = make()
  mock.answerNext(busy)
  const first = await q.collect(SET, body('test_ana'))
  assert.equal(first.result, 'unsent')
  assert.equal((await q.store.get(first.id)).error.status, 500)
  const second = await q.collect(SET, body('test_bo'))
  assert.equal(second.result, 'sent')
  assert.deepEqual(second.resent, { tried: 1, sent: 1, waiting: 0, refused: 0, stopped: null })
  assert.equal((await q.store.get(first.id)).state, 'sent')
  const keys = sent().map((r) => r.headers['idempotency-key'])
  assert.equal(keys[0], keys[2], 'the resend reuses the first attempt\'s key')
})

test('a refused collect keeps its error and is never sent again', async () => {
  const q = make()
  const out = await q.collect(SET, body('test_ana', 'not a card key!'))
  assert.equal(out.result, 'refused')
  const item = await q.store.get(out.id)
  assert.equal(item.state, 'refused')
  assert.equal(item.error.code, 'field_invalid')
  assert.equal(item.error.field, 'card')
  const counts = await q.resend()
  assert.equal(counts.tried, 0)
})

test('person_not_signed_in waits for release(person), then goes out', async () => {
  const q = make()
  mock.answerNext({ status: 403, code: 'person_not_signed_in', fix: 'Send their ID token to POST /people first.' })
  const out = await q.collect(SET, { card: 'tree:2614648', actor: { id: 'q8n2v5x7c1z4', source: 'logto' } })
  assert.equal(out.result, 'waiting')
  assert.equal((await q.resend()).tried, 0, 'a waiting collect is left out of the batch')
  const released = await q.release('q8n2v5x7c1z4')
  assert.equal(released.released, 1)
  assert.equal(released.resent.sent, 1)
  assert.equal((await q.store.get(out.id)).state, 'sent')
})

test('a resend goes newest first and stops at the first failure that is not the collect\'s own', async () => {
  const q = make()
  mock.answerNext(busy, busy, busy)
  const ids = []
  for (const who of ['test_a', 'test_b', 'test_c']) ids.push((await q.collect(SET, body(who))).id)
  assert.equal(sent().length, 3, 'each collect tried once, and each batch stopped at once')
  mock.reset()
  mock.answerNext(busy)
  const stopped = await q.resend()
  assert.equal(stopped.tried, 1)
  assert.equal(stopped.stopped, 'status 500')
  assert.equal(sent()[0].body.actor.id, 'test_c', 'newest first')
  const counts = await q.resend()
  assert.deepEqual(counts, { tried: 3, sent: 3, waiting: 0, refused: 0, stopped: null })
  assert.deepEqual(sent().slice(1).map((r) => r.body.actor.id), ['test_c', 'test_b', 'test_a'])
})

test('a resend without a person leaves a collect kept in the last settleMs alone', async () => {
  mock.reset()
  const client = new Pincast({ key: KEY, baseUrl: mock.url, retries: 0 })
  let t = 0
  const q = new ResendQueue(client, { settleMs: 120_000, now: () => t })
  mock.answerNext(busy)
  await q.collect(SET, body())
  assert.equal((await q.resend()).tried, 0)
  t = 121_000
  assert.equal((await q.resend()).sent, 1)
})
