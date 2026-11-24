// The client's own rules: the key header, Idempotency-Key, waiting out 429 and 503, the error it
// raises, the browser refusal, never showing the key, and the test person helpers.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import {
  Pincast, PincastError, isTestKey, isTestPerson, keyInfo, retryAfterSeconds, testActor, testPerson, TEST_PERSON_RE,
} from '../src/index.js'
import { startMock } from '../src/mock.js'

// Made up for the mock; none is a real key.
const SECRET_PART = 'K'.repeat(43)
const KEY = `pck_test-abcdefghij_rk_${SECRET_PART}`
const SECRET = `pck_demo_sk_${'S'.repeat(40)}`
const OLDER = `pck_demo_${'O'.repeat(40)}`
const SET = 'central-park-trees'
const collect = (id = 'test_ana') => ({ card: 'tree:2614648', actor: { id, source: 'anonymous' } })

let mock
before(async () => { mock = await startMock({ key: KEY }) })
after(() => mock.close())

function make(options = {}) {
  const waits = []
  const client = new Pincast({ key: KEY, baseUrl: mock.url, sleep: async (ms) => { waits.push(ms) }, ...options })
  mock.reset()
  return { client, waits }
}

const limited = (code, seconds) => ({ status: 429, code, fix: 'Wait the seconds in Retry-After, then send it again.', headers: seconds == null ? {} : { 'Retry-After': String(seconds) } })

test('sends the key in X-Pincast-Key, never in the address', async () => {
  const { client } = make()
  await client.getCollects(SET, { actor: 'test_ana' })
  const [r] = mock.requests
  assert.equal(r.headers['x-pincast-key'], KEY)
  assert.ok(!r.path.includes(SECRET_PART) && !r.query.toString().includes(SECRET_PART))
})

test('puts a new Idempotency-Key on each of the three writes, and none on the other calls', async () => {
  const { client } = make()
  await client.putSet(SET, { name: 'Central Park Trees' })
  await client.putSet(SET, { name: 'Central Park Trees' })
  await client.postCollect(SET, collect())
  await client.postClaim(SET, { from: 'test_guest', to: 'test_ana' })
  await client.getSet(SET)
  await client.getCollects(SET, { actor: ['test_ana'] })
  await client.postPerson({ testPerson: 'test_ana' })
  await client.getApps()
  await client.postTestApp()
  const keys = mock.requests.map((r) => r.headers['idempotency-key'])
  assert.ok(keys.slice(0, 4).every(Boolean))
  assert.equal(new Set(keys.slice(0, 4)).size, 4, 'a new key for each call')
  assert.deepEqual(keys.slice(4), [undefined, undefined, undefined, undefined, undefined])
})

test('takes your own Idempotency-Key: the same body gets the kept answer, a new body is refused', async () => {
  const { client } = make()
  const first = await client.postClaim(SET, { from: 'test_guest', to: 'test_ana' }, { idempotencyKey: 'claim-1' })
  const again = await client.postClaim(SET, { from: 'test_guest', to: 'test_ana' }, { idempotencyKey: 'claim-1' })
  assert.deepEqual(again, first)
  assert.equal(mock.requests[1].headers['idempotency-key'], 'claim-1')
  await assert.rejects(client.postClaim(SET, { from: 'test_guest', to: 'test_bo' }, { idempotencyKey: 'claim-1' }), (e) => {
    assert.ok(e instanceof PincastError)
    assert.equal(e.status, 422)
    assert.equal(e.code, 'idempotency_key_reused')
    assert.equal(e.kind, 'refused')
    return true
  })
})

test('waits out 429 rate_limited for Retry-After seconds, then sends again with the same Idempotency-Key', async () => {
  const { client, waits } = make()
  mock.answerNext(limited('rate_limited', 7))
  const got = await client.postCollect(SET, collect())
  assert.equal(got.collected, true)
  assert.deepEqual(waits, [7000])
  assert.equal(mock.requests.length, 2)
  assert.equal(mock.requests[0].headers['idempotency-key'], mock.requests[1].headers['idempotency-key'])
})

test('waits out 429 quota_exceeded the same way', async () => {
  const { client, waits } = make()
  mock.answerNext(limited('quota_exceeded', 45))
  await client.getSet(SET)
  assert.deepEqual(waits, [45000])
  assert.equal(mock.requests.length, 2)
})

