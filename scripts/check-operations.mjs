#!/usr/bin/env node
// Fails when the API file has an operation the client lacks, or the client has one the file doesn't.
// For each operation in the file it needs: an entry in src/generated/operations.js with the same
// method and path, a method of that name on the Pincast class, and a declaration in src/index.d.ts.
// It also fails when the generated files are stale against the file.
//
//   node scripts/check-operations.mjs [path to an API file]   (defaults to the package's copy)
import { readFileSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import { API_FILE, ROOT, staleOutputs } from './generate.mjs'
import { listOperations } from '../src/openapi.js'
import { operations } from '../src/generated/operations.js'
import { Pincast } from '../src/client.js'

export function checkOperations(file = API_FILE) {
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  const declared = readFileSync(join(ROOT, 'src', 'index.d.ts'), 'utf8')
  const inFile = listOperations(doc)
  const problems = []
  for (const o of inFile) {
    const where = `${o.id} (${o.method} ${o.path})`
    if (!o.id) { problems.push(`${o.method} ${o.path} has no operationId`); continue }
    const entry = operations[o.id]
    if (!entry) problems.push(`${where} is in the API file but not in src/generated/operations.js: run npm run generate`)
    else if (entry.method !== o.method || entry.path !== o.path) problems.push(`${where}: src/generated/operations.js has ${entry.method} ${entry.path}`)
    if (typeof Pincast.prototype[o.id] !== 'function') problems.push(`${where} is in the API file but the client has no ${o.id}() method`)
    if (!new RegExp(`^\\s*${o.id}\\(`, 'm').test(declared)) problems.push(`${where} is in the API file but src/index.d.ts declares no ${o.id}()`)
  }
  const ids = new Set(inFile.map((o) => o.id))
  for (const id of Object.keys(operations)) {
    if (!ids.has(id)) problems.push(`${id} is in the client but not in the API file`)
  }
  for (const rel of staleOutputs(file)) problems.push(`${rel} is stale against the API file: run npm run generate`)
  return { operations: inFile.length, problems }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const file = process.argv[2] ? resolvePath(process.argv[2]) : API_FILE
  const { operations: n, problems } = checkOperations(file)
  if (problems.length) {
    console.error(`check failed: ${problems.length} problem${problems.length === 1 ? '' : 's'} for ${n} operations in ${file}`)
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
  }
  console.log(`check passed: the client has all ${n} operations in the API file, and the generated files are fresh`)
}
