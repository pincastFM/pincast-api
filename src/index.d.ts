// Types for @pincast/api. The API's own types are generated from the API file into
// ./generated/types.d.ts; this file declares the client around them.
import type {
  AppsResponse, ClaimRequest, ClaimResponse, CollectRequest, CollectResponse, CollectsResponse, ErrorCode,
  OperationId, Operations, PersonRequest, PersonResponse, PutSetRequest, PutSetResponse, SetId, SetResponse,
  TestAppRequest, TestAppResponse,
} from './generated/types.js'

export type * from './generated/types.js'

export interface PincastOptions {
  /** Your app's key. Defaults to process.env.PINCAST_KEY. getApps and postTestApp need none. */
  key?: string | null
  /** Defaults to https://api.pincast.fm/v1. */
  baseUrl?: string
  /** Defaults to the global fetch. */
  fetch?: typeof fetch
  /** Milliseconds to wait for each answer. Defaults to 10000. */
  timeoutMs?: number
  /** How many times one call waits out a 429 or 503 and sends again. Defaults to 2. */
  retries?: number
  /** The longest Retry-After, in seconds, the client waits out itself. Longer ones raise at once. Defaults to 60. */
  maxRetryWait?: number
  /** How the client waits. For tests; defaults to a timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export interface CallOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export interface WriteOptions extends CallOptions {
  /** Your own Idempotency-Key. Without one the client makes a new one for each call. */
  idempotencyKey?: string
}

export interface KeyInfo {
  app: string
  kind: 'secret' | 'restricted'
  test: boolean
}

export type ErrorKind = 'key' | 'waiting' | 'later' | 'refused'

export declare class PincastError extends Error {
  readonly name: 'PincastError'
  /** The answer's status, or null when no answer came or the client refused before sending. */
  readonly status: number | null
  readonly code: ErrorCode | null
  readonly field: string | null
  readonly fix: string | null
  /** Seconds from the answer's Retry-After header, when it sent one. */
  readonly retryAfter: number | null
  readonly operation: OperationId | null
  /** The answer's JSON body, when there was one. */
  readonly body: unknown
  /** What the refusal means for a call you keep and send again. */
  readonly kind: ErrorKind
}

export declare const DEFAULT_BASE_URL: 'https://api.pincast.fm/v1'
export declare const KEY_HEADER: 'X-Pincast-Key'
export declare function retryAfterSeconds(value: string | null | undefined): number | null

export declare class Pincast {
  constructor(options?: PincastOptions)
  readonly keyInfo: KeyInfo | null
  readonly baseUrl: string
  /** PUT /sets/{set}: register a card set, or update it and its cards. */
  putSet(set: SetId, body: PutSetRequest, options?: WriteOptions): Promise<PutSetResponse>
  /** GET /sets/{set}: read a set back. */
  getSet(set: SetId, options?: CallOptions): Promise<SetResponse>
  /** POST /sets/{set}/collects: record that a person collected a card. */
  postCollect(set: SetId, body: CollectRequest, options?: WriteOptions): Promise<CollectResponse>
  /** GET /sets/{set}/collects: read what a person holds in this set (one to three actor ids). */
  getCollects(set: SetId, query: { actor: string | string[] }, options?: CallOptions): Promise<CollectsResponse>
  /** POST /sets/{set}/claims: move a guest's cards to the person who just signed in. */
  postClaim(set: SetId, body: ClaimRequest, options?: WriteOptions): Promise<ClaimResponse>
  /** POST /people: link a person who signed in to your app, or a test person under a test key. */
  postPerson(body: PersonRequest, options?: CallOptions): Promise<PersonResponse>
  /** GET /apps: the public list of apps on Pincast. Needs no key. */
  getApps(options?: CallOptions): Promise<AppsResponse>
  /** POST /test-apps: make a test app and its key. Needs no key or account. */
  postTestApp(body?: TestAppRequest, options?: CallOptions): Promise<TestAppResponse>
}

export declare function keyInfo(key: string): KeyInfo | null
export declare function isTestKey(key: string): boolean
export declare function isTestPerson(id: string): boolean
export declare function testPerson(name?: string): string
export declare function testActor(name?: string, source?: 'anonymous' | 'logto'): { id: string, source: 'anonymous' | 'logto' }
export declare const TEST_APP_ID_RE: RegExp
export declare const TEST_PERSON_RE: RegExp

export declare const operations: {
  readonly [K in OperationId]: {
    readonly method: Operations[K]['method']
    readonly path: Operations[K]['path']
    readonly pathParams: readonly string[]
    readonly query: readonly string[]
    readonly body: 'required' | 'optional' | 'none'
    readonly key: Operations[K]['key']
    readonly idempotencyKey: Operations[K]['idempotencyKey']
  }
}
export declare const apiFile: { readonly title: string, readonly version: string, readonly sha256: string }
export declare const errorCodes: readonly ErrorCode[]
export declare const servers: readonly string[]
