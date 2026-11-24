#!/usr/bin/env node
// Compares the package's API file with NYID's at origin/main, and copies NYID's over it when they differ.
// NYID holds the routes, so its docs/api/placecard-v1.openapi.json is the source; this package keeps a byte copy.
//
//   node scripts/sync-openapi.mjs                fetch NYID origin/main, compare, copy when they differ
//   NO_FETCH=1 node scripts/sync-openapi.mjs     skip the fetch (use the origin/main NYID already has)
//   node scripts/sync-openapi.mjs --check        compare only, change nothing
//   NYID_REPO=/path/to/NYID node scripts/...     NYID somewhere other than ../NYID
//
// It only reads NYID: git fetch (unless NO_FETCH=1), git rev-parse and git show origin/main:<file>.
//
// Exit 0: the package's copy matches NYID origin/main.
// Exit 1: they differ. Without --check, the copy now matches NYID: run npm run generate, then
//         npm run check and npm test, add a CHANGELOG entry, and commit.
// Exit 2: NYID, its origin/main or the file there could not be read.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listOperations } from '../src/openapi.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = 'docs/api/placecard-v1.openapi.json'
const DST = 'openapi/placecard-v1.openapi.json'

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const unknown = args.filter((a) => a !== '--check')
if (unknown.length) cannot(`unknown option ${unknown.join(' ')} (the only option is --check)`)

const nyid = resolve(process.env.NYID_REPO || join(ROOT, '..', 'NYID'))
if (!existsSync(join(nyid, '.git'))) cannot(`NYID repo not found at ${nyid} (set NYID_REPO)`)

const git = (...a) => execFileSync('git', ['-C', nyid, ...a], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })

if (process.env.NO_FETCH !== '1') {
  try { git('fetch', '-q', 'origin', 'main') } catch { cannot(`git fetch of origin main failed in ${nyid} (NO_FETCH=1 uses the origin/main it has)`) }
}

let rev
try { rev = git('rev-parse', '--short', 'origin/main^{commit}').toString().trim() } catch {
  cannot(`NYID at ${nyid} has no origin/main (fetch it, or in CI check out NYID's main branch)`)
}

let theirs
try { theirs = git('show', `origin/main:${SRC}`) } catch { cannot(`could not read ${SRC} at NYID origin/main ${rev}`) }
const theirDoc = parse(theirs)
if (!theirDoc?.openapi || !theirDoc.paths) cannot(`${SRC} at NYID origin/main ${rev} is not an OpenAPI file`)

const dstPath = join(ROOT, DST)
const ours = existsSync(dstPath) ? readFileSync(dstPath) : null
const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 12)

if (ours && ours.equals(theirs)) {
  console.log(`OK: ${DST} matches NYID origin/main ${rev} (sha256 ${sha(theirs)}).`)
  process.exit(0)
}

console.log(ours
  ? `CHANGED: ${DST} (sha256 ${sha(ours)}) differs from NYID origin/main ${rev} (sha256 ${sha(theirs)}).`
  : `NEW: ${DST} is missing; NYID origin/main ${rev} has it (sha256 ${sha(theirs)}).`)
const opsOf = (doc) => new Map(doc ? listOperations(doc).map((o) => [`${o.method} ${o.path}`, o.id]) : [])
const before = opsOf(ours && parse(ours))
const after = opsOf(theirDoc)
const added = [...after].filter(([k]) => !before.has(k))
const removed = [...before].filter(([k]) => !after.has(k))
for (const [k, id] of added) console.log(`  operation added in NYID: ${k} (${id})`)
for (const [k, id] of removed) console.log(`  operation removed in NYID: ${k} (${id})`)
if (!added.length && !removed.length) console.log(`  the same ${after.size} operations; the change is in their details, schemas or text`)

if (checkOnly) {
  console.log('Nothing was changed (--check). To bring it in: node scripts/sync-openapi.mjs, then npm run generate, npm run check and npm test.')
} else {
  writeFileSync(dstPath, theirs)
  console.log(`Copied NYID's file over ${DST}. Next:`)
  console.log('  1. npm run generate        writes the types and the operation table again')
  console.log('  2. npm run check           fails if the client lacks an operation the file has')
  console.log('  3. npm test')
  console.log('  4. git diff openapi/ src/generated/, then npm run changelog for the next CHANGELOG entry, and commit')
}
process.exit(1)

function parse(buf) {
  try { return JSON.parse(buf.toString('utf8')) } catch { return null }
}

function cannot(message) {
  console.error(message)
  process.exit(2)
}
