# @pincast/api

A typed client for the Pincast card registry. Register your app's cards, record what people collect, and read it back, from your server.

It has no dependencies and runs on Node 20.12 or later.

```sh
npm install @pincast/api
```

## Start with a test app

A test app needs no account. `postTestApp()` makes one and answers with its key.

```js
import { Pincast, testActor } from '@pincast/api'

const { key } = await new Pincast().postTestApp({ name: 'Bird log' })
const pincast = new Pincast({ key })

await pincast.putSet('park-birds', {
  name: 'Park birds',
  cards: [{ key: 'bird:robin', type: 'bird', title: 'Robin' }],
})

await pincast.postCollect('park-birds', { card: 'bird:robin', actor: testActor('ana') })

const held = await pincast.getCollects('park-birds', { actor: 'test_ana' })
console.log(held.cards)
```

Keep the key in `PINCAST_KEY`. With no `key` option, the client reads it from there.

## The calls

One method for each call in the API reference, named by its operation id.

| Method | Call |
|:-|:-|
| `putSet(set, body)` | `PUT /sets/{set}`: register a card set, or update it and its cards |
| `getSet(set)` | `GET /sets/{set}`: read a set back |
| `postCollect(set, body)` | `POST /sets/{set}/collects`: record that a person collected a card |
| `getCollects(set, { actor })` | `GET /sets/{set}/collects`: what one to three people hold |
| `postClaim(set, { from, to })` | `POST /sets/{set}/claims`: move a guest's cards to a person who signed in |
| `postPerson({ token })` | `POST /people`: link a person who signed in to your app |
| `getApps()` | `GET /apps`: the public list of apps, no key needed |
| `postTestApp({ name })` | `POST /test-apps`: a test app and its key, no key needed |

Each method takes a last `options` argument: `signal` and `timeoutMs`, and `idempotencyKey` on the three writes.

## Keys stay on your server

The client sends your key in the `X-Pincast-Key` header, and only on the calls that take one. It never puts the key in an address, an error or a log line. `pincast.keyInfo` tells you the app, the kind and whether it is a test key, without the key itself.

In a web page, the client refuses every key, secret or restricted, and throws a `browser_not_allowed` error, because anyone who opens the page could read the key. With no key, it still runs there for the public list of apps, `getApps()`.

## Retries

Every write (`putSet`, `postCollect`, `postClaim`) gets an `Idempotency-Key`. Placecard keeps the first answer to that key for 24 hours, so a call sent twice runs once. Pass your own with `{ idempotencyKey }` when you send the same call again later.

A `429` or `503` that sends `Retry-After` is waited out and sent again, with the same `Idempotency-Key`. That covers both limits: `rate_limited` (your key's calls per minute) and `quota_exceeded` (your app's calls per UTC day). By default the client waits up to 60 seconds at a time and sends a call again at most twice. A longer wait raises the error at once, with the seconds in `error.retryAfter`, so you can send it later.

```js
new Pincast({ key, retries: 2, maxRetryWait: 60 })
```

## Errors

Every failure is a `PincastError`. When Placecard refuses a call, the error carries its answer:

- `status`: the HTTP status, or `null` when no answer came
- `code`: a code to branch on, such as `test_person_required`
- `field`: the field at fault, when there is one
- `fix`: what to do, in one sentence
- `kind`: `key`, `waiting`, `later` or `refused`, for code that keeps calls to send again

```js
try {
  await pincast.postCollect('park-birds', body)
} catch (error) {
  if (error.code === 'person_not_signed_in') {
    // link them with postPerson, then send it again
  }
  console.error(error.message) // postCollect (POST /sets/{set}/collects): 403 person_not_signed_in: ...
}
```

## Test people

A test key writes only for test people, whose ids start `test_`. They need no sign-in.

- `testPerson('Ana Lee')` gives `test_ana-lee`. `testPerson()` gives a new random id.
- `testActor('ana')` gives `{ id: 'test_ana', source: 'anonymous' }`, ready for a collect.
- `isTestPerson(id)` and `isTestKey(key)` check one.

## The resend queue (optional)

A visit should never wait on Placecard, and no collect should be lost when Placecard is busy. The queue keeps each collect before it sends it. Once a collect goes out, the queue tries up to 20 unsent ones, newest first, and stops at the first failure that isn't that collect's fault.

```js
import { ResendQueue } from '@pincast/api/resend-queue'

const queue = new ResendQueue(pincast)
await queue.collect('park-birds', { card: 'bird:robin', actor })

// after postPerson links a person, their waiting collects go out
await queue.release(personId)
```

Each kept collect has its own `Idempotency-Key`, so a resend never records it twice. A refused collect keeps its error and is not sent again. The default store lives in memory. For a server that restarts, write a store on your database with the five methods of `MemoryStore`.

## Testing without Pincast

`@pincast/api/mock` starts a local registry built from the API file. It runs the file's checks, answers with its examples, and records each request.

```js
import { startMock } from '@pincast/api/mock'

const mock = await startMock({ key })
const pincast = new Pincast({ key, baseUrl: mock.url })
mock.answerNext({ status: 429, code: 'rate_limited', fix: 'Wait.', headers: { 'Retry-After': '1' } })
await mock.close()
```

## Types

The types come from the API file (`openapi/placecard-v1.openapi.json`, also at `@pincast/api/openapi.json`). `npm run generate` writes them again. `npm run check` fails when the API file has a call the client lacks.

## Versions

Every release follows one rule. [CHANGELOG.md](CHANGELOG.md) lists what each one changed.

- **Patch** (0.1.0 to 0.1.1): a fix, or a change your code can't see. The API file is the same, or only its text and examples changed.
- **Minor** (0.1.1 to 0.2.0): something new, and everything that worked still works. An operation added to the API file is a minor. So is a new optional field, error code, option or export.
- **Major** (0.2.0 to 1.0.0, then 2.0.0): something that worked can stop working. An operation, field or export removed is a major. So is a narrowed field: one that's newly required, takes fewer values or a shorter length, or changed its type. So is raising the lowest Node version the package runs on.

The rule holds below 1.0.0 too, so the first breaking change makes 1.0.0. While the version starts with 0, a range like `^0.1.0` takes patches only, so raise it to take a minor.

## License

MIT
