// The check that ties the client to the API file: it passes on the package's copy, and it fails,
// naming the operation, when the file gains an operation the client lacks or loses one it has.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkOperations } from '../scripts/check-operations.mjs'
import { staleOutputs } from '../scripts/generate.mjs'
import { loadApiFile, startMock } from '../src/mock.js'

const SCRIPT = fileURLToPath(new URL('../scripts/check-operations.mjs', import.meta.url))

function withFile(change, run) {
  const dir = mkdtempSync(join(tmpdir(), 'pincast-api-check-'))
  try {
    const doc = loadApiFile()
    change(doc)
    const file = join(dir, 'placecard-v1.openapi.json')
    writeFileSync(file, JSON.stringify(doc, null, 2))
    return run(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// An operation the client lacks, shaped like the file's own.
const plant = (doc) => {
  doc.paths['/sets/{set}/stats'] = {
    parameters: [{ $ref: '#/components/parameters/Set' }],
    get: {
      operationId: 'getSetStats',
      summary: 'Read a set\'s numbers',
      security: [{ pincastKey: [] }],
      responses: { 200: { description: 'The numbers', content: { 'application/json': { schema: { type: 'object' } } } } },
    },
  }
}

test('the generated files match the API file', () => {
  assert.deepEqual(staleOutputs(), [])
})

test('the check passes on the package\'s API file: 8 operations, no problems', () => {
  assert.deepEqual(checkOperations(), { operations: 8, problems: [] })
})

test('the check fails when the API file gains an operation the client lacks', () => {
  withFile(plant, (file) => {
    const { operations, problems } = checkOperations(file)
    assert.equal(operations, 9)
    const named = problems.filter((p) => p.includes('getSetStats'))
    assert.equal(named.length, 3, problems.join('\n'))
    assert.ok(named.some((p) => p.includes('not in src/generated/operations.js')))
    assert.ok(named.some((p) => p.includes('the client has no getSetStats() method')))
    assert.ok(named.some((p) => p.includes('src/index.d.ts declares no getSetStats()')))
    const run = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' })
    assert.equal(run.status, 1)
    assert.match(run.stderr, /getSetStats \(GET \/sets\/\{set\}\/stats\) is in the API file but the client has no getSetStats\(\) method/)
  })
})

test('the check fails when an operation leaves the API file', () => {
  withFile((doc) => { delete doc.paths['/apps'] }, (file) => {
    const { problems } = checkOperations(file)
    assert.ok(problems.includes('getApps is in the client but not in the API file'), problems.join('\n'))
  })
})

test('the mock takes each operation in the file and nothing else', async () => {
  const mock = await startMock()
  try {
    const res = await fetch(`${mock.url}/sets/central-park-trees/stats`)
    assert.equal(res.status, 404)
  } finally {
    await mock.close()
  }
  const planted = await withFile(plant, (file) => startMock({ apiFile: file }))
  try {
    assert.ok(planted.operations.includes('getSetStats'), 'a mock built from a changed file serves the new operation')
  } finally {
    await planted.close()
  }
})
