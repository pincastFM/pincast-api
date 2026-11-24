// The client: one method per operation in the API file, named by its operationId. Each call sends
// the key in X-Pincast-Key when the operation takes one, puts an Idempotency-Key on the three writes
// (the same key on every retry of that call), waits out a 429 or 503 that says how long to wait,
// and raises a PincastError carrying code, field and fix.
import { PincastError } from './errors.js'
import { operations } from './generated/operations.js'
import { keyInfo } from './keys.js'

export const DEFAULT_BASE_URL = 'https://api.pincast.fm/v1'
export const KEY_HEADER = 'X-Pincast-Key'

const inBrowser = () => typeof globalThis.window !== 'undefined' && typeof globalThis.document !== 'undefined'

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const onAbort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// Retry-After in seconds: a number of seconds, or an HTTP date. Null when absent or unreadable.
export function retryAfterSeconds(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  if (Number.isFinite(n) && n >= 0) return n
  const when = Date.parse(value)
  return Number.isFinite(when) ? Math.max(0, Math.ceil((when - Date.now()) / 1000)) : null
}

function refusal(operation, where, res, data) {
  const d = data && typeof data === 'object' && data.data && typeof data.data === 'object' ? data.data : {}
  const code = typeof d.code === 'string' ? d.code : null
  const field = typeof d.field === 'string' ? d.field : null
  const fix = typeof d.fix === 'string' ? d.fix : null
  const said = code
    ? `${code}${field ? ` (${field})` : ''}${fix ? `: ${fix}` : ''}`
    : (typeof data?.message === 'string' && data.message) || res.statusText || 'no detail'
  return new PincastError({
    status: res.status, code, field, fix, operation, body: data,
    retryAfter: retryAfterSeconds(res.headers.get('retry-after')),
    message: `${where}: ${res.status} ${said}`,
  })
}

export class Pincast {
  #key
  #baseUrl
  #fetch
  #timeoutMs
  #retries
  #maxRetryWait
  #sleep

  constructor(options = {}) {
    const key = options.key !== undefined ? options.key : globalThis.process?.env?.PINCAST_KEY
    if (key != null && typeof key !== 'string') throw new TypeError('key must be a string')
    if (key && inBrowser()) {
      throw new PincastError({
        code: 'browser_not_allowed',
        fix: 'Call Pincast from your server and keep the key there.',
        message: 'No key can be used in a web page, where anyone who opens the page can read it. Call Pincast from your server and keep the key there.',
      })
    }
    this.#key = key || null
    this.#baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.#fetch = options.fetch || globalThis.fetch
    if (typeof this.#fetch !== 'function') throw new TypeError('no fetch here: use Node 20.12 or later, or pass options.fetch')
    this.#timeoutMs = options.timeoutMs ?? 10_000
    this.#retries = options.retries ?? 2
    this.#maxRetryWait = options.maxRetryWait ?? 60
    this.#sleep = options.sleep || sleep
  }

  // What the key is (app, kind, test), never the key itself. Null with no key.
  get keyInfo() { return this.#key ? keyInfo(this.#key) : null }
  get baseUrl() { return this.#baseUrl }
  toJSON() { return { baseUrl: this.#baseUrl, keyInfo: this.keyInfo } }
  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `Pincast { baseUrl: '${this.#baseUrl}', key: ${this.#key ? '[hidden]' : 'none'} }`
  }

  putSet(set, body, options) { return this.#call('putSet', { set }, null, body, options) }
  getSet(set, options) { return this.#call('getSet', { set }, null, undefined, options) }
  postCollect(set, body, options) { return this.#call('postCollect', { set }, null, body, options) }
  getCollects(set, query, options) { return this.#call('getCollects', { set }, query, undefined, options) }
  postClaim(set, body, options) { return this.#call('postClaim', { set }, null, body, options) }
  postPerson(body, options) { return this.#call('postPerson', {}, null, body, options) }
  getApps(options) { return this.#call('getApps', {}, null, undefined, options) }
  postTestApp(body, options) { return this.#call('postTestApp', {}, null, body, options) }

  async #call(id, pathValues, query, body, options = {}) {
    const op = operations[id]
    const where = `${id} (${op.method} ${op.path})`
    if (op.key && !this.#key) {
      throw new PincastError({
        operation: id, code: 'key_missing',
        fix: 'Pass key to new Pincast({ key }) or set PINCAST_KEY. postTestApp() makes a test key.',
        message: `${where}: no key. Pass key to new Pincast({ key }) or set PINCAST_KEY. postTestApp() makes a test key.`,
      })
    }
    let path = op.path
    for (const name of op.pathParams) {
      const value = pathValues?.[name]
      if (value == null || value === '') throw new TypeError(`${id}: ${name} is required`)
      path = path.replace(`{${name}}`, encodeURIComponent(String(value)))
    }
    const qs = new URLSearchParams()
    for (const name of op.query) {
      const value = query?.[name]
      if (value == null) continue
      for (const one of Array.isArray(value) ? value : [value]) qs.append(name, String(one))
    }
    const search = qs.toString()
    const url = `${this.#baseUrl}${path}${search ? `?${search}` : ''}`

    const headers = { accept: 'application/json' }
    if (op.key) headers[KEY_HEADER] = this.#key
    if (op.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey || globalThis.crypto.randomUUID()
    let payload
    if (body !== undefined && body !== null && op.body !== 'none') {
      headers['content-type'] = 'application/json'
      payload = JSON.stringify(body)
    } else if (op.body === 'required') {
      throw new TypeError(`${id}: a body is required`)
    }

    for (let attempt = 0; ; attempt++) {
      const signals = [AbortSignal.timeout(options.timeoutMs ?? this.#timeoutMs)]
      if (options.signal) signals.push(options.signal)
      let res
      try {
        res = await this.#fetch(url, { method: op.method, headers, body: payload, signal: AbortSignal.any(signals) })
      } catch (error) {
        if (options.signal?.aborted) throw error
        throw new PincastError({ operation: id, cause: error, message: `${where}: no answer (${error?.message || error})` })
      }
      const text = await res.text().catch(() => '')
      let data = null
      try { data = text ? JSON.parse(text) : null } catch { data = null }
      if (res.ok) {
        if (data === null) throw new PincastError({ status: res.status, operation: id, message: `${where}: ${res.status} with an answer that is not JSON` })
        return data
      }
      const error = refusal(id, where, res, data)
      const waits = (res.status === 429 || res.status === 503) && error.retryAfter != null
      if (waits && error.retryAfter <= this.#maxRetryWait && attempt < this.#retries) {
        await this.#sleep(error.retryAfter * 1000, options.signal)
        continue
      }
      throw error
    }
  }
}
