// A local stand-in for the registry, built from the API file and nothing else. It takes every
// operation in the file at its path, runs the file's checks in the file's order (key, set id,
// Idempotency-Key, body) against the file's schemas, and answers with the file's own examples and
// headers. A replayed Idempotency-Key gets the kept answer, marked Idempotent-Replayed: true.
// Every answer it gives is checked against the file's schema first, so the mock can't drift from it.
// For tests: it listens on 127.0.0.1 only and calls nothing outside.
import { readFileSync } from 'node:fs'
import { createServer, STATUS_CODES } from 'node:http'
import { listOperations, resolve } from './openapi.js'
import { validate } from './validate.js'

export const API_FILE = new URL('../openapi/placecard-v1.openapi.json', import.meta.url)
export const loadApiFile = (file = API_FILE) => JSON.parse(readFileSync(file, 'utf8'))

const json = (text) => { try { return JSON.parse(text) } catch { return undefined } }
const sameKeys = (a, b) => a && b && typeof a === 'object' && typeof b === 'object'
  && JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort())

export async function startMock(options = {}) {
  const doc = options.doc || loadApiFile(options.apiFile)
  const ops = listOperations(doc).map((o) => ({ ...o, re: new RegExp(`^${o.path.replace(/\{(\w+)\}/g, '(?<$1>[^/]+)')}$`) }))
  const errorSchema = doc.components.schemas.Error
  const requests = []
  const queued = []
  const kept = new Map()

  function errorBody(path, status, code, fix, field) {
    const body = { url: path, statusCode: status, statusMessage: STATUS_CODES[status] || 'Error', message: fix || STATUS_CODES[status] || 'Error' }
    if (code) body.data = { code, ...(field ? { field } : {}), fix: fix || 'See the API reference.' }
    return body
  }

  function answer(res, path, status, body, headers = {}, schema = null) {
    const problems = schema ? validate(schema, body, doc) : []
    if (problems.length) {
      status = 500
      body = { url: path, statusCode: 500, statusMessage: 'Mock answer does not fit the API file', message: JSON.stringify(problems.slice(0, 3)) }
    }
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
    return { status, body, headers }
  }

  function exampleFor(o, body) {
    const media = resolve(doc, o.op.responses?.['200'])?.content?.['application/json']
    const examples = media?.examples || {}
    const asked = o.body?.content?.['application/json']?.examples || {}
    const name = Object.keys(asked).find((n) => sameKeys(resolve(doc, asked[n])?.value, body))
    const pick = (name && examples[name]) || Object.values(examples)[0]
    return { schema: media?.schema, value: structuredClone(resolve(doc, pick)?.value ?? {}) }
  }

  function okHeaders(o) {
    const out = {}
    for (const [name, h] of Object.entries(resolve(doc, o.op.responses?.['200'])?.headers || {})) {
      const schema = resolve(doc, h)?.schema
      if (name !== 'Idempotent-Replayed' && schema && 'const' in schema) out[name] = String(schema.const)
    }
    return out
  }

  async function handle(req, res) {
    const u = new URL(req.url, 'http://mock.invalid')
    const chunks = []
    for await (const c of req) chunks.push(c)
    const text = Buffer.concat(chunks).toString('utf8')
    const path = u.pathname.startsWith('/v1/') ? u.pathname.slice(3) : u.pathname
    const fail = (status, code, fix, field, headers) => answer(res, path, status, errorBody(path, status, code, fix, field), headers, errorSchema)

    let o = null
    let params = {}
    for (const each of ops) {
      const m = each.method === req.method && each.re.exec(path)
      if (m) { o = each; params = m.groups || {}; break }
    }
    const record = { operationId: o?.id ?? null, method: req.method, path, query: u.searchParams, headers: req.headers, body: text ? json(text) ?? text : undefined }
    requests.push(record)
    if (!o) return fail(404, null, `No ${req.method} ${path} in the API file.`)

    if (queued.length) {
      const next = queued.shift()
      const body = next.body ?? errorBody(path, next.status, next.code, next.fix, next.field)
      return answer(res, path, next.status, body, next.headers, next.status >= 400 ? errorSchema : null)
    }

    if (o.security.length) {
      const key = req.headers['x-pincast-key']
      const older = req.headers['x-placecard-key']
      if (key && older && key !== older) return fail(400, 'key_conflict', 'Send one key header, X-Pincast-Key.')
      if (!key && !older) return fail(401, 'key_missing', 'Send your app key in the X-Pincast-Key header.')
      if (options.key && (key || older) !== options.key) return fail(403, 'key_invalid', 'Send a key your app holds, from your dashboard.')
    }
    for (const p of o.params.filter((x) => x.in === 'path')) {
      if (validate(p.schema, decodeURIComponent(params[p.name] ?? ''), doc).length) {
        return fail(400, p.name === 'set' ? 'set_id_invalid' : 'field_invalid', `Send a ${p.name} that fits the API file.`, p.name)
      }
    }
    for (const p of o.params.filter((x) => x.in === 'query')) {
      const values = u.searchParams.getAll(p.name)
      if (p.required && !values.length) return fail(400, 'field_required', `Send ${p.name} in the query string.`, p.name)
      const value = p.schema?.type === 'array' ? values : values[0]
      if (values.length && validate(p.schema, value, doc).length) return fail(400, 'field_invalid', `Send a ${p.name} that fits the API file.`, p.name)
    }
    const idem = req.headers['idempotency-key']
    const idemParam = o.params.find((x) => x.in === 'header' && x.name === 'Idempotency-Key')
    if (idem !== undefined && idemParam && validate(idemParam.schema, idem, doc).length) {
      return fail(400, 'idempotency_key_invalid', 'Send an Idempotency-Key of 1 to 255 printable characters.', 'Idempotency-Key')
    }

    let body
    if (o.body) {
      body = text ? json(text) : undefined
      if (text && body === undefined) return fail(400, 'body_not_json', 'Send the body as JSON.')
      if (body === undefined && o.body.required) return fail(400, 'body_not_json', 'Send a JSON body.')
      if (body !== undefined) {
        const problems = validate(o.body.content['application/json'].schema, body, doc)
        if (problems.length) {
          const p = problems.find((x) => x.keyword === 'required') || problems[0]
          return fail(400, p.keyword === 'required' ? 'field_required' : 'field_invalid', `Send ${p.path || 'the body'} so it fits the API file: it ${p.message}.`, p.path || undefined)
        }
      }
    }

    const keptKey = idem !== undefined && idemParam ? `${req.headers['x-pincast-key'] || req.headers['x-placecard-key']}|${idem}` : null
    if (keptKey && kept.has(keptKey)) {
      const prior = kept.get(keptKey)
      if (prior.text !== text) return fail(422, 'idempotency_key_reused', 'Send a new Idempotency-Key for a new body.', 'Idempotency-Key')
      return answer(res, path, 200, prior.body, { ...prior.headers, 'Idempotent-Replayed': 'true' })
    }
    const ex = exampleFor(o, body)
    const given = answer(res, path, 200, ex.value, okHeaders(o), ex.schema)
    if (keptKey && given.status === 200) kept.set(keptKey, { text, body: given.body, headers: given.headers })
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ url: req.url, statusCode: 500, statusMessage: 'Mock error', message: String(error?.message || error) }))
    })
  })
  await new Promise((done) => server.listen(options.port || 0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${server.address().port}/v1`

  return {
    url,
    doc,
    requests,
    operations: ops.map((o) => o.id),
    // The next calls get these answers instead, in order: { status, code, fix, field, headers, body }.
    answerNext(...answers) { queued.push(...answers) },
    reset() { requests.length = 0; queued.length = 0; kept.clear() },
    close() {
      return new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()) })
    },
  }
}
