import type { CollectRequest, CollectResponse, SetId } from './generated/types.js'
import type { Pincast } from './index.js'

export type QueueState = 'unsent' | 'sent' | 'waiting' | 'refused'

export interface QueueItem {
  id: number | string
  set: SetId
  body: CollectRequest
  person: string | null
  idempotencyKey: string
  keptAt: number
  state: QueueState
  error: { status: number | null, code: string | null, field: string | null, fix: string | null, message: string } | null
  sentAt: number | null
  answer: CollectResponse | null
}

/** Where the queue keeps collects. Write one on your database with these five methods. */
export interface QueueStore {
  add(item: Omit<QueueItem, 'id'>): Promise<QueueItem['id']>
  get(id: QueueItem['id']): Promise<QueueItem | null>
  update(id: QueueItem['id'], patch: Partial<QueueItem>): Promise<void>
  unsent(query: { limit: number, person?: string | null, before?: number | null, except?: QueueItem['id'] | null }): Promise<QueueItem[]>
  releaseWaiting(person: string): Promise<number>
}

export declare class MemoryStore implements QueueStore {
  add(item: Omit<QueueItem, 'id'>): Promise<number>
  get(id: QueueItem['id']): Promise<QueueItem | null>
  update(id: QueueItem['id'], patch: Partial<QueueItem>): Promise<void>
  unsent(query: { limit: number, person?: string | null, before?: number | null, except?: QueueItem['id'] | null }): Promise<QueueItem[]>
  releaseWaiting(person: string): Promise<number>
}

export interface ResendCounts {
  tried: number
  sent: number
  waiting: number
  refused: number
  /** The code or status that stopped the batch, or null when it ran to the end. */
  stopped: string | null
}

export interface ResendQueueOptions {
  store?: QueueStore
  /** How many other unsent collects to try after each send. Defaults to 20. */
  batch?: number
  /** A collect kept this recently is left alone by a resend without a person. Defaults to 120000 ms. */
  settleMs?: number
  now?: () => number
}

export declare class ResendQueue {
  constructor(client: Pincast, options?: ResendQueueOptions)
  readonly store: QueueStore
  collect(set: SetId, body: CollectRequest): Promise<{ id: QueueItem['id'], result: 'sent' | 'waiting' | 'refused' | 'unsent', resent: ResendCounts | null }>
  resend(options?: { limit?: number, person?: string | null, except?: QueueItem['id'] | null }): Promise<ResendCounts>
  release(person: string): Promise<{ released: number, resent: ResendCounts | null }>
}