test('a Retry-After past maxRetryWait is raised at once with its seconds; maxRetryWait: Infinity waits it out', async () => {
  const { client, waits } = make()
  mock.answerNext(limited('quota_exceeded', 40000))
  await assert.rejects(client.getSet(SET), (e) => {
    assert.equal(e.status, 429)
    assert.equal(e.code, 'quota_exceeded')
    assert.equal(e.retryAfter, 40000)
    assert.equal(e.kind, 'later')
    return true
  })
  assert.deepEqual(waits, [])
  const patient = make({ maxRetryWait: Infinity })
  mock.answerNext(limited('quota_exceeded', 40000))
  await patient.client.getSet(SET)
  assert.deepEqual(patient.waits, [40000000])
})

test('stops after `retries` waits and raises the last 429', async () => {
  const { client, waits } = make()
  mock.answerNext(limited('rate_limited', 1), limited('rate_limited', 1), limited('rate_limited', 1))
  await assert.rejects(client.getSet(SET), { name: 'PincastError', code: 'rate_limited', status: 429 })
  assert.deepEqual(waits, [1000, 1000])
  assert.equal(mock.requests.length, 3)
})

test('a 429 with no Retry-After is raised, not sent again', async () => {
  const { client, waits } = make()
  mock.answerNext(limited('test_apps_limit', null))
  await assert.rejects(client.postTestApp({ name: 'Bird log' }), { code: 'test_apps_limit', retryAfter: null })
  assert.deepEqual(waits, [])
  assert.equal(mock.requests.length, 1)
})

test('waits out a 503 signin_check_unavailable that sends Retry-After', async () => {
  const { client, waits } = make()
  mock.answerNext({ status: 503, code: 'signin_check_unavailable', fix: 'Send it again after Retry-After seconds.', headers: { 'Retry-After': '3' } })
  await client.postPerson({ testPerson: 'test_ana' })
  assert.deepEqual(waits, [3000])
})

test('a refusal raises a PincastError with status, code, field, fix and kind', async () => {
  const { client } = make()
  await assert.rejects(client.postCollect(SET, { card: 'tree:2614648' }), (e) => {
    assert.ok(e instanceof PincastError)
    assert.equal(e.operation, 'postCollect')
    assert.equal(e.status, 400)
    assert.equal(e.code, 'field_required')
    assert.equal(e.field, 'actor')
    assert.match(e.fix, /actor/)
    assert.match(e.message, /^postCollect \(POST \/sets\/\{set\}\/collects\): 400 field_required \(actor\): /)
    assert.equal(e.kind, 'refused')
    return true
  })
  mock.answerNext({ status: 403, code: 'person_not_signed_in', fix: 'Send their ID token to POST /people first.' })
  await assert.rejects(client.postCollect(SET, collect('q8n2v5x7c1z4')), { kind: 'waiting' })
  await assert.rejects(new Pincast({ key: `pck_demo_rk_${'W'.repeat(40)}`, baseUrl: mock.url }).getSet(SET), { status: 403, code: 'key_invalid', kind: 'key' })
  mock.answerNext({ status: 404, code: 'set_not_registered', fix: 'Put the set first.' })
  await assert.rejects(client.postCollect(SET, collect()), { kind: 'later' })
})

test('with no key, a keyed call raises key_missing before sending; keyless calls go out', async () => {
  const { client } = make({ key: null })
  await assert.rejects(client.getSet(SET), { code: 'key_missing', status: null, kind: 'key' })
  assert.equal(mock.requests.length, 0)
  assert.equal((await client.getApps()).apps.length > 0, true)
  assert.equal((await client.postTestApp()).app.mode, 'test')
})

test('reads PINCAST_KEY when no key is passed', async () => {
  const before = process.env.PINCAST_KEY
  process.env.PINCAST_KEY = KEY
  try {
    const client = new Pincast({ baseUrl: mock.url })
    mock.reset()
    await client.getSet(SET)
    assert.equal(mock.requests[0].headers['x-pincast-key'], KEY)
  } finally {
    if (before === undefined) delete process.env.PINCAST_KEY
    else process.env.PINCAST_KEY = before
  }
})

