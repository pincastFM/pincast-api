// Reading the API file: local $refs and the list of operations. Used by the mock and by
// scripts/generate.mjs, so both read the file the same way.
const METHODS = ['get', 'put', 'post', 'patch', 'delete']

// Follows a local $ref (#/components/...) to the node it names.
export function resolve(doc, node) {
  while (node && typeof node === 'object' && typeof node.$ref === 'string') {
    node = node.$ref.slice(2).split('/')
      .reduce((o, k) => o?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], doc)
  }
  return node
}

// Every operation in the file, in file order, with its parameters and request body resolved.
export function listOperations(doc) {
  const out = []
  for (const [path, item] of Object.entries(doc.paths || {})) {
    for (const method of METHODS) {
      const op = item[method]
      if (!op) continue
      const params = [...(item.parameters || []), ...(op.parameters || [])].map((p) => resolve(doc, p))
      const security = op.security ?? doc.security ?? []
      const body = op.requestBody ? resolve(doc, op.requestBody) : null
      out.push({ id: op.operationId, method: method.toUpperCase(), path, op, params, security, body })
    }
  }
  return out
}
