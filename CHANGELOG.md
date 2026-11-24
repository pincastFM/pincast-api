# Changelog

Every release of `@pincast/api`, newest first. The README's Versions section says what a patch, a minor and a major mean for this package. npm keeps the date of each release.

## 0.1.0

The first release, built from the Placecard registry's API file, version 1.0.0.

### Added

- A client with one method for each of the API file's 8 calls: `putSet`, `getSet`, `postCollect`, `getCollects`, `postClaim`, `postPerson`, `getApps` and `postTestApp`.
- Types generated from the API file. The file itself ships in the package as `@pincast/api/openapi.json`.
- An `Idempotency-Key` on each of the three writes, kept across the client's own retries.
- Waits on `Retry-After` for `rate_limited`, `quota_exceeded` and `signin_check_unavailable`, up to 60 seconds at a time unless you set `maxRetryWait`.
- `PincastError`, which carries the status, code, field, fix and kind of each refusal.
- A refusal to run in a web page with any key.
- Test person helpers: `testPerson`, `testActor`, `isTestPerson`, `isTestKey` and `keyInfo`.
- `@pincast/api/resend-queue`, an optional queue that keeps each collect until Placecard has it.
- `@pincast/api/mock`, a local registry built from the API file, for your own tests.
