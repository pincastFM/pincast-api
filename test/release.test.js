// The release scripts: the API file sync against a stand-in NYID, and the changelog's entry and version.
// Every git repo here is a new one in a temp folder; nothing reads the network or the real NYID.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiChanges, bump, classify, hasEntry } from '../scripts/changelog.mjs'
import { loadApiFile } from '../src/mock.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const API = 'openapi/placecard-v1.openapi.json'
const NYID_FILE = 'docs/api/placecard-v1.openapi.json'
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...a], { cwd, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString()

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pincast-api-release-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// A copy of the package's parts a script needs, so a run never writes the real files.
function packageCopy(dir, files) {
  const pkg = join(dir, 'pincast-api')
  for (const f of files) {
    mkdirSync(join(pkg, f, '..'), { recursive: true })
    cpSync(join(ROOT, f), join(pkg, f))
  }
  return pkg
}

// A stand-in NYID beside the package: one commit holding the API file, and origin/main on it.
function standInNyid(dir, text) {
  const nyid = join(dir, 'NYID')
  mkdirSync(join(nyid, 'docs', 'api'), { recursive: true })
  git(nyid, 'init', '-q', '-b', 'main')
  if (text !== undefined) writeFileSync(join(nyid, NYID_FILE), text)
  else writeFileSync(join(nyid, 'README'), 'no API file here\n')
  git(nyid, 'add', '-A')
  git(nyid, 'commit', '-q', '-m', 'start')
  git(nyid, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  return nyid
}

function sync(pkg, env = {}, ...args) {
  const r = spawnSync(process.execPath, [join(pkg, 'scripts', 'sync-openapi.mjs'), ...args], {
    env: { ...GIT_ENV, NYID_REPO: '', NO_FETCH: '1', ...env }, encoding: 'utf8',
  })
  return { code: r.status, out: r.stdout + r.stderr }
}

const SYNC_FILES = ['package.json', 'scripts/sync-openapi.mjs', 'src/openapi.js', API]

test('sync: exit 0 when the copy matches NYID origin/main', (t) => {
  const dir = tempDir(t)
  const pkg = packageCopy(dir, SYNC_FILES)
  standInNyid(dir, readFileSync(join(ROOT, API), 'utf8'))
  const r = sync(pkg)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /OK: openapi\/placecard-v1\.openapi\.json matches NYID origin\/main/)
})

test('sync: exit 1 on a change in NYID, copies it, and names the next steps', (t) => {
  const dir = tempDir(t)
  const pkg = packageCopy(dir, SYNC_FILES)
  const doc = loadApiFile()
  doc.paths['/sets/{set}/stats'] = { get: { operationId: 'getSetStats', responses: { 200: { description: 'ok' } } } }
  const changed = JSON.stringify(doc, null, 2) + '\n'
  standInNyid(dir, changed)

  const check = sync(pkg, {}, '--check')
  assert.equal(check.code, 1, check.out)
  assert.match(check.out, /operation added in NYID: GET \/sets\/\{set\}\/stats \(getSetStats\)/)
  assert.equal(readFileSync(join(pkg, API), 'utf8'), readFileSync(join(ROOT, API), 'utf8'), '--check changes nothing')

  const r = sync(pkg)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /CHANGED/)
  assert.match(r.out, /npm run generate/)
  assert.match(r.out, /npm run check/)
  assert.equal(readFileSync(join(pkg, API), 'utf8'), changed, 'the copy now matches NYID')
  assert.equal(sync(pkg).code, 0, 'a second run finds them equal')
})

