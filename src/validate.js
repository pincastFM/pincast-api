// A small JSON Schema check (draft 2020-12, the parts the API file uses). The mock uses it to hold
// requests and its own answers to the API file. Returns a list of problems, each { path, keyword,
// message }; an empty list means the value fits.
import { resolve } from './openapi.js'

export function validate(schema, value, doc, path = '') {
  const out = []
  check(schema, value, doc, path, out)
  return out
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function typeOf(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (Number.isInteger(v)) return 'integer'
  return typeof v
}

const fits = (t, v) => t === typeOf(v) || (t === 'number' && typeOf(v) === 'integer')
const at = (path, key) => (typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key)

function check(schema, v, doc, path, out) {
  if (schema === true || schema == null) return
  if (schema === false) return void out.push({ path, keyword: 'false', message: 'not allowed' })
  const add = (keyword, message) => out.push({ path, keyword, message })
  if (schema.$ref) check(resolve(doc, schema), v, doc, path, out)

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((t) => fits(t, v))) return add('type', `must be ${types.join(' or ')}`)
  }
  if ('const' in schema && !same(schema.const, v)) add('const', `must be ${JSON.stringify(schema.const)}`)
  if (schema.enum && !schema.enum.some((e) => same(e, v))) add('enum', `must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`)
  if (schema.oneOf) {
    const n = schema.oneOf.filter((s) => validate(s, v, doc, path).length === 0).length
    if (n !== 1) add('oneOf', n ? 'fits more than one choice' : 'fits none of the choices')
  }

  if (typeof v === 'string') {
    const length = [...v].length
    if (schema.minLength !== undefined && length < schema.minLength) add('minLength', `must be at least ${schema.minLength} characters`)
    if (schema.maxLength !== undefined && length > schema.maxLength) add('maxLength', `must be at most ${schema.maxLength} characters`)
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(v)) add('pattern', `must match ${schema.pattern}`)
    if (schema.format === 'date-time' && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(v) || Number.isNaN(Date.parse(v)))) add('format', 'must be a date-time')
  }
  if (typeof v === 'number') {
    if (schema.minimum !== undefined && v < schema.minimum) add('minimum', `must be ${schema.minimum} or more`)
    if (schema.maximum !== undefined && v > schema.maximum) add('maximum', `must be ${schema.maximum} or less`)
  }
  if (Array.isArray(v)) {
    if (schema.minItems !== undefined && v.length < schema.minItems) add('minItems', `must hold at least ${schema.minItems}`)
    if (schema.maxItems !== undefined && v.length > schema.maxItems) add('maxItems', `must hold at most ${schema.maxItems}`)
    if (schema.items) v.forEach((item, i) => check(schema.items, item, doc, at(path, i), out))
  }
  if (typeOf(v) === 'object') {
    for (const name of schema.required || []) {
      if (!(name in v)) out.push({ path: at(path, name), keyword: 'required', message: 'is required' })
    }
    const props = schema.properties || {}
    for (const [name, value] of Object.entries(v)) {
      if (schema.propertyNames) check(schema.propertyNames, name, doc, at(path, name), out)
      if (name in props) check(props[name], value, doc, at(path, name), out)
      else if (schema.additionalProperties === false) out.push({ path: at(path, name), keyword: 'additionalProperties', message: 'is not a field here' })
      else if (schema.additionalProperties && schema.additionalProperties !== true) check(schema.additionalProperties, value, doc, at(path, name), out)
    }
    for (const [name, needs] of Object.entries(schema.dependentRequired || {})) {
      if (name in v) for (const other of needs) if (!(other in v)) out.push({ path: at(path, other), keyword: 'required', message: `is required with ${name}` })
    }
  }
}
