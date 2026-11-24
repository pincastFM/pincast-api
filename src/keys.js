// Keys and test people. A key reads pck_, the app id, an underscore, then its secret. A newer key's
// secret starts sk_ (secret) or rk_ (restricted); an older key has no mark and works as a secret key.
// A test app's id is test- and 10 base32 letters. A test person's id starts test_.
export const TEST_APP_ID_RE = /^test-[a-z2-7]{10}$/
export const TEST_PERSON_RE = /^test_[a-z0-9_-]{1,64}$/
const KEY_RE = /^pck_([a-z0-9-]{1,64})_([A-Za-z0-9_-]{20,})$/
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

// What a key is, without its secret: { app, kind: 'secret' | 'restricted', test }. Null when the
// string doesn't read as a Pincast key.
export function keyInfo(key) {
  const m = typeof key === 'string' ? KEY_RE.exec(key) : null
  if (!m) return null
  return Object.freeze({ app: m[1], kind: m[2].startsWith('rk_') ? 'restricted' : 'secret', test: TEST_APP_ID_RE.test(m[1]) })
}

export const isTestKey = (key) => keyInfo(key)?.test === true
export const isTestPerson = (id) => typeof id === 'string' && TEST_PERSON_RE.test(id)

// A test person's id. testPerson('Ana Lee') is test_ana-lee; testPerson() is a new random one,
// such as test_k3f7x2m4qa. An id that already starts test_ comes back as it is.
export function testPerson(name) {
  if (name == null) {
    let out = 'test_'
    for (const b of globalThis.crypto.getRandomValues(new Uint8Array(10))) out += BASE32[b & 31]
    return out
  }
  if (isTestPerson(name)) return name
  const slug = String(name).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/^test_/, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  if (!slug) throw new TypeError(`testPerson: "${name}" has no letters or digits to make an id from`)
  return `test_${slug}`
}

// An actor for a collect or a read under a test key: { id: 'test_...', source }. Test people need
// no sign-in link, so the source can be either; it defaults to anonymous.
export function testActor(name, source = 'anonymous') {
  return { id: testPerson(name), source }
}
