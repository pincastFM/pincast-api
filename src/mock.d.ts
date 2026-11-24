import type { IncomingHttpHeaders } from 'node:http'
import type { OperationId } from './generated/types.js'

export interface MockRequest {
  operationId: OperationId | null
  method: string
  path: string
  query: URLSearchParams
  headers: IncomingHttpHeaders
  body: unknown
}

export interface MockAnswer {
  status: number
  code?: string
  fix?: string
  field?: string
  headers?: Record<string, string>
  body?: unknown
}

export interface Mock {
  /** The base address to give the client, such as http://127.0.0.1:41234/v1. */
  url: string
  doc: unknown
  requests: MockRequest[]
  operations: OperationId[]
  /** The next calls get these answers instead, in order. */
  answerNext(...answers: MockAnswer[]): void
  reset(): void
  close(): Promise<void>
}

export interface MockOptions {
  /** When set, a call with any other key answers 403 key_invalid. */
  key?: string
  port?: number
  /** Another copy of the API file to build from. */
  apiFile?: string | URL
  doc?: unknown
}

export declare const API_FILE: URL
export declare function loadApiFile(file?: string | URL): unknown
export declare function startMock(options?: MockOptions): Promise<Mock>
