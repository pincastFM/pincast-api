// The one error the client raises. When Placecard refuses a call, the error carries the answer's
// status and its data: a code to branch on, the field at fault when there is one, and a fix in
// one sentence. When no answer came, status is null and cause holds what went wrong.
export class PincastError extends Error {
  constructor({ message, status = null, code = null, field = null, fix = null, retryAfter = null, operation = null, body = null, cause } = {}) {
    super(message || fix || code || 'Pincast call failed', cause === undefined ? undefined : { cause })
    this.name = 'PincastError'
    this.status = status
    this.code = code
    this.field = field
    this.fix = fix
    this.retryAfter = retryAfter
    this.operation = operation
    this.body = body
  }

  // What the refusal means for a call you keep and send again (the resend queue reads this):
  //   key      a 401, a 403 other than person_not_signed_in, or no key here: fix the key, then send it again
  //   waiting  403 person_not_signed_in: link the person with postPerson, then send it again
  //   later    no answer, 408, 429, a 5xx, or 404 set_not_registered (put the set again): send it again later
  //   refused  any other 4xx: this call will not go through as it is
  get kind() {
    const s = this.status
    if (s == null) return this.code === 'browser_not_allowed' || this.code?.startsWith('key_') ? 'key' : 'later'
    if (s === 408 || s === 429 || s >= 500 || s < 400) return 'later'
    if (s === 404 && this.code === 'set_not_registered') return 'later'
    if (s === 401) return 'key'
    if (s === 403) return this.code === 'person_not_signed_in' ? 'waiting' : 'key'
    return 'refused'
  }
}
