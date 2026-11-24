#!/usr/bin/env node
// Writes the next CHANGELOG.md entry from the commits since the last release tag (v<version>),
// and suggests the version by the rule in the README (Versions).
//
//   node scripts/changelog.mjs                     print the next entry and the suggested version
//   node scripts/changelog.mjs --write             add the entry to CHANGELOG.md and set package.json's version
//   node scripts/changelog.mjs --write --version 0.3.0   the same, with the version you choose
//   node scripts/changelog.mjs --check             exit 1 unless CHANGELOG.md has an entry for package.json's version
//
// Commit subjects are read conventional-ish:
//   feat: or add:          Added (minor)
//   fix:                   Fixed (patch)
//   type!: or a body line starting BREAKING CHANGE: or BREAKING:   Breaking (major)
//   docs, test, ci, chore, build, style, refactor, and release commits   left out
//   anything else          Changed (patch), the subject as written
// The API file is compared with the last tag's copy too. An operation, schema or field added is minor.
// An operation, named schema or field removed, or a field changed in type, is major. In a schema a
// request body reaches, a field newly required or narrowed (a value gone from an enum, a tighter limit
// or pattern, no extra fields) is major too. It reads operations and the top-level fields of named
// schemas only, so read the API file's diff for the rest. The entry is a draft: edit each line so a
// reader of the package knows what changed for them.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { listOperations, resolve as follow } from '../src/openapi.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const API = 'openapi/placecard-v1.openapi.json'
const LEVELS = ['none', 'patch', 'minor', 'major']
const LEFT_OUT = new Set(['docs', 'doc', 'test', 'tests', 'ci', 'chore', 'build', 'style', 'refactor', 'release'])

const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).toString()

// One commit subject (and body) to its group, or null when it stays out of the changelog.
export function classify(subject, body = '') {
  if (/^(release\b|v?\d+\.\d+\.\d+\b|@pincast\/api \d)/i.test(subject)) return null
  const m = /^([a-z]+)(\([^)]*\))?(!)?:\s*(.+)$/i.exec(subject)
  const breaking = Boolean(m?.[3]) || /^BREAKING( CHANGE)?:/m.test(body)
  const type = m?.[1].toLowerCase()
  const text = upper(m ? m[4] : subject)
  if (breaking) return { group: 'Breaking', text }
  if (type && LEFT_OUT.has(type)) return null
  if (type === 'feat' || type === 'add') return { group: 'Added', text }
  if (type === 'fix') return { group: 'Fixed', text }
  return { group: 'Changed', text: m && !['change', 'perf', 'revert'].includes(type) ? upper(subject) : text }
}

const GROUP_LEVEL = { Breaking: 'major', Added: 'minor', Fixed: 'patch', Changed: 'patch' }

// What changed between two copies of the API file, as { major: [...], minor: [...] } reasons.
export function apiChanges(before, after) {
  const major = []
  const minor = []
  const ops = (doc) => new Map(listOperations(doc).map((o) => [`${o.method} ${o.path}`, o]))
  const a = ops(before)
  const b = ops(after)
  for (const k of a.keys()) if (!b.has(k)) major.push(`API file: operation ${k} removed`)
  for (const [k, o] of b) if (!a.has(k)) minor.push(`API file: operation ${k} (${o.id}) added`)

  const inRequests = requestSchemas(after)
  const schemasA = before.components?.schemas || {}
  const schemasB = after.components?.schemas || {}
  for (const [name, sa] of Object.entries(schemasA)) {
    const sb = schemasB[name]
    if (!sb) { major.push(`API file: schema ${name} removed`); continue }
    const pa = sa.properties || {}
    const pb = sb.properties || {}
    for (const field of Object.keys(pa)) {
      if (!(field in pb)) { major.push(`API file: ${name}.${field} removed`); continue }
      for (const why of narrowed(follow(before, pa[field]), follow(after, pb[field]), inRequests.has(name))) major.push(`API file: ${name}.${field} ${why}`)
    }
    for (const field of Object.keys(pb)) if (!(field in pa)) minor.push(`API file: ${name}.${field} added`)
    if (inRequests.has(name)) {
      const ra = new Set(sa.required || [])
      for (const field of sb.required || []) if (!ra.has(field)) major.push(`API file: ${name}.${field} is now required in a request`)
    }
    for (const why of narrowed(sa, sb, inRequests.has(name))) major.push(`API file: ${name} ${why}`)
  }
  for (const name of Object.keys(schemasB)) if (!(name in schemasA)) minor.push(`API file: schema ${name} added`)
  return { major, minor }
}