test('sync: exit 1 on a change in the package\'s copy, and NYID is only read', (t) => {
  const dir = tempDir(t)
  const pkg = packageCopy(dir, SYNC_FILES)
  const nyid = standInNyid(dir, readFileSync(join(ROOT, API), 'utf8'))
  const head = git(nyid, 'rev-parse', 'HEAD')
  writeFileSync(join(pkg, API), readFileSync(join(pkg, API), 'utf8').replace('Placecard registry', 'Placecard registry (edited)'))
  const r = sync(pkg)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /the same 8 operations/)
  assert.equal(readFileSync(join(pkg, API), 'utf8'), readFileSync(join(ROOT, API), 'utf8'))
  assert.equal(git(nyid, 'rev-parse', 'HEAD'), head)
  assert.equal(git(nyid, 'status', '--porcelain'), '')
})

test('sync: exit 2 when NYID or its file cannot be read', (t) => {
  const dir = tempDir(t)
  const pkg = packageCopy(dir, SYNC_FILES)
  const missing = sync(pkg, { NYID_REPO: join(dir, 'no-such-NYID') })
  assert.equal(missing.code, 2, missing.out)
  assert.match(missing.out, /NYID repo not found/)

  const nyid = standInNyid(dir)
  const noFile = sync(pkg)
  assert.equal(noFile.code, 2, noFile.out)
  assert.match(noFile.out, /could not read docs\/api\/placecard-v1\.openapi\.json/)

  git(nyid, 'update-ref', '-d', 'refs/remotes/origin/main')
  const noMain = sync(pkg)
  assert.equal(noMain.code, 2, noMain.out)
  assert.match(noMain.out, /has no origin\/main/)

  // With no remote named origin, the fetch fails at once, without the network.
  const noFetch = sync(pkg, { NO_FETCH: '' })
  assert.equal(noFetch.code, 2, noFetch.out)
  assert.match(noFetch.out, /git fetch of origin main failed/)

  assert.equal(sync(pkg, {}, '--write').code, 2, 'an unknown option')
})

test('changelog: subjects to groups', () => {
  assert.deepEqual(classify('feat: getSetStats()'), { group: 'Added', text: 'getSetStats()' })
  assert.deepEqual(classify('add: a timeout option'), { group: 'Added', text: 'A timeout option' })
  assert.deepEqual(classify('fix(client): wait out Retry-After once more'), { group: 'Fixed', text: 'Wait out Retry-After once more' })
  assert.deepEqual(classify('feat!: drop postClaim'), { group: 'Breaking', text: 'Drop postClaim' })
  assert.deepEqual(classify('change: longer timeout', 'BREAKING CHANGE: the default is now 30 s'), { group: 'Breaking', text: 'Longer timeout' })
  assert.deepEqual(classify('Make the mock answer 404 for an unknown set'), { group: 'Changed', text: 'Make the mock answer 404 for an unknown set' })
  for (const s of ['docs: README', 'test: more cases', 'ci: Node 24', 'chore: tidy', '@pincast/api 0.1.0: a typed client', 'Release 0.2.0', 'v0.2.0']) {
    assert.equal(classify(s), null, s)
  }
})

test('changelog: the API file decides minor and major', () => {
  const base = loadApiFile()
  const same = apiChanges(base, loadApiFile())
  assert.deepEqual(same, { major: [], minor: [] })

  const added = loadApiFile()
  added.paths['/sets/{set}/stats'] = { get: { operationId: 'getSetStats', responses: {} } }
  assert.deepEqual(apiChanges(base, added).major, [])
  assert.deepEqual(apiChanges(base, added).minor, ['API file: operation GET /sets/{set}/stats (getSetStats) added'])

  const removed = loadApiFile()
  delete removed.paths['/apps']
  assert.deepEqual(apiChanges(base, removed).major, ['API file: operation GET /apps removed'])

  const field = loadApiFile()
  const [name, schema] = Object.entries(field.components.schemas).find(([, s]) => Object.keys(s.properties || {}).length)
  const gone = Object.keys(schema.properties)[0]
  delete schema.properties[gone]
  assert.ok(apiChanges(base, field).major.includes(`API file: ${name}.${gone} removed`))

  const required = loadApiFile()
  const collect = required.components.schemas.CollectRequest
  const optional = Object.keys(collect.properties).find((f) => !(collect.required || []).includes(f))
  collect.required = [...(collect.required || []), optional]
  assert.ok(apiChanges(base, required).major.includes(`API file: CollectRequest.${optional} is now required in a request`))
})

