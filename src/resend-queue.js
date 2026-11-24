// An optional resend queue for collects, after Treehopper's (server/utils/placecard.ts): a collect is
// kept before it is sent, so a visit never waits on Placecard and none is lost when Placecard is
// down, busy or the key is wrong. Each kept collect is sent with its own Idempotency-Key, made once
// when it is kept, so sending it again never records it twice and the body never changes under it.
//
// After a send, the queue tries up to `batch` other unsent collects, newest first, and stops at the
// first failure that is not that collect's own fault (PincastError.kind):
//   key      the key is missing or refused: the collect stays unsent, the batch stops
//   later    no answer, a 429 past the wait, a 5xx, or set_not_registered: stays unsent, the batch stops
//   waiting  person_not_signed_in: kept aside until release(person) after you link them with postPerson
//   refused  any other 4xx: kept with its error and never sent again
//
// The store holds the collects. MemoryStore keeps them in this process; for a server that restarts or
// runs on many instances, write a store on your database with the same five methods.
import { PincastError } from './errors.js'

export class MemoryStore {
  #items = new Map()
  #next = 1

  async add(item) {
    const id = this.#next++
    this.#items.set(id, { ...item, id })
    return id
  }

  async get(id) { return this.#items.get(id) ?? null }

  async update(id, patch) {
    const item = this.#items.get(id)
    if (item) this.#items.set(id, { ...item, ...patch })
  }

  // Unsent collects, newest first. person: only theirs. before: only those kept before this time (ms).
  async unsent({ limit, person = null, before = null, except = null }) {
    return [...this.#items.values()]
      .filter((i) => i.state === 'unsent' && i.id !== except && (person == null || i.person === person) && (before == null || i.keptAt < before))
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
  }

  // Waiting collects for this person become unsent again. Returns how many.
  async releaseWaiting(person) {
    let n = 0
    for (const item of this.#items.values()) {
      if (item.state === 'waiting' && item.person === person) { item.state = 'unsent'; item.error = null; n++ }
    }
    return n
  }
}

const errorOf = (e) => ({ status: e.status ?? null, code: e.code ?? null, field: e.field ?? null, fix: e.fix ?? null, message: String(e.message).slice(0, 500) })

export class ResendQueue {
  #client
  #store
  #batch
  #settleMs
  #now

  // settleMs: a collect kept this recently may still be on its way from another request, so a
  // resend without a person leaves it alone. Defaults to two minutes, as Treehopper's.
  constructor(client, { store = new MemoryStore(), batch = 20, settleMs = 120_000, now = Date.now } = {}) {
    this.#client = client
    this.#store = store
    this.#batch = batch
    this.#settleMs = settleMs
    this.#now = now
  }

  get store() { return this.#store }

  // Keep a collect, send it, then send up to `batch` others. Never throws for a send:
  // returns { id, result, resent } where result is 'sent', 'waiting', 'refused' or 'unsent'.
  async collect(set, body) {
    const id = await this.#store.add({
      set, body, person: body?.actor?.id ?? null, idempotencyKey: globalThis.crypto.randomUUID(),
      keptAt: this.#now(), state: 'unsent', error: null, sentAt: null, answer: null,
    })
    const result = await this.#send(await this.#store.get(id))
    const resent = result === 'unsent' ? null : await this.resend({ except: id })
    return { id, result, resent }
  }

  // Send up to `limit` unsent collects, newest first, stopping at the first that fails for a reason
  // not its own. With a person: only theirs, and with no settle wait. Returns the counts.
  async resend({ limit = this.#batch, person = null, except = null } = {}) {
    const before = person == null ? this.#now() - this.#settleMs : null
    const items = await this.#store.unsent({ limit, person, before, except })
    const counts = { tried: 0, sent: 0, waiting: 0, refused: 0, stopped: null }
    for (const item of items) {
      counts.tried++
      const result = await this.#send(item)
      if (result === 'unsent') { counts.stopped = item.error?.code || `status ${item.error?.status ?? 'none'}`; break }
      counts[result]++
    }
    return counts
  }

  // After postPerson links a person: their waiting collects go out again.
  async release(person) {
    const released = await this.#store.releaseWaiting(person)
    const resent = released ? await this.resend({ person }) : null
    return { released, resent }
  }

  async #send(item) {
    try {
      const answer = await this.#client.postCollect(item.set, item.body, { idempotencyKey: item.idempotencyKey })
      await this.#store.update(item.id, { state: 'sent', sentAt: this.#now(), error: null, answer })
      return 'sent'
    } catch (error) {
      const kind = error instanceof PincastError ? error.kind : 'later'
      if (kind === 'waiting' || kind === 'refused') {
        await this.#store.update(item.id, { state: kind, error: errorOf(error) })
        return kind
      }
      await this.#store.update(item.id, { error: errorOf(error) })
      return 'unsent'
    }
  }
}