// The ways one schema node changed for a caller: its type always, and in a request body also its
// enum, its limits, its pattern and extra fields, where accepting less breaks a caller.
function narrowed(a, b, request) {
  const out = []
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return out
  const t = (s) => [].concat(s.type ?? []).sort().join('|')
  if (t(a) !== t(b)) out.push(`changed type from ${t(a) || 'any'} to ${t(b) || 'any'}`)
  if (!request) return out
  if (Array.isArray(a.enum)) {
    const gone = Array.isArray(b.enum) ? a.enum.filter((v) => !b.enum.includes(v)) : []
    if (gone.length) out.push(`lost the value${gone.length > 1 ? 's' : ''} ${gone.map((v) => JSON.stringify(v)).join(', ')}`)
  } else if (Array.isArray(b.enum)) out.push('now takes only listed values')
  for (const k of ['maxLength', 'maxItems', 'maximum', 'exclusiveMaximum', 'maxProperties']) {
    if (b[k] !== undefined && (a[k] === undefined || b[k] < a[k])) out.push(`${k} narrowed from ${a[k] ?? 'none'} to ${b[k]}`)
  }
  for (const k of ['minLength', 'minItems', 'minimum', 'exclusiveMinimum', 'minProperties']) {
    if (b[k] !== undefined && (a[k] === undefined || b[k] > a[k])) out.push(`${k} narrowed from ${a[k] ?? 'none'} to ${b[k]}`)
  }
  if (b.pattern !== undefined && b.pattern !== a.pattern) out.push(`pattern changed to ${b.pattern}`)
  if (a.additionalProperties !== false && b.additionalProperties === false) out.push('no longer takes extra fields')
  return out
}

// The named schemas a request body reaches, through $refs, allOf, oneOf, anyOf, items and properties.
function requestSchemas(doc) {
  const names = new Set()
  const seen = new Set()
  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return
    seen.add(node)
    if (typeof node.$ref === 'string') {
      const m = /^#\/components\/schemas\/(.+)$/.exec(node.$ref)
      if (m) names.add(m[1])
      return walk(follow(doc, node))
    }
    for (const v of Object.values(node)) walk(v)
  }
  for (const o of listOperations(doc)) for (const media of Object.values(o.body?.content || {})) walk(media.schema)
  return names
}

// Capitalizes a plain first word, and leaves one that reads as code (getSetStats(), npm) alone.
function upper(s) {
  const word = /^\S+/.exec(s)?.[0] || ''
  return /^[a-z]+[,.:;]?$/.test(word) && !CODE_WORDS.has(word) ? s.charAt(0).toUpperCase() + s.slice(1) : s
}
const CODE_WORDS = new Set(['npm', 'node', 'git'])

export function bump(version, level) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!m) throw new Error(`${version} is not a plain x.y.z version: pass --version`)
  const [x, y, z] = m.slice(1).map(Number)
  if (level === 'major') return `${x + 1}.0.0`
  if (level === 'minor') return `${x}.${y + 1}.0`
  return `${x}.${y}.${z + 1}`
}

export function hasEntry(changelog, version) {
  return new RegExp(`^## \\[?${version.replace(/\./g, '\\.')}\\]?(\\s|$)`, 'm').test(changelog)
}

