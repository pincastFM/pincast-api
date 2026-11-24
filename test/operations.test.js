// Each operation in the API file, through the client, against the mock built from that file.
// The answer must equal the file's example and fit its schema; the request must fit the file and
// carry the key header and Idempotency-Key exactly when the file says it takes them.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { Pincast } from '../src/index.js'
import { loadApiFile, startMock } from '../src/mock.js'
import { listOperations, resolve } from '../src/openapi.js'
import { validate } from '../src/validate.js'

const KEY = `pck_test-abcdefghij_rk_${'K'.repeat(43)}` // made up for the mock; not a real key
const SET = 'central-park-trees'
const doc = loadApiFile()
const fileOps = listOperations(doc)
const byId = Object.fromEntries(fileOps.map((o) => [o.id, o]))

function requestExample(id, name) {
  const examples = byId[id].body.content['application/json'].examples
  return structuredClone(resolve(doc, examples[name] || Object.values(examples)[0]).value)
}

const cases = {
  putSet: { call: (c) => c.putSet(SET, requestExample('putSet')), path: `/sets/${SET}` },
  getSet: { call: (c) => c.getSet(SET), path: `/sets/${SET}` },
  postCollect: { call: (c) => c.postCollect(SET, requestExample('postCollect')), path: `/sets/${SET}/collects` },
  getCollects: { call: (c) => c.getCollects(SET, { actor: ['guest-7f3c9a2e5b41', 'q8n2v5x7c1z4'] }), path: `/sets/${SET}/collects`, query: 'actor=guest-7f3c9a2e5b41&actor=q8n2v5x7c1z4' },
  postClaim: { call: (c) => c.postClaim(SET, requestExample('postClaim')), path: `/sets/${SET}/claims` },
  postPerson: { call: (c) => c.postPerson(requestExample('postPerson', 'testKey')), path: '/people', example: 'testKey' },
  getApps: { call: (c) => c.getApps(), path: '/apps' },
  postTestApp: { call: (c) => c.postTestApp(requestExample('postTestApp')), path: '/test-apps' },
}

let mock
let client
before(async () => {
  mock = await startMock({ key: KEY })
  client = new Pincast({ key: KEY, baseUrl: mock.url })
})
after(() => mock.close())

test('the cases cover every operation in the API file: 8 of 8', () => {
  assert.equal(fileOps.length, 8)
  assert.deepEqual(Object.keys(cases).sort(), fileOps.map((o) => o.id).sort())
  assert.deepEqual(mock.operations.sort(), fileOps.map((o) => o.id).sort())
})

for (const o of fileOps) {
  test(`${o.id}: ${o.method} ${o.path} against the mock`, async () => {
    mock.reset()
    const c = cases[o.id]
    assert.ok(c, `no case for ${o.id}`)
    const got = await c.call(client)

    const media = resolve(doc, o.op.responses['200']).content['application/json']
    assert.deepEqual(validate(media.schema, got, doc), [], 'the answer fits the API file')
    const name = c.example || Object.keys(media.examples)[0]
    assert.deepEqual(got, resolve(doc, media.examples[name]).value, 'the answer is the file\'s example')

    assert.equal(mock.requests.length, 1)
    const [r] = mock.requests
    assert.equal(r.operationId, o.id)
    assert.equal(r.method, o.method)
    assert.equal(r.path, c.path)
    assert.equal(r.query.toString(), c.query || '')
    assert.equal(r.headers['x-pincast-key'], o.security.length ? KEY : undefined, 'the key goes exactly where the file asks for it')
    assert.equal(r.headers['x-placecard-key'], undefined, 'never the older header')
    const takesIdem = o.params.some((p) => p.in === 'header' && p.name === 'Idempotency-Key')
    if (takesIdem) assert.match(r.headers['idempotency-key'], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    else assert.equal(r.headers['idempotency-key'], undefined)
    if (o.body) assert.deepEqual(validate(o.body.content['application/json'].schema, r.body, doc), [], 'the request body fits the API file')
  })
}

test('postPerson with a sign-in token gets the token example\'s answer', async () => {
  const got = await client.postPerson(requestExample('postPerson', 'story'))
  assert.equal(got.person, 'q8n2v5x7c1z4')
  assert.equal(got.simulated, undefined)
})