test('changelog: versions by the rule, and the entry check', () => {
  assert.equal(bump('0.1.0', 'patch'), '0.1.1')
  assert.equal(bump('0.1.3', 'minor'), '0.2.0')
  assert.equal(bump('0.4.2', 'major'), '1.0.0')
  assert.equal(bump('1.2.3', 'major'), '2.0.0')
  assert.ok(hasEntry('# Changelog\n\n## 0.1.0\n\nFirst.\n', '0.1.0'))
  assert.ok(!hasEntry('# Changelog\n\n## 0.1.0\n\nFirst.\n', '0.1.1'))
  assert.ok(!hasEntry('## 0.1.01\n', '0.1.0'))
})

test('changelog: the next entry from commits since the tag, written and checked', (t) => {
  const dir = tempDir(t)
  const pkg = packageCopy(dir, ['package.json', 'CHANGELOG.md', 'scripts/changelog.mjs', 'src/openapi.js', API])
  const run = (...a) => {
    const r = spawnSync(process.execPath, [join(pkg, 'scripts', 'changelog.mjs'), ...a], { env: GIT_ENV, encoding: 'utf8' })
    return { code: r.status, out: r.stdout + r.stderr }
  }
  git(pkg, 'init', '-q', '-b', 'main')
  git(pkg, 'add', '-A')
  git(pkg, 'commit', '-q', '-m', '@pincast/api 0.1.0: a typed client')
  assert.equal(run('--check').code, 0)
  assert.match(run().out, /Suggested version: 0\.1\.0 \(the first release/)
  git(pkg, 'tag', '-a', 'v0.1.0', '-m', 'v0.1.0')
  assert.match(run().out, /Nothing to release since v0\.1\.0/)

  writeFileSync(join(pkg, 'a.txt'), '1')
  git(pkg, 'add', 'a.txt')
  git(pkg, 'commit', '-q', '-m', 'fix: keep the Idempotency-Key on a 503')
  git(pkg, 'commit', '-q', '--allow-empty', '-m', 'docs: a better example')
  let r = run()
  assert.match(r.out, /Suggested version: 0\.1\.1 \(patch after 0\.1\.0\)/)
  assert.match(r.out, /### Fixed\n\n- Keep the Idempotency-Key on a 503/)
  assert.doesNotMatch(r.out, /better example/)

  const doc = JSON.parse(readFileSync(join(pkg, API), 'utf8'))
  doc.paths['/sets/{set}/stats'] = { get: { operationId: 'getSetStats', responses: {} } }
  writeFileSync(join(pkg, API), JSON.stringify(doc, null, 2))
  git(pkg, 'commit', '-q', '-am', 'sync: the API file from NYID')
  r = run()
  assert.match(r.out, /Suggested version: 0\.2\.0 \(minor after 0\.1\.0\)/)
  assert.match(r.out, /minor: API file: operation GET \/sets\/\{set\}\/stats \(getSetStats\) added/)

  assert.equal(run('--write').code, 0)
  const changelog = readFileSync(join(pkg, 'CHANGELOG.md'), 'utf8')
  assert.ok(changelog.indexOf('## 0.2.0') < changelog.indexOf('## 0.1.0'), 'newest first')
  assert.ok(changelog.startsWith('# Changelog\n'))
  assert.equal(JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version, '0.2.0')
  assert.equal(run('--check').code, 0)
  assert.equal(run('--write').code, 1, 'the entry is there already')

  const pkgJson = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'))
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ ...pkgJson, version: '0.2.1' }, null, 2))
  assert.equal(run('--check').code, 1, 'a version with no entry')
  git(pkg, 'commit', '-q', '-am', 'feat!: drop getApps')
  assert.match(run().out, /Suggested version: 1\.0\.0 \(major after 0\.1\.0\)/)
})