function lastTag() {
  try { return git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*').trim() } catch { return null }
}

function commitsSince(tag) {
  let out
  try { out = git('log', '--no-merges', '--format=%s%x1f%b%x1e', tag ? `${tag}..HEAD` : 'HEAD') } catch { return [] }
  return out.split('\x1e').map((r) => r.trim()).filter(Boolean).map((r) => {
    const [subject, body = ''] = r.split('\x1f')
    return { subject: subject.trim(), body }
  })
}

export function nextEntry() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const tag = lastTag()
  const groups = { Breaking: [], Added: [], Fixed: [], Changed: [] }
  let level = 'none'
  const raise = (l) => { if (LEVELS.indexOf(l) > LEVELS.indexOf(level)) level = l }
  for (const c of commitsSince(tag)) {
    const got = classify(c.subject, c.body)
    if (!got) continue
    groups[got.group].push(got.text)
    raise(GROUP_LEVEL[got.group])
  }
  const reasons = []
  if (tag) {
    let before = null
    try { before = JSON.parse(git('show', `${tag}:${API}`)) } catch { /* the tag has no API file */ }
    if (before && existsSync(join(ROOT, API))) {
      const { major, minor } = apiChanges(before, JSON.parse(readFileSync(join(ROOT, API), 'utf8')))
      for (const r of major) { groups.Breaking.push(r); reasons.push(`major: ${r}`); raise('major') }
      for (const r of minor) { groups.Added.push(r); reasons.push(`minor: ${r}`); raise('minor') }
    }
  }
  const base = tag ? tag.replace(/^v/, '') : null
  const version = !tag ? pkg.version : level === 'none' ? null : bump(base, level)
  const lines = []
  for (const [group, items] of Object.entries(groups)) {
    if (!items.length) continue
    lines.push(`### ${group}`, '', ...[...new Set(items)].map((t) => `- ${t}`), '')
  }
  return { tag, base, level, version, reasons, body: lines.join('\n') }
}

function main(args) {
  const valueOf = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1] }
  const known = new Set(['--write', '--check', '--version'])
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--version') { i++; continue }
    if (!known.has(args[i])) { console.error(`unknown option ${args[i]}`); return 2 }
  }
  const changelogPath = join(ROOT, 'CHANGELOG.md')
  const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : ''

  if (args.includes('--check')) {
    const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    if (hasEntry(changelog, version)) { console.log(`OK: CHANGELOG.md has an entry for ${version}.`); return 0 }
    console.error(`CHANGELOG.md has no "## ${version}" entry for package.json's version: run npm run changelog`)
    return 1
  }

  const next = nextEntry()
  const version = valueOf('--version') ?? next.version
  if (args.includes('--version') && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version || '')) { console.error('--version needs x.y.z'); return 2 }
  const since = next.tag ? `since ${next.tag}` : 'with no release tag yet'
  if (!version) { console.log(`Nothing to release ${since}: every commit is left out (docs, tests, CI, chores).`); return args.includes('--write') ? 1 : 0 }
  const entry = `## ${version}\n\n${next.body || '- (no listed changes: say what this release is for)\n'}`.trimEnd() + '\n'

  if (!args.includes('--write')) {
    console.log(`Suggested version: ${version} (${next.tag ? `${next.level} after ${next.base}` : 'the first release: package.json\'s version'}), ${since}.`)
    for (const r of next.reasons) console.log(`  ${r}`)
    if (hasEntry(changelog, version)) console.log(`CHANGELOG.md already has an entry for ${version}.`)
    console.log('')
    console.log(entry)
    return 0
  }
  if (hasEntry(changelog, version)) { console.error(`CHANGELOG.md already has an entry for ${version}`); return 1 }
  const at = changelog.search(/^## /m)
  const head = changelog ? (at === -1 ? changelog.trimEnd() + '\n\n' : changelog.slice(0, at)) : '# Changelog\n\n'
  const rest = at === -1 ? '' : changelog.slice(at)
  writeFileSync(changelogPath, `${head}${entry}${rest ? '\n' + rest : ''}`)
  const pkgPath = join(ROOT, 'package.json')
  const pkgText = readFileSync(pkgPath, 'utf8')
  writeFileSync(pkgPath, pkgText.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`))
  console.log(`Wrote the ${version} entry to CHANGELOG.md and set package.json's version to ${version}. Edit the entry, then commit.`)
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exit(main(process.argv.slice(2)))