test('no answer raises a PincastError with status null and kind later', async () => {
  const client = new Pincast({ key: KEY, fetch: async () => { throw new TypeError('fetch failed') } })
  await assert.rejects(client.getSet(SET), (e) => {
    assert.equal(e.status, null)
    assert.equal(e.kind, 'later')
    assert.match(e.message, /no answer \(fetch failed\)/)
    assert.ok(e.cause instanceof TypeError)
    return true
  })
})

test('refuses every key in a web page, and runs there with no key', () => {
  globalThis.window = {}
  globalThis.document = {}
  try {
    assert.throws(() => new Pincast({ key: SECRET }), { name: 'PincastError', code: 'browser_not_allowed', kind: 'key' })
    assert.throws(() => new Pincast({ key: OLDER }), { code: 'browser_not_allowed' }, 'an older key works as a secret key')
    assert.throws(() => new Pincast({ key: 'not-a-pincast-key' }), { code: 'browser_not_allowed' })
    assert.throws(() => new Pincast({ key: KEY }), (e) => { assert.equal(e.code, 'browser_not_allowed'); assert.doesNotMatch(e.message, /secret/i); return true }, 'a restricted key is refused too')
    assert.equal(new Pincast({ key: null }).keyInfo, null)
  } finally {
    delete globalThis.window
    delete globalThis.document
  }
  assert.equal(new Pincast({ key: SECRET }).keyInfo.kind, 'secret', 'on a server a secret key is fine')
  assert.equal(new Pincast({ key: KEY }).keyInfo.kind, 'restricted', 'on a server a restricted key is fine')
})

test('never shows the key: not in inspect, JSON or any error', async () => {
  const { client } = make()
  assert.ok(!inspect(client).includes(SECRET_PART))
  assert.ok(!JSON.stringify(client).includes(SECRET_PART))
  const shown = []
  mock.answerNext({ status: 401, code: 'key_missing', fix: 'Send your key.' }, { status: 500, body: { url: '/x', statusCode: 500, statusMessage: 'Server Error', message: 'down' } })
  for (const call of [() => client.getSet(SET), () => client.getSet(SET), () => client.postCollect(SET, {})]) {
    const e = await call().catch((x) => x)
    shown.push(e.message, String(e.stack), JSON.stringify(e), JSON.stringify(e.body))
  }
  assert.ok(shown.every((s) => !s.includes(SECRET_PART)))
})

test('keyInfo and isTestKey read a key without its secret', () => {
  assert.deepEqual({ ...keyInfo(KEY) }, { app: 'test-abcdefghij', kind: 'restricted', test: true })
  assert.deepEqual({ ...keyInfo(SECRET) }, { app: 'demo', kind: 'secret', test: false })
  assert.deepEqual({ ...keyInfo(OLDER) }, { app: 'demo', kind: 'secret', test: false })
  assert.equal(keyInfo('sk_live_123'), null)
  assert.equal(isTestKey(KEY), true)
  assert.equal(isTestKey(SECRET), false)
})

test('test person helpers make ids the API takes', async () => {
  assert.equal(testPerson('Ana Lee'), 'test_ana-lee')
  assert.equal(testPerson('José'), 'test_jose')
  assert.equal(testPerson('test_demo'), 'test_demo')
  const a = testPerson()
  assert.match(a, TEST_PERSON_RE)
  assert.notEqual(a, testPerson())
  assert.throws(() => testPerson('!!!'), TypeError)
  assert.equal(isTestPerson('test_demo'), true)
  assert.equal(isTestPerson('q8n2v5x7c1z4'), false)
  assert.deepEqual(testActor('Ana'), { id: 'test_ana', source: 'anonymous' })
  const { client } = make()
  const got = await client.postCollect(SET, { card: 'tree:2614648', actor: testActor('Ana') })
  assert.equal(got.collected, true)
  assert.deepEqual(mock.requests[0].body.actor, { id: 'test_ana', source: 'anonymous' })
})

test('retryAfterSeconds reads seconds and HTTP dates', () => {
  assert.equal(retryAfterSeconds('120'), 120)
  assert.equal(retryAfterSeconds(null), null)
  assert.equal(retryAfterSeconds('soon'), null)
  const s = retryAfterSeconds(new Date(Date.now() + 30_000).toUTCString())
  assert.ok(s >= 28 && s <= 31)
})
